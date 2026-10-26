# Electron Runtime Debug Bridge

[简体中文](#electron-运行时调试桥) | [English](#electron-runtime-debug-bridge)

## Electron 运行时调试桥

`index.cjs` 为 Electron 主进程提供一个仅本机可访问的 Chrome DevTools
Protocol（CDP）桥接。适用于 Electron/Chromium 禁用或忽略
`--remote-debugging-port` 的发行版。

它通过 Electron 官方 `webContents.debugger` API 将真实 renderer 暴露为一个
本地 CDP target。该模块不包含任何游戏、JSC、Bytenode、对象名或数值修改逻辑；它可
用于任何你有权调试的 Electron 应用。

### 集成

在主进程入口、创建首个 `BrowserWindow` **之前**安装：

```js
const { installElectronRuntimeDebug } = require('./tools/electron-runtime-debug');

const runtimeDebug = installElectronRuntimeDebug({
  electron: require('electron'),
  host: '127.0.0.1', // 默认值；拒绝非回环地址
  port: 9222,        // 默认值
  shortcut: 'F12'    // 可设为 false 禁用
});
```

安装后访问 `http://127.0.0.1:9222`，选择 renderer target 的链接。若浏览器阻止
`devtools://` 链接，请打开 `chrome://inspect/#devices`，添加 `127.0.0.1:9222`，然后
对目标点击 `inspect`。

`F12` 默认打开本机 target 列表；也可以使用：

```js
await runtimeDebug.open();
console.log(runtimeDebug.getTargets());
```

### 隔离上下文

有 `contextIsolation` 的应用会有多个 JavaScript 世界。连接建立后，桥会重放已存在的
`Runtime.executionContextCreated` 事件，因此 Console 的执行上下文菜单应包含默认
页面世界和例如 `Electron Isolated Context` 的隔离世界。要检查 preload 或隔离 world
安装的运行时对象，应选择后者。

### 选项与边界

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 监听地址；非回环地址必须显式 `allowNonLoopback: true`。 |
| `port` | `9222` | 本地 HTTP/CDP 端口。 |
| `windowFilter(window)` | 所有窗口 | 只暴露匹配的 `BrowserWindow`。 |
| `shortcut` | `F12` | `F12`、`Ctrl+Shift+I` 或 `false`。 |
| `openOnShortcut` | `true` | 是否由快捷键调用系统浏览器打开目标页。 |
| `log(level, message, details)` | console | 结构化日志回调。 |

一个 renderer 同时只允许一个外部 DevTools 客户端。桥会附加
`webContents.debugger`；若应用已有另一套调试器管理同一 renderer，应由应用把两者
整合到同一个 bridge，而不要并发 attach/detach。

该模块转发 CDP Runtime、Debugger、DOM、Network 等命令与事件，并缓存/重放执行
上下文与已解析脚本，使后连接的 DevTools 前端也能看到它们。它不加载页面、不注入
应用代码，也不扩大监听地址；任何运行时读写仍由 DevTools 用户显式执行。

## Electron Runtime Debug Bridge

`index.cjs` exposes a loopback-only Chrome DevTools Protocol (CDP) bridge from
an Electron main process. It is intended for Electron/Chromium distributions
that disable or ignore `--remote-debugging-port`.

The bridge publishes real renderer targets through Electron's documented
`webContents.debugger` API. It contains no game, JSC, Bytenode, object-name, or
value-modification logic, and can be used for any Electron application you are
authorized to debug.

### Integration

Install it in the main-process entry point **before** the first `BrowserWindow`
is created:

```js
const { installElectronRuntimeDebug } = require('./tools/electron-runtime-debug');

const runtimeDebug = installElectronRuntimeDebug({
  electron: require('electron'),
  host: '127.0.0.1',
  port: 9222,
  shortcut: 'F12'
});
```

Open `http://127.0.0.1:9222` and select a renderer target. If the browser blocks
a `devtools://` URL, open `chrome://inspect/#devices`, add `127.0.0.1:9222`, and
click `inspect` beside the target.

The default F12 handler opens the local target list. You can also call
`runtimeDebug.open()` or inspect `runtimeDebug.getTargets()`.

### Isolated contexts

An application using `contextIsolation` has multiple JavaScript worlds. When a
DevTools client connects, the bridge replays cached
`Runtime.executionContextCreated` events, so Console should offer both the
default page world and an isolated world such as `Electron Isolated Context`.
Select the isolated world to inspect objects installed by preload or isolated
runtime code.

### Options and limits

`host` defaults to `127.0.0.1`; non-loopback hosts require explicit
`allowNonLoopback: true`. Other options are `port`, `windowFilter`, `shortcut`,
`openOnShortcut`, and `log`. Only one external DevTools client is allowed per
renderer. The bridge owns `webContents.debugger`; applications already managing
that debugger should integrate with the same bridge rather than attach a second
debugger session.

The bridge forwards CDP Runtime, Debugger, DOM, Network, and related commands
and events, replaying execution contexts and parsed scripts for late clients.
It does not load pages, inject application code, or widen the listener address;
runtime inspection or mutation remains an explicit DevTools user action.
