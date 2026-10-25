'use strict';

/*
 * Electron-runtime extractor for modern Bytenode/V8 caches.
 *
 * Run this script with the target Electron executable, not ordinary Node:
 *
 *   ELECTRON_RUN_AS_NODE=1 <electron.exe> --allow-natives-syntax \
 *       --print-bytecode \
 *       electron_v8_extract.cjs --mode verify --report out.json file1.jsc ...
 *
 * Modes:
 *   verify - deserializes only the outer cached script of every file.  The
 *            CommonJS wrapper body is not called.
 *   root   - additionally dumps the outer CommonJS wrapper's bytecode.
 *   module - runs the wrapper inside a fresh VM context with inert stubs for
 *            process, timers, console, and every require().  It never gives
 *            target code a host builtin/module, then dumps enumerable exported
 *            functions plus registered callbacks.
 *   discover - does `module`, then invokes exported/factory functions with
 *            inert arguments in that same isolated context (bounded depth and
 *            timeout) to materialize returned closure objects as well.
 *
 * `--emit none` is useful for broad sandbox-initialization coverage; `trace`
 * (the default) emits every recovered function for View8 conversion.
 *
 * `%GetBytecode` / `%DebugPrint` require --allow-natives-syntax; bytecode text
 * requires --print-bytecode.  Capture both process streams, then pass the
 * marker-bearing transcript to electron_v8_to_view8.py --trace.  On Windows
 * GUI Electron builds, --trace-file redirects V8's native stdout to a file
 * through an optional host-side Koffi binding, so a console handle is not
 * required.  The adapter ignores runtime bootstrap bytecode outside its
 * explicit markers.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const v8 = require('node:v8');
const { brotliDecompressSync } = require('node:zlib');

const MAGIC = Buffer.from([0xde, 0xc0]);
const ZERO_EXTERNAL_REFERENCE_TABLE = Buffer.alloc(2);
// Never pass an analysis stub to V8's `%GetBytecode`: a callable Proxy is not
// a real JSFunction/SFI and V8's debug intrinsic is intentionally not a proxy
// inspection API.
const INERT_VALUES = new WeakSet();
// `discover` intentionally calls exports with inert arguments. Installers
// commonly add methods to an argument's prototype rather than returning them;
// retain those writes so the bounded function graph can recover the newly
// materialized closures without making the proxy emulate a real host.
const INERT_CAPTURED_PROPERTIES = new WeakMap();
const MAX_INERT_CAPTURED_PROPERTIES = 1024;
const INERT_GLOBAL_NAMES = Object.freeze([
  'wx', 'lib', 'game', 'ui', 'get', 'ai', '_status', 'vkcore',
  'window', 'document', 'navigator', 'location', 'localStorage',
  'indexedDB', 'Worker', 'WebSocket', 'fetch', 'Image', 'Audio',
  'requestAnimationFrame', 'cancelAnimationFrame'
]);

function captureInertProperty(captured, property, value) {
  let values = captured.get(property);
  if (!values) {
    if (captured.size >= MAX_INERT_CAPTURED_PROPERTIES) return;
    values = new Set();
    captured.set(property, values);
  }
  values.add(value);
}

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error('usage: electron_v8_extract.cjs [--mode verify|root|module|discover] [--emit trace|none] [--trace-file FILE] [--report FILE] [--timeout MS] FILE.jsc ...');
  process.exitCode = 2;
}

function parseArguments(argv) {
  const result = {
    mode: 'verify', emit: 'trace', report: null, traceFile: null,
    timeout: 1500, files: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--mode' || argument === '--emit' || argument === '--report' ||
        argument === '--trace-file' || argument === '--timeout') {
      if (++index >= argv.length) throw new Error(`missing value for ${argument}`);
      const value = argv[index];
      if (argument === '--mode') result.mode = value;
      if (argument === '--emit') result.emit = value;
      if (argument === '--report') result.report = value;
      if (argument === '--trace-file') result.traceFile = value;
      if (argument === '--timeout') result.timeout = Number(value);
      continue;
    }
    if (argument.startsWith('--')) throw new Error(`unknown argument ${argument}`);
    result.files.push(argument);
  }
  if (!['verify', 'root', 'module', 'discover'].includes(result.mode)) throw new Error(`unsupported mode ${result.mode}`);
  if (!['trace', 'none'].includes(result.emit)) throw new Error(`unsupported emit mode ${result.emit}`);
  if (result.traceFile && result.emit !== 'trace') throw new Error('--trace-file requires --emit trace');
  if (!Number.isInteger(result.timeout) || result.timeout < 1) throw new Error('timeout must be a positive integer');
  if (!result.files.length) throw new Error('at least one .jsc file is required');
  return result;
}

function loadHostKoffi() {
  const candidates = [];
  if (process.env.JSC2JS_KOFFI_PATH) candidates.push(process.env.JSC2JS_KOFFI_PATH);
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app', 'node_modules', 'koffi'));
  }
  candidates.push('koffi');
  const errors = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      errors.push(`${candidate}: ${String(error && error.message || error)}`);
    }
  }
  throw new Error(
    'Windows --trace-file requires Koffi in the host runtime. Set JSC2JS_KOFFI_PATH ' +
    `or bundle koffi with the Electron app. Attempts: ${errors.join(' | ')}`
  );
}

function createTraceSink(traceFile) {
  if (!traceFile) {
    return Object.freeze({ write(line) { console.log(line); }, flush() {} });
  }
  if (process.platform !== 'win32') {
    throw new Error('--trace-file is for Windows GUI Electron hosts; redirect stdout on this platform');
  }
  const absolute = path.resolve(traceFile);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, '');
  const koffi = loadHostKoffi();
  const crt = koffi.load('ucrtbase.dll');
  const iob = crt.func('void * __cdecl __acrt_iob_func(int index)');
  const reopen = crt.func('void * __cdecl freopen(const char *filename, const char *mode, void *stream)');
  const fputs = crt.func('int __cdecl fputs(const char *text, void *stream)');
  const fflush = crt.func('int __cdecl fflush(void *stream)');
  const stdout = iob(1);
  if (!reopen(absolute, 'ab', stdout)) {
    throw new Error(`failed to redirect native stdout to trace file: ${absolute}`);
  }
  // `%GetBytecode` and `%DebugPrint` write through the CRT stdout stream.
  // Emit marker records through that identical FILE* as well. Mixing
  // fs.appendFileSync with freopen creates competing file offsets and can
  // overwrite records on GUI Electron hosts.
  const write = line => {
    if (fputs(`${line}\n`, stdout) < 0) {
      throw new Error(`failed to write trace marker to: ${absolute}`);
    }
  };
  const flush = () => { fflush(stdout); };
  return Object.freeze({
    write,
    flush
  });
}

function isV8Cache(buffer) {
  return Buffer.isBuffer(buffer) &&
    !buffer.subarray(0, 2).equals(ZERO_EXTERNAL_REFERENCE_TABLE) &&
    buffer.subarray(2, 4).equals(MAGIC);
}

function cacheForRuntime(filename) {
  let cachedData = Buffer.from(fs.readFileSync(filename));
  if (!isV8Cache(cachedData)) cachedData = brotliDecompressSync(cachedData);
  if (!isV8Cache(cachedData)) throw new Error('not a V8/Bytenode cache');

  // The flags hash is runtime-specific.  This is the same bounded header
  // normalization used by Bytenode; the actual V8 version/snapshot still has
  // to match or Electron rejects the cache.
  const dummy = new vm.Script('"ಠ_ಠ"', { produceCachedData: true }).createCachedData();
  dummy.subarray(12, 16).copy(cachedData, 12);
  const sourceLength = cachedData.readUInt32LE(8);
  if (sourceLength < 1 || sourceLength > 64 * 1024 * 1024) {
    throw new Error(`invalid source length ${sourceLength}`);
  }
  const source = sourceLength > 1 ? `"${'\u200b'.repeat(sourceLength - 2)}"` : '';
  return { cachedData, source };
}

function createInertValue(label, observations) {
  let proxy;
  const captured = new Map();
  const target = function inertTarget() { return proxy; };
  proxy = new Proxy(target, {
    get(_target, property) {
      // Promise resolution must never treat an inert callable as a thenable.
      if (property === 'then') return undefined;
      if (property === Symbol.toPrimitive) return () => 0;
      if (property === Symbol.toStringTag) return 'JSC2JSInert';
      if (property === 'toString') return () => `[JSC2JS inert ${label}]`;
      if (captured.has(property)) return captured.get(property).values().next().value;
      return proxy;
    },
    set(_target, property, value) {
      observations.stubWrites.push(`${label}.${String(property)}`);
      captureInertProperty(captured, property, value);
      return true;
    },
    defineProperty(_target, property, descriptor) {
      observations.stubWrites.push(`${label}.${String(property)}<defineProperty>`);
      if (Object.hasOwn(descriptor, 'value')) captureInertProperty(captured, property, descriptor.value);
      if (typeof descriptor.get === 'function') captureInertProperty(captured, property, descriptor.get);
      if (typeof descriptor.set === 'function') captureInertProperty(captured, property, descriptor.set);
      return true;
    },
    apply() {
      observations.stubCalls.push(label);
      return proxy;
    },
    construct() {
      observations.stubCalls.push(`new ${label}`);
      return proxy;
    },
    // A callable target has non-configurable `prototype`/`arguments`/`caller`
    // keys.  Never override ownKeys/descriptor here: Proxy invariants would
    // otherwise make plain Object.keys(...) in the target module throw.
    has() { return false; }
  });
  INERT_VALUES.add(target);
  INERT_VALUES.add(proxy);
  INERT_CAPTURED_PROPERTIES.set(target, captured);
  INERT_CAPTURED_PROPERTIES.set(proxy, captured);
  return proxy;
}

function createInertCallbackChain(label, observations, callbacks) {
  let chain;
  const target = function inertChainTarget() { return chain; };
  const capture = (method, handlers) => {
    for (const handler of handlers) {
      if (typeof handler === 'function') {
        callbacks.push({ kind: `${label}.${method}`, callback: handler, args: [] });
      }
    }
    return chain;
  };
  chain = new Proxy(target, {
    get(_target, property) {
      if (property === 'then' || property === 'catch' || property === 'finally') {
        return (...handlers) => capture(String(property), handlers);
      }
      if (property === Symbol.toPrimitive) return () => 0;
      if (property === Symbol.toStringTag) return 'JSC2JSInertChain';
      if (property === 'toString') return () => `[JSC2JS inert callback chain ${label}]`;
      return chain;
    },
    set(_target, property) {
      observations.stubWrites.push(`${label}.${String(property)}`);
      return true;
    },
    apply() {
      observations.stubCalls.push(label);
      return chain;
    },
    construct() {
      observations.stubCalls.push(`new ${label}`);
      return chain;
    },
    has() { return false; }
  });
  INERT_VALUES.add(target);
  INERT_VALUES.add(chain);
  return chain;
}

function analysisRoot(filename) {
  const normalized = path.resolve(filename);
  const marker = `${path.sep}app.asar.unpacked${path.sep}`;
  const position = normalized.toLowerCase().indexOf(marker.toLowerCase());
  return position >= 0
    ? normalized.slice(0, position + marker.length - 1)
    : path.dirname(normalized);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function createReadOnlyFs(root, observations) {
  const resolveReadPath = candidate => {
    const resolved = path.resolve(String(candidate));
    if (!isInside(root, resolved)) throw new Error(`JSC2JS read outside analysis root is blocked: ${resolved}`);
    observations.reads.push(resolved);
    return resolved;
  };
  return Object.freeze({
    readFileSync(file, ...args) { return fs.readFileSync(resolveReadPath(file), ...args); },
    existsSync(file) {
      try { return fs.existsSync(resolveReadPath(file)); } catch { return false; }
    },
    statSync(file, ...args) { return fs.statSync(resolveReadPath(file), ...args); },
    lstatSync(file, ...args) { return fs.lstatSync(resolveReadPath(file), ...args); },
    readdirSync(file, ...args) { return fs.readdirSync(resolveReadPath(file), ...args); },
    accessSync(file, ...args) { return fs.accessSync(resolveReadPath(file), ...args); }
  });
}

function createKoffiStub(observations) {
  return Object.freeze({
    load(libraryPath) {
      observations.nativeLoadRequests.push(String(libraryPath));
      return Object.freeze({
        func(signature) {
          observations.nativeFunctionBindings.push(String(signature));
          return createInertValue(`native(${signature})`, observations);
        }
      });
    }
  });
}

function createElectronStub(root, observations, callbacks = []) {
  const inert = createInertValue('electron', observations);
  const appTarget = createInertValue('electron.app', observations);
  const commandLine = createInertValue('electron.app.commandLine', observations);
  const readyChain = createInertCallbackChain('electron.app.whenReady', observations, callbacks);
  let app;
  const captureEventHandler = (kind, event, callback, args) => {
    if (typeof callback === 'function') {
      callbacks.push({ kind: `${kind}.${String(event)}`, callback, args });
    }
    return app;
  };
  // Electron's `app` surface is intentionally open-ended across Electron
  // versions.  Preserve the few values that affect deterministic module
  // initialization, record lifecycle handlers, and make all other methods
  // inert.  A fixed Object literal caused otherwise generic extraction to
  // stop at harmless calls such as app.setName() before startup closures had
  // been materialized.
  app = new Proxy(appTarget, {
    get(_target, property) {
      if (property === 'getAppPath' || property === 'getPath') return () => root;
      if (property === 'isPackaged') return true;
      if (property === 'whenReady') return () => readyChain;
      if (property === 'on' || property === 'once') {
        return (event, callback, ...args) => captureEventHandler(property, event, callback, args);
      }
      if (property === 'quit') return () => { observations.exitCalls.push('quit'); };
      if (property === 'exit') return code => { observations.exitCalls.push(code); };
      if (property === 'commandLine') return commandLine;
      return appTarget[property];
    },
    set(_target, property) {
      observations.stubWrites.push(`electron.app.${String(property)}`);
      return true;
    }
  });
  INERT_VALUES.add(app);
  return Object.freeze({
    app,
    shell: Object.freeze({ openPath: async () => '' }),
    dialog: Object.freeze({ showMessageBox: async () => ({ response: 2 }) }),
    ipcMain: inert,
    ipcRenderer: inert,
    contextBridge: inert,
    BrowserWindow: inert,
    nativeTheme: inert,
    protocol: inert,
    session: inert
  });
}

function createSandbox(filename, observations, processType) {
  const callbacks = [];
  const timer = { unref() {}, ref() {}, hasRef() { return false; } };
  const safeProcess = {
    arch: process.arch,
    platform: process.platform,
    type: processType,
    versions: Object.freeze({ electron: process.versions.electron, v8: process.versions.v8 }),
    env: Object.create(null),
    cwd: () => path.dirname(filename),
    resourcesPath: analysisRoot(filename),
    execPath: process.execPath,
    argv: [],
    exit(code) { observations.exitCalls.push(code); }
  };
  const sandbox = {
    Buffer,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    process: safeProcess,
    console: Object.freeze({
      log(...values) { observations.console.push(['log', values.map(String)]); },
      warn(...values) { observations.console.push(['warn', values.map(String)]); },
      error(...values) { observations.console.push(['error', values.map(String)]); }
    }),
    setInterval(callback, ...args) {
      if (typeof callback === 'function') callbacks.push({ kind: 'interval', callback, args });
      return timer;
    },
    clearInterval() {},
    setTimeout(callback, ...args) {
      if (typeof callback === 'function') callbacks.push({ kind: 'timeout', callback, args });
      return timer;
    },
    clearTimeout() {},
    queueMicrotask() {},
    __jsc2js_callbacks: callbacks
  };
  for (const name of INERT_GLOBAL_NAMES) {
    sandbox[name] = createInertValue(`global.${name}`, observations);
  }
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox, { name: `jsc2js:${path.basename(filename)}` });
}

function makeRequire(filename, observations, callbacks) {
  const root = analysisRoot(filename);
  const readonlyFs = createReadOnlyFs(root, observations);
  const readonlyFsPromises = Object.freeze({
    readFile(file, ...args) { return Promise.resolve(readonlyFs.readFileSync(file, ...args)); },
    stat(file, ...args) { return Promise.resolve(readonlyFs.statSync(file, ...args)); },
    lstat(file, ...args) { return Promise.resolve(readonlyFs.lstatSync(file, ...args)); },
    readdir(file, ...args) { return Promise.resolve(readonlyFs.readdirSync(file, ...args)); },
    access(file, ...args) {
      try {
        readonlyFs.accessSync(file, ...args);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    }
  });
  const crypto = require('node:crypto');
  return function inertRequire(request) {
    const label = String(request);
    observations.requires.push(label);
    if (label === 'node:fs' || label === 'fs') return readonlyFs;
    if (label === 'node:fs/promises' || label === 'fs/promises') return readonlyFsPromises;
    if (label === 'node:path' || label === 'path') return path;
    if (label === 'node:crypto' || label === 'crypto') return crypto;
    if (label === 'electron') return createElectronStub(root, observations, callbacks);
    if (label === 'koffi') return createKoffiStub(observations);
    return createInertValue(`require(${label})`, observations);
  };
}

const MAX_EXPORTED_GRAPH_DEPTH = 12;
const MAX_EXPORTED_GRAPH_NODES = 4096;
const MAX_EXPORTED_GRAPH_PROPERTIES = 1024;

function collectFunctions(value, label, seen, destination, depth = 0, state = { nodes: 0 }) {
  const captured = (typeof value === 'object' || typeof value === 'function') &&
    value !== null ? INERT_CAPTURED_PROPERTIES.get(value) : null;
  if ((typeof value === 'object' || typeof value === 'function') &&
      value !== null && INERT_VALUES.has(value) && (!captured || !captured.size)) return;
  if (seen.has(value) || depth > MAX_EXPORTED_GRAPH_DEPTH ||
      state.nodes >= MAX_EXPORTED_GRAPH_NODES || value === null || value === undefined) return;
  if (typeof value !== 'object' && typeof value !== 'function') return;
  seen.add(value);
  state.nodes += 1;
  if (typeof value === 'function' && !captured) destination.push({ label, fn: value });

  // An inert argument is normally opaque. In discover mode, however, a
  // factory/installer can attach genuine target closures to it. Traverse only
  // the bounded writes we observed instead of reflecting on the Proxy target.
  if (captured) {
    for (const [key, children] of captured) {
      const property = typeof key === 'symbol' ? key.toString() : String(key);
      for (const child of children) {
        collectFunctions(child, `${label}.${property}`, seen, destination, depth + 1, state);
      }
    }
    return;
  }

  // Do not stop at a function object.  Exported ES classes keep their actual
  // logic in non-enumerable `prototype` methods, and accessors keep it in
  // descriptor get/set functions.  Looking only at Object.keys() silently
  // loses those paths.  Own descriptors avoid executing target getters.
  let keys;
  try {
    keys = Reflect.ownKeys(value).slice(0, MAX_EXPORTED_GRAPH_PROPERTIES);
  } catch {
    return;
  }
  for (const key of keys) {
    // These built-in Function own properties either have no user bytecode or
    // throw in strict contexts.  `prototype` is deliberately retained.
    if (typeof value === 'function' &&
        (key === 'arguments' || key === 'caller' || key === 'length' || key === 'name')) continue;
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      continue;
    }
    if (!descriptor) continue;
    const childLabel = `${label}.${typeof key === 'symbol' ? key.toString() : key}`;
    if (Object.hasOwn(descriptor, 'value')) {
      collectFunctions(descriptor.value, childLabel, seen, destination, depth + 1, state);
    }
    if (typeof descriptor.get === 'function') {
      collectFunctions(descriptor.get, `${childLabel}<get>`, seen, destination, depth + 1, state);
    }
    if (typeof descriptor.set === 'function') {
      collectFunctions(descriptor.set, `${childLabel}<set>`, seen, destination, depth + 1, state);
    }
  }
}

function collectCapturedGlobalFunctions(context, destination) {
  // Renderer bundles often expose their live namespace by assigning a single
  // property such as `window.application = {...}`. The receiver is inert, so
  // this does not mutate a real page; nevertheless its captured target
  // closures are valid recovery roots and must not be lost merely because the
  // module has no CommonJS exports.
  const seen = new Set();
  const state = { nodes: 0 };
  for (const name of INERT_GLOBAL_NAMES) {
    collectFunctions(context[name], `global.${name}`, seen, destination, 0, state);
  }
}

function safeKey(text) {
  return text.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120) || 'anonymous';
}

function dumpFunction(key, label, fn, report, emit, trace) {
  let info;
  if (emit === 'trace') {
    trace.write(`@@JSC2JS_FUNCTION_BEGIN ${JSON.stringify({ key, label })}`);
    // Keep marker ordering stable relative to V8's native bytecode printer.
    // In particular, GUI Electron stdout can remain fully buffered after
    // freopen(), so a marker must reach the shared CRT FILE* before invoking
    // either debug intrinsic.
    trace.flush();
  }
  try {
    info = %GetBytecode(fn);
  } catch (error) {
    report.functions.push({ key, label, status: 'get-bytecode-error', error: String(error && error.message || error) });
    if (emit === 'trace') trace.write(`@@JSC2JS_FUNCTION_END ${JSON.stringify({ key, status: 'error' })}`);
    return;
  }
  if (emit === 'trace') {
    trace.flush();
    trace.write(`@@JSC2JS_FUNCTION_END ${JSON.stringify({ key, status: info === undefined ? 'no-bytecode' : 'ok' })}`);
  }
  if (info === undefined) {
    report.functions.push({ key, label, status: 'no-bytecode' });
    return;
  }
  report.functions.push({
    key,
    label,
    status: 'ok',
    parameterCount: info.parameter_count,
    frameSize: info.frame_size,
    constantPoolLength: info.constant_pool.length
  });
  if (emit !== 'trace') return;
  trace.write(`@@JSC2JS_CONSTANTS_BEGIN ${JSON.stringify({ key, count: info.constant_pool.length })}`);
  trace.flush();
  for (let index = 0; index < info.constant_pool.length; index += 1) {
    trace.write(`@@JSC2JS_CONSTANT_INDEX ${JSON.stringify({ key, index })}`);
    trace.flush();
    // V8's native printer can represent trusted internal objects without
    // reflecting on them through JavaScript (which is unsafe on modern V8).
    %DebugPrint(info.constant_pool[index]);
    trace.flush();
  }
  trace.write(`@@JSC2JS_CONSTANTS_END ${JSON.stringify({ key })}`);
}

function loadWrapper(filename, context) {
  const { cachedData, source } = cacheForRuntime(filename);
  const script = new vm.Script(source, { cachedData, filename });
  if (script.cachedDataRejected) throw new Error('cachedDataRejected by this Electron runtime');
  const wrapper = script.runInContext(context, { timeout: 1500 });
  if (typeof wrapper !== 'function') throw new Error('cache did not evaluate to a CommonJS wrapper function');
  return wrapper;
}

function runModuleWrapper(context, wrapper, filename, timeout, observations) {
  const moduleRecord = { exports: {} };
  context.__jsc2js_wrapper = wrapper;
  context.__jsc2js_module = moduleRecord;
  context.__jsc2js_require = makeRequire(
    filename, observations, context.__jsc2js_callbacks || []
  );
  context.__jsc2js_filename = filename.replace(/\.jsc$/i, '');
  context.__jsc2js_dirname = path.dirname(filename);
  vm.runInContext(
    '__jsc2js_wrapper(__jsc2js_module.exports, __jsc2js_require, __jsc2js_module, __jsc2js_filename, __jsc2js_dirname);',
    context,
    { timeout, filename: `${filename}:jsc2js-sandbox` }
  );
  return { moduleRecord, callbacks: context.__jsc2js_callbacks || [] };
}

function discoverReturnedFunctions(context, initialFunctions, timeout, observations) {
  const pending = initialFunctions.map(entry => ({ ...entry, depth: 0 }));
  const seen = new Set();
  const discovered = [];
  const discoveredFunctions = [];
  const maxCalls = 64;
  while (pending.length && discovered.length < maxCalls) {
    const entry = pending.shift();
    if (seen.has(entry.fn) || entry.depth >= 2) continue;
    seen.add(entry.fn);
    // Calling an async export can leave an unhandled Promise after the bounded
    // VM run completes.  Its bytecode is still exported below; discovery only
    // invokes synchronous factories to materialize returned closure objects.
    if (Object.prototype.toString.call(entry.fn) === '[object AsyncFunction]') {
      discovered.push({ label: entry.label, status: 'skipped-async' });
      continue;
    }
    const arity = Math.max(0, Math.min(Number(entry.fn.length) || 0, 8));
    const args = Array.from({ length: arity }, (_, index) =>
      createInertValue(`argument(${entry.label},${index})`, observations)
    );
    try {
      context.__jsc2js_discovery_target = entry.fn;
      context.__jsc2js_discovery_args = args;
      vm.runInContext(
        '__jsc2js_discovery_result = __jsc2js_discovery_target(...__jsc2js_discovery_args);',
        context,
        { timeout, filename: `jsc2js-discover:${entry.label}` }
      );
      const found = [];
      collectFunctions(context.__jsc2js_discovery_result, `${entry.label}()`, new Set(), found);
      args.forEach((argument, index) => {
        collectFunctions(
          argument, `${entry.label}(argument${index})`, new Set(), found
        );
      });
      for (const child of found) {
        pending.push({ ...child, depth: entry.depth + 1 });
        discoveredFunctions.push(child);
      }
      discovered.push({ label: entry.label, status: 'ok', functions: found.map(child => child.label) });
    } catch (error) {
      discovered.push({ label: entry.label, status: 'error', error: String(error && error.message || error) });
    }
  }
  return { discovered, functions: discoveredFunctions };
}

function processFile(filename, options, ordinal, processType, trace) {
  const absolute = path.resolve(filename);
  const report = {
    file: absolute,
    mode: options.mode,
    status: 'pending',
    functions: [],
    observations: {
      requires: [], reads: [], nativeLoadRequests: [], nativeFunctionBindings: [],
      stubCalls: [], stubWrites: [], console: [], exitCalls: []
    }
  };
  try {
    const context = createSandbox(absolute, report.observations, processType);
    const wrapper = loadWrapper(absolute, context);
    report.status = 'accepted';
    if (options.mode === 'verify') return report;

    const rootKey = `${ordinal}-root`;
    dumpFunction(rootKey, `${path.basename(absolute)}:$wrapper`, wrapper, report, options.emit, trace);
    if (options.mode === 'root') return report;

    let initialized;
    try {
      initialized = runModuleWrapper(
        context, wrapper, absolute, options.timeout, report.observations
      );
      report.moduleInitialization = 'completed';
    } catch (error) {
      // A renderer bundle can finish defining useful exports, callbacks, or
      // closures before reaching a host-only API.  Keep the deserialized
      // wrapper and all materialized roots instead of turning that partial
      // recovery into a file-level failure.
      initialized = {
        moduleRecord: context.__jsc2js_module,
        callbacks: context.__jsc2js_callbacks || []
      };
      report.moduleInitialization = 'interrupted';
      report.moduleInitializationError = String(error && error.message || error);
    }
    const { moduleRecord, callbacks } = initialized;
    const functions = [];
    if (moduleRecord) collectFunctions(moduleRecord.exports, 'exports', new Set(), functions);
    callbacks.forEach((entry, index) => collectFunctions(entry.callback, `callback.${entry.kind}.${index}`, new Set(), functions));
    collectCapturedGlobalFunctions(context, functions);
    if (options.mode === 'discover' && report.moduleInitialization === 'completed') {
      const discovery = discoverReturnedFunctions(context, functions, options.timeout, report.observations);
      report.discovery = discovery.discovered;
      functions.push(...discovery.functions);
    } else if (options.mode === 'discover') {
      report.discovery = [{
        status: 'skipped-module-initialization-interrupted',
        error: report.moduleInitializationError
      }];
    }
    const emitted = new Set([wrapper]);
    for (const entry of functions) {
      if (emitted.has(entry.fn)) continue;
      emitted.add(entry.fn);
      dumpFunction(
        `${ordinal}-${safeKey(entry.label)}`,
        `${path.basename(absolute)}:${entry.label}`,
        entry.fn, report, options.emit, trace
      );
    }
    report.exportFunctionCount = functions.length;
    return report;
  } catch (error) {
    report.status = 'error';
    report.error = String(error && error.stack || error);
    return report;
  }
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    usage(error.message);
    return;
  }
  v8.setFlagsFromString('--no-lazy --no-flush-bytecode');
  const trace = createTraceSink(options.traceFile);
  const started = new Date().toISOString();
  // This Node-mode invocation uses Electron's browser/main V8 snapshot.
  // Renderer caches must be routed through electron_renderer_verify_*.cjs,
  // whose hidden analysis window provides the actual renderer snapshot.
  const results = options.files.map((file, index) => {
    const browser = processFile(file, options, index + 1, 'browser', trace);
    browser.processType = 'browser';
    return browser;
  });
  const report = {
    tool: 'electron_v8_extract',
    started,
    runtime: { electron: process.versions.electron, v8: process.versions.v8, node: process.versions.node },
    mode: options.mode,
    traceFile: options.traceFile ? path.resolve(options.traceFile) : null,
    accepted: results.filter(result => result.status === 'accepted').length,
    failed: results.filter(result => result.status === 'error').length,
    results
  };
  if (options.report) fs.writeFileSync(options.report, JSON.stringify(report, null, 2));
  console.error(`JSC2JS_ELECTRON_EXTRACT accepted=${report.accepted} failed=${report.failed} mode=${options.mode}`);
  if (report.failed) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  cacheForRuntime,
  createSandbox,
  runModuleWrapper,
  // Exposed for the hermetic extractor regression tests. These helpers never
  // deserialize or execute a target cache by themselves.
  createInertValue,
  collectFunctions,
  collectCapturedGlobalFunctions,
  discoverReturnedFunctions,
  createTraceSink,
  parseArguments,
  // Renderer extraction uses the renderer V8 snapshot for deserialization,
  // then calls this same hermetic execution path with processType='renderer'.
  // Keeping the sandbox implementation shared prevents browser/renderer
  // analyses from silently gaining different host capabilities.
  processFile
};
