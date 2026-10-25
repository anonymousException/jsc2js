"""Convert Electron `%GetBytecode` text into View8's SFI dump dialect.

Electron 42+ caches carry embedder-specific heap roots that a standalone d8
cannot always deserialize safely.  Its matching Electron runtime can still
expose a materialized function through `%GetBytecode`; this adapter joins that
disassembly with one-at-a-time `%DebugPrint` constant-pool output so View8 can
continue with its normal translation/decompilation pipeline.

The adapter intentionally accepts text files only.  It neither evaluates a
cache nor launches Electron, which keeps the data-conversion stage read-only.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


BYTECODE_LINE = re.compile(r"\s@\s+\d+\s*:\s+[0-9a-fA-F ]+\s+")
PARAMETER_COUNT = re.compile(r"^Parameter count\s+(\d+)$")
REGISTER_COUNT = re.compile(r"^Register count\s+(\d+)$")
POOL_SIZE = re.compile(r"^CONSTANT_POOL_SIZE:(\d+)$")
POOL_INDEX = re.compile(r"^CONSTANT_INDEX:(\d+)(?::POOL_SIZE:\d+)?$")


def _lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8", errors="replace").splitlines()


def parse_disassembly_lines(
    lines: list[str], identifier: str
) -> tuple[int, int, list[str]]:
    """Return parameter count, register count, and raw V8 instruction lines."""
    parameters: int | None = None
    registers: int | None = None
    instructions: list[str] = []

    for raw in lines:
        line = raw.rstrip()
        match = PARAMETER_COUNT.match(line)
        if match:
            parameters = int(match.group(1))
            continue
        match = REGISTER_COUNT.match(line)
        if match:
            registers = int(match.group(1))
            continue
        if BYTECODE_LINE.search(line):
            instructions.append(line)

    if parameters is None or registers is None or not instructions:
        raise ValueError(
            f"{identifier} is not a single-function %GetBytecode disassembly "
            "(parameter/register count or instructions missing)"
        )
    return parameters, registers, instructions


def parse_disassembly(path: Path) -> tuple[int, int, list[str]]:
    return parse_disassembly_lines(_lines(path), str(path))


def parse_constants(path: Path) -> list[str]:
    """Read a `electron_debug_constant.cjs ... all` transcript."""
    size: int | None = None
    values: dict[int, str] = {}
    lines = _lines(path)
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        match = POOL_SIZE.match(line)
        if match:
            size = int(match.group(1))
            index += 1
            continue
        match = POOL_INDEX.match(line)
        if not match:
            index += 1
            continue
        constant_index = int(match.group(1))
        index += 1
        while index < len(lines) and not lines[index].strip():
            index += 1
        if index >= len(lines):
            raise ValueError(f"missing value for constant {constant_index} in {path}")
        values[constant_index] = lines[index].strip()
        index += 1

    if size is None:
        raise ValueError(f"{path} has no CONSTANT_POOL_SIZE line")
    missing = [str(i) for i in range(size) if i not in values]
    if missing:
        raise ValueError(f"{path} has missing constant values: {', '.join(missing)}")
    return [values[i] for i in range(size)]


def parse_marker_trace(path: Path) -> list[tuple[str, list[str], list[str]]]:
    """Return (label, disassembly_lines, constants) from extractor stdout."""
    lines = _lines(path)
    functions: list[tuple[str, list[str], list[str]]] = []
    index = 0
    begin_prefix = "@@JSC2JS_FUNCTION_BEGIN "
    end_prefix = "@@JSC2JS_FUNCTION_END "
    constants_begin_prefix = "@@JSC2JS_CONSTANTS_BEGIN "
    constants_end_prefix = "@@JSC2JS_CONSTANTS_END "
    constant_index_prefix = "@@JSC2JS_CONSTANT_INDEX "

    while index < len(lines):
        raw = lines[index]
        if not raw.startswith(begin_prefix):
            index += 1
            continue
        metadata = json.loads(raw[len(begin_prefix):])
        key = str(metadata["key"])
        label = str(metadata.get("label", key))
        index += 1
        disassembly: list[str] = []
        while index < len(lines) and not lines[index].startswith(end_prefix):
            disassembly.append(lines[index])
            index += 1
        if index >= len(lines):
            raise ValueError(f"unterminated function marker {key} in {path}")
        end = json.loads(lines[index][len(end_prefix):])
        index += 1
        if end.get("key") != key:
            raise ValueError(f"mismatched function marker {key} in {path}")
        if end.get("status") != "ok":
            continue
        # Electron's --print-bytecode printer can emit lazy compilation of
        # unrelated Node/bootstrap functions while %GetBytecode is running.
        # The intrinsic's requested function is the final explicitly headed
        # `%GetBytecode:` block before our matching end marker.  Retaining the
        # preceding noise mixes unrelated instruction streams into View8.
        markers = [
            position for position, line in enumerate(disassembly)
            if line.strip() == "%GetBytecode:"
        ]
        if not markers:
            raise ValueError(f"function marker {key} has no %GetBytecode block in {path}")
        disassembly = disassembly[markers[-1]:]
        if index >= len(lines) or not lines[index].startswith(constants_begin_prefix):
            raise ValueError(f"missing constant-pool marker for {key} in {path}")
        pool_meta = json.loads(lines[index][len(constants_begin_prefix):])
        if pool_meta.get("key") != key:
            raise ValueError(f"mismatched constant-pool marker {key} in {path}")
        count = int(pool_meta["count"])
        index += 1
        constants: list[str | None] = [None] * count
        while index < len(lines) and not lines[index].startswith(constants_end_prefix):
            marker = lines[index]
            if not marker.startswith(constant_index_prefix):
                index += 1
                continue
            item = json.loads(marker[len(constant_index_prefix):])
            if item.get("key") != key:
                raise ValueError(f"mismatched constant index marker {key} in {path}")
            constant_index = int(item["index"])
            index += 1
            value_lines: list[str] = []
            while index < len(lines):
                candidate = lines[index]
                if candidate.startswith(constant_index_prefix) or candidate.startswith(constants_end_prefix):
                    break
                if candidate.strip():
                    value_lines.append(candidate.strip())
                index += 1
            if not 0 <= constant_index < count:
                raise ValueError(f"constant index {constant_index} out of range for {key}")
            if not value_lines:
                raise ValueError(f"constant index {constant_index} lacks output for {key}")
            constants[constant_index] = value_lines[0]
        if index >= len(lines):
            raise ValueError(f"unterminated constant-pool marker {key} in {path}")
        end_pool = json.loads(lines[index][len(constants_end_prefix):])
        index += 1
        if end_pool.get("key") != key:
            raise ValueError(f"mismatched constant-pool end marker {key} in {path}")
        missing = [str(i) for i, value in enumerate(constants) if value is None]
        if missing:
            raise ValueError(f"missing constants for {key}: {', '.join(missing)}")
        functions.append((label, disassembly, [str(value) for value in constants]))
    if not functions:
        raise ValueError(f"no successful extractor function markers in {path}")
    return functions


def write_function_parts(
    output: list[str],
    name: str,
    address: int,
    parameters: int,
    registers: int,
    instructions: list[str],
    constants: list[str],
) -> None:
    output.extend(
        (
            "Start SharedFunctionInfo",
            f"0x{address:x}: [SharedFunctionInfo] in ElectronRuntime",
            f" - name: {name}",
            f"Parameter count {parameters}",
            f"Register count {registers}",
        )
    )
    output.extend(instructions)
    output.append(f"Constant pool (size = {len(constants)})")
    for index, value in enumerate(constants):
        output.append(f"{index}: {value}")
    # `%GetBytecode` currently does not expose handler ranges.  Keeping this
    # conservative empty table is preferable to inventing exception edges.
    output.extend(("Handler Table (size = 0)", "End SharedFunctionInfo", ""))


def write_function(
    output: list[str],
    name: str,
    address: int,
    disassembly_path: Path,
    constants_path: Path,
) -> None:
    parameters, registers, instructions = parse_disassembly(disassembly_path)
    constants = parse_constants(constants_path)
    write_function_parts(
        output, name, address, parameters, registers, instructions, constants
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--function",
        action="append",
        nargs=3,
        metavar=("NAME", "DISASSEMBLY", "CONSTANTS"),
        help="one Electron function dump and its matching constant-pool transcript",
    )
    parser.add_argument(
        "--trace",
        type=Path,
        help="stdout marker trace emitted by electron_v8_extract.cjs",
    )
    args = parser.parse_args()
    if bool(args.function) == bool(args.trace):
        parser.error("provide exactly one of --function or --trace")

    lines = ["# Generated from Electron V8 %GetBytecode; no cache executed here.", ""]
    if args.trace:
        trace_functions = parse_marker_trace(args.trace)
        for ordinal, (name, disassembly, constants) in enumerate(trace_functions, start=1):
            parameters, registers, instructions = parse_disassembly_lines(
                disassembly, f"{args.trace}:{name}"
            )
            write_function_parts(
                lines, name, 0xE10000 + ordinal, parameters, registers,
                instructions, constants
            )
        written = len(trace_functions)
    else:
        for ordinal, (name, disassembly, constants) in enumerate(args.function, start=1):
            write_function(
                lines,
                name,
                0xE10000 + ordinal,
                Path(disassembly),
                Path(constants),
            )
        written = len(args.function)
    args.output.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    print(f"Wrote {written} function(s) to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
