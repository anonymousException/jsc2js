# jsc2js

[简体中文](#jsc2js) | [English](#english)

---

## 项目简介

`jsc2js` 用于将v8生成的 **JSC 字节码**逆向为可读的 JavaScript。  
本仓库主要包含两部分：

1. **修补后的 d8**：针对多个 V8 版本（见 Releases），为其内置一个用于加载与打印 `.jsc` 字节码的扩展（新增/修改的内建入口：`loadjsc()`）。
2. **集成的 View8 工具 (基于 [suleram/View8](https://github.com/suleram/View8) 并作定制修改)**：用于把 d8 打印出的字节码文本再还原/重建为 JavaScript 近似源码。


---

## 快速开始

### 1. 获取对应版本 d8

前往 Releases 页面，选择与你的目标 `.jsc` 生成环境 **相同的 V8 版本号**。 （如果没有找到，请发起 Issue ） 

每个版本下提供：
- `d8-linux`：Linux 64-bit 可执行文件
- `d8-windows.exe`：Windows 64-bit 可执行文件

### 2. 将 `.jsc` 转成字节码文本

```bash
./d8 -e "loadjsc('path/to/xxx.jsc')" > xxx.txt
```

说明：
- `loadjsc()` 为修补后 d8 注入的辅助函数。
- 输出的 `xxx.txt` 为人类可读（但仍较底层）的 V8 Ignition Bytecode 反汇编格式。

### 3. 使用修改后的 View8 转成 JavaScript

仓库结构中已包含定制的 `View8/` 目录：

```bash
cd View8
python view8.py --disassembled ../xxx.txt ../xxx.js
```

执行后：
- `xxx.js` 为基于字节码分析还原的近似 JavaScript。  
  （变量名 / 控制流结构可能与原始源码不同，属于“语义近似重建”）

### 4. 依赖环境

View8 需要 Python 3.9+（建议）；当前解析器只使用标准库，无额外 Python 包依赖。

### Electron / Bytenode 运行时提取

对于由 Electron 生成、或模块初始化后会动态安装方法的 `.jsc`，使用目标
Electron 可执行文件运行 `tools/electron_v8_extract.cjs`：

```bash
ELECTRON_RUN_AS_NODE=1 <electron.exe> --allow-natives-syntax --print-bytecode \
  tools/electron_v8_extract.cjs --mode discover --trace-file recovered.trace.txt \
  --report recovered.json target.jsc
python tools/electron_v8_to_view8.py --trace recovered.trace.txt --output recovered.txt
python View8/view8.py --disassembled recovered.txt recovered.js
```

`discover` 只在隔离 VM 中、以惰性参数调用导出的同步工厂/安装器；除返回值闭包外，
它还会恢复安装器对这些参数（包括 `Engine.prototype` 形式的链式访问）直接赋值或
`Object.defineProperty` 新增的方法。`verify`、`root`、`module` 模式不会调用导出函数。

在 Windows GUI Electron 中，`--trace-file` 会把 V8 的原生字节码输出及标记写入同一文件。
该选项需要宿主能加载 Koffi；可用 `JSC2JS_KOFFI_PATH` 指定 Koffi 的安装目录。

### Renderer / Isolated World 提取

主进程与 renderer 的 V8 快照不同。同名类或模块在两个上下文中不是同一个运行时对象，
因此 renderer `.jsc` 必须在 renderer 快照中反序列化。使用一个独立 Electron 分析宿主，
并通过 `JSC2JS_RENDER_CONFIG` 传入 JSON 配置：

```json
{
  "files": ["C:\\target\\renderer-entry.jsc"],
  "report": "C:\\out\\renderer.json",
  "mode": "locals",
  "emit": "none",
  "timeoutMs": 30000,
  "closureDepth": 2
}
```

设置 `JSC2JS_RENDER_MODE=extract` 后启动该宿主。`root` 只导出包装器；`module` 在惰性
VM 中初始化 CommonJS 包装器；`discover` 还以惰性参数调用同步导出工厂/安装器；`locals`
使用 Electron DevTools Protocol 遍历同一隔离 VM 中的 `[[Scopes]]`，适合没有 CommonJS
导出、只把命名空间挂到 `window` / `globalThis` 的大型 bundle。报告会显式记录
`cacheSnapshot: "renderer"`、`executionContext` 与 `wrapperExecution`，以避免把 browser
和 renderer 的对象混为同一实例。

`locals` 的 JSON 结果还为每个已恢复函数提供 `bytecodeValues` 与轻量的
`constantPool` 摘要；这在 renderer 不把 V8 原生调试输出接到控制台时，仍可保存与
后续处理原始字节码。启用 `traceFile` 时，工具的标记会写入 renderer 的 CRT 输出流，
避免与可能存在的原生 V8 打印竞争文件偏移。

所有非 `root` 模式均复用主提取器的只读文件系统、惰性 `require`、惰性全局对象、无调度
计时器和无真实 Electron bridge；不会加载目标页面、调用产品 API 或写入目标目录。`
moduleInitialization: "interrupted"` 表示已保留初始化前完成物化的根，但自动工厂发现会被跳过。
`timeoutMs` 限制单个包装器/闭包操作；若需要调整整个隐藏 renderer 的总等待时间，使用独立的
`hostTimeoutMs`（默认 120000），不要把两者混用。

---

## 说明

- 当前补丁覆盖 V8 5.1 及之后版本。V8 5.1–11.9 与 14.7.84+ 使用按源码
  API 自动适配的安全补丁；V8 12.0–14.7.83 继续使用内容未改动的稳定补丁。
- V8 5.1 是当前 `.jsc` 路径的兼容下界：截至 V8 5.0 的版本缺少本工具所需的
  `CodeSerializer::Deserialize` 路径。V8 5.9 才默认全面启用 Ignition，因此
  5.1–5.8 仅适用于宿主实际生成了 Ignition bytecode 的缓存。
- 旧版兼容层为兼容同一 V8 发布线的不同宿主（例如 upstream d8 与
  Electron），跳过 version、source、flags 三个宿主相关哈希；上游该版本已有
  的缓存检查均原样保留：369 个 tag 都有 magic 与 checksum，358 个有 header、
  356 个有 payload 长度、45 个有 CPU feature、20 个有只读快照 checksum 检查。
  反序列化器的同步与边界检查也完全不改。369 个精确 tag 已通过 Linux 和
  Windows 双平台构建验证，Issue #23 对应版本也包含在回归测试中。
- 对 V8 14.7.84–15.3.25 的 57 个精确失败 tag，现代兼容层识别
  `OwnedVector`、`DirectHandleVector`、对象谓词生成、`TrustedFixedArray` 及其
  强类型长度，并识别出四种组合的 API 边界。它只跳过 source、version、flags、
  宿主特定的只读快照身份校验，并在私有内存副本中规范化包含外部引用表大小的
  magic；规范化前会检查 V8 magic 家族以及 header 声明的 payload 长度与文件
  边界完全一致。上游 magic 检查仍执行，同时保留 payload checksum 以及全部
  反序列化协议检查；嵌套函数通过去重的平面
  GC 强根工作队列打印，不再递归展开 `HeapObjectShortPrint`。这 57 个精确 tag
  已通过补丁重放以及 Linux 和 Windows 双平台构建验证。
- 不同 V8 版本的 Bytecode 指令集、寄存槽布局、Handlers 表结构可能不同，请务必使用 **匹配版本** 的 d8。
- 由于没有node环境，由node编译出来的jsc可能无法正常反编译，electron则正常
- 如果输出异常，请：
  1. 再次核对版本；
  2. 若仍有异常，请提起 Issue
  3. 或自行修改 View8 的指令映射表。
- 还原 JS 不能 100% 重建原始源码：
  - 变量/函数名可能匿名或被重写；
  - 控制流可能被结构化重排；
  - 常量折叠或运行时优化不会完整还原。
 
---

## 参考与致谢

- View8：
  - [suleram/View8](https://github.com/suleram/View8) （已在本仓库中集成修改）
- 博客与资料参考：
  - https://guage.cool/wiz-license.html
  - https://rce.moe/2025/01/07/v8-bytecode-decompiler/
- V8 官方项目与文档 (Chromium / v8.dev)


---

# English

[简体中文](#jsc2js) | [English](#english)

---

## Overview

`jsc2js` reverses **V8‑generated JSC bytecode** into readable (approximate) JavaScript.

The repository contains two major parts:

1. **Patched d8**: Multiple V8 versions (see Releases) with an added builtin helper `loadjsc()` that loads and prints `.jsc` bytecode.
2. **Integrated View8 tool (based on a customized fork of [suleram/View8](https://github.com/suleram/View8))**: Converts the textual bytecode dump emitted by d8 into an approximate JavaScript reconstruction.

---

## Quick Start

### 1. Get the matching d8

Go to the Releases page and choose the V8 version that is **identical to** the one that produced your target `.jsc`. (Open an Issue if the version you need is missing.)

Each release provides:
- `d8-linux`: Linux 64‑bit executable
- `d8-windows.exe`: Windows 64‑bit executable

### 2. Convert `.jsc` into a bytecode text listing

```bash
./d8 -e "loadjsc('path/to/xxx.jsc')" > xxx.txt
```

Notes:
- `loadjsc()` is the injected helper in the patched d8.
- `xxx.txt` is a human‑readable (though still low‑level) V8 Ignition bytecode disassembly.

### 3. Use the modified View8 to reconstruct JavaScript

A customized `View8/` directory is included:

```bash
cd View8
python view8.py --disassembled ../xxx.txt ../xxx.js
```

Result:
- `xxx.js` contains an approximate JavaScript reconstruction based on the bytecode analysis.  
  (Identifiers / control flow may differ from the original source; this is a semantic approximation.)

### 4. Requirements

View8 requires Python 3.9+ (recommended). Its current parser uses only the
standard library and has no additional Python package dependency.

### Electron / Bytenode runtime extraction

For Electron-generated `.jsc` files, including modules that install methods
dynamically during initialization, run `tools/electron_v8_extract.cjs` with the
target Electron executable:

```bash
ELECTRON_RUN_AS_NODE=1 <electron.exe> --allow-natives-syntax --print-bytecode \
  tools/electron_v8_extract.cjs --mode discover --trace-file recovered.trace.txt \
  --report recovered.json target.jsc
python tools/electron_v8_to_view8.py --trace recovered.trace.txt --output recovered.txt
python View8/view8.py --disassembled recovered.txt recovered.js
```

`discover` invokes synchronous exported factories/installers only in the
isolated VM with inert arguments. In addition to returned closures, it recovers
methods installed through direct assignment or `Object.defineProperty` on
those arguments, including chained forms such as `Engine.prototype`. `verify`,
`root`, and `module` never invoke exported functions.

On Windows GUI Electron hosts, `--trace-file` writes both V8's native bytecode
output and the extraction markers to one file. The host must be able to load
Koffi; set `JSC2JS_KOFFI_PATH` to a Koffi installation directory if needed.

### Renderer / isolated-world extraction

Browser and renderer V8 snapshots differ. A class or module with the same name
in both contexts is not the same runtime object, so renderer `.jsc` must be
deserialized in a renderer snapshot. Start a separate Electron analysis host
with `JSC2JS_RENDER_MODE=extract` and point `JSC2JS_RENDER_CONFIG` at a JSON
configuration such as:

```json
{
  "files": ["C:\\target\\renderer-entry.jsc"],
  "report": "C:\\out\\renderer.json",
  "mode": "locals",
  "emit": "none",
  "timeoutMs": 30000,
  "closureDepth": 2
}
```

`root` exports only the wrapper. `module` initializes the CommonJS wrapper in
an inert VM, and `discover` additionally invokes synchronous exported
factories/installers with inert arguments. `locals` uses the Electron DevTools
Protocol to walk `[[Scopes]]` in that same isolated VM; use it for large
bundles with no CommonJS exports that publish a namespace onto `window` or
`globalThis`. Reports explicitly include `cacheSnapshot: "renderer"`,
`executionContext`, and `wrapperExecution` so browser and renderer objects are
not conflated.

`locals` JSON additionally carries `bytecodeValues` and a lightweight
`constantPool` summary for every recovered function. That preserves raw
bytecode for later processing even when a renderer does not route V8 native
debug output to its console. With `traceFile`, tool markers use the renderer
CRT output stream, avoiding file-offset contention with any native V8 prints.

Every non-`root` mode reuses the main extractor's read-only filesystem, inert
`require`, inert globals, non-scheduling timers, and no real Electron bridge.
It never loads the target page, calls product APIs, or writes into the target
directory. `moduleInitialization: "interrupted"` preserves roots materialized
before a host-only initializer failed, while skipping automatic factory
discovery. `timeoutMs` bounds one wrapper/closure operation. Use the separate
`hostTimeoutMs` (default 120000) only when the overall hidden-renderer wait
needs adjustment.

---

## Notes

- The patch set covers V8 5.1 and later. V8 5.1–11.9 and 14.7.84+ use
  source-aware compatibility patchers; the stable V8 12.0–14.7.83 patch
  contents remain unchanged.
- V8 5.1 is the compatibility lower bound for this `.jsc` path. Releases
  through V8 5.0 lack the required `CodeSerializer::Deserialize` path.
  Ignition became universal by default in V8 5.9, so V8 5.1–5.8 applies only
  when the embedder actually emitted an Ignition bytecode cache.
- To support different embedders on the same V8 release line (for example,
  upstream d8 and Electron), the legacy compatibility layer bypasses the
  version, source, and flags hashes. Every cache check provided by that upstream
  V8 tag remains byte-for-byte in place: all 369 tags have magic and checksum
  checks, 358 have header checks, 356 payload-length checks, 45 CPU-feature
  checks, and 20 read-only-snapshot checksum checks. The deserializer's
  synchronization and bounds checks are unchanged. All 369 exact tags passed
  Linux and Windows builds, including regression coverage for issue #23.
- For the 57 exact failed tags from V8 14.7.84 through 15.3.25, the modern
  compatibility layer detects the `OwnedVector`, `DirectHandleVector`,
  generated object-predicate, `TrustedFixedArray`, and strong length API
  boundaries. It bypasses only the source, version, flags, and embedder-specific
  read-only-snapshot identity checks, and normalizes the external-reference-table
  size encoded in the private in-memory magic copy. Before normalization, it
  requires the V8 magic family and an exact match between the declared payload
  length and file boundary. The upstream magic check still executes; payload
  checksum and every deserializer protocol check are preserved. Nested
  functions are printed with a GC-rooted, deduplicated flat worklist instead
  of recursively expanding `HeapObjectShortPrint`. All 57 exact tags passed
  patch replay plus Linux and Windows builds.
- V8 bytecode opcodes, register/slot layouts, and handler table structures vary across versions. Always use a **matching** d8 build.
- Because there is no Node.js environment, the JSC compiled by Node.js may not be decompiled normally, while Electron works fine.
- If the output looks wrong:
  1. Re‑check the version alignment.
  2. If still incorrect, open an Issue.
  3. Or adjust the opcode mapping tables inside the modified View8.
- JavaScript reconstruction cannot be 100% identical to the original:
  - Variable / function names may be missing or replaced.
  - Control flow may be structurally reorganized.
  - Constant folding / runtime optimizations are not perfectly reversible.

---

## References & Acknowledgments

- View8:
  - [suleram/View8](https://github.com/suleram/View8) (integrated and modified here)
- Blog posts / materials:
  - https://guage.cool/wiz-license.html
  - https://rce.moe/2025/01/07/v8-bytecode-decompiler/
- Official V8 project & documentation (Chromium / v8.dev)
