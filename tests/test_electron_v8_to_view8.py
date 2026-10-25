import importlib.util
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "tools" / "electron_v8_to_view8.py"
SPEC = importlib.util.spec_from_file_location("electron_v8_to_view8", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class ElectronV8ToView8Test(unittest.TestCase):
    def test_converts_one_function_without_evaluating_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            disassembly = root / "function.txt"
            constants = root / "constants.txt"
            disassembly.write_text(
                """%GetBytecode:
Parameter count 1
Register count 1
Frame size 8
 10 S> 0x1234 @    0 : 13 00             LdaConstant [0:\"ok\"]
         0x1236 @    2 : b9                Return
Constant pool (size = 1)
""",
                encoding="utf-8",
            )
            constants.write_text(
                """CONSTANT_POOL_SIZE:1
CONSTANT_INDEX:0
0x1 <String[2]: #ok>
""",
                encoding="utf-8",
            )
            output: list[str] = []
            MODULE.write_function(output, "probe", 0xE10001, disassembly, constants)

        rendered = "\n".join(output)
        self.assertIn("0xe10001: [SharedFunctionInfo]", rendered)
        self.assertIn("LdaConstant [0:\"ok\"]", rendered)
        self.assertIn("0: 0x1 <String[2]: #ok>", rendered)
        self.assertIn("Handler Table (size = 0)", rendered)

    def test_parses_generic_extractor_marker_trace(self):
        trace = """\
@@JSC2JS_FUNCTION_BEGIN {"key":"1-exports.run","label":"sample:exports.run"}
%GetBytecode:
Parameter count 1
Register count 0
    0 S> 0x1234 @    0 : 0e                LdaUndefined
    1 S> 0x1235 @    1 : b9                Return
@@JSC2JS_FUNCTION_END {"key":"1-exports.run","status":"ok"}
@@JSC2JS_CONSTANTS_BEGIN {"key":"1-exports.run","count":1}
@@JSC2JS_CONSTANT_INDEX {"key":"1-exports.run","index":0}
0x1 <String[2]: #ok>
@@JSC2JS_CONSTANTS_END {"key":"1-exports.run"}
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trace.txt"
            path.write_text(trace, encoding="utf-8")
            functions = MODULE.parse_marker_trace(path)

        self.assertEqual(1, len(functions))
        label, disassembly, constants = functions[0]
        self.assertEqual("sample:exports.run", label)
        self.assertIn("Parameter count 1", disassembly)
        self.assertEqual(["0x1 <String[2]: #ok>"], constants)


if __name__ == "__main__":
    unittest.main()
