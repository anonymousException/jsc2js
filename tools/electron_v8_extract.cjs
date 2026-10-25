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
 * marker-bearing transcript to electron_v8_to_view8.py --trace.  The adapter
 * ignores runtime bootstrap bytecode outside its explicit markers.
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

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error('usage: electron_v8_extract.cjs [--mode verify|root|module|discover] [--emit trace|none] [--report FILE] [--timeout MS] FILE.jsc ...');
  process.exitCode = 2;
}

function parseArguments(argv) {
  const result = { mode: 'verify', emit: 'trace', report: null, timeout: 1500, files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--mode' || argument === '--emit' || argument === '--report' || argument === '--timeout') {
      if (++index >= argv.length) throw new Error(`missing value for ${argument}`);
      const value = argv[index];
      if (argument === '--mode') result.mode = value;
      if (argument === '--emit') result.emit = value;
      if (argument === '--report') result.report = value;
      if (argument === '--timeout') result.timeout = Number(value);
      continue;
    }
    if (argument.startsWith('--')) throw new Error(`unknown argument ${argument}`);
    result.files.push(argument);
  }
  if (!['verify', 'root', 'module', 'discover'].includes(result.mode)) throw new Error(`unsupported mode ${result.mode}`);
  if (!['trace', 'none'].includes(result.emit)) throw new Error(`unsupported emit mode ${result.emit}`);
  if (!Number.isInteger(result.timeout) || result.timeout < 1) throw new Error('timeout must be a positive integer');
  if (!result.files.length) throw new Error('at least one .jsc file is required');
  return result;
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
  const target = function inertTarget() { return proxy; };
  proxy = new Proxy(target, {
    get(_target, property) {
      // Promise resolution must never treat an inert callable as a thenable.
      if (property === 'then') return undefined;
      if (property === Symbol.toPrimitive) return () => 0;
      if (property === Symbol.toStringTag) return 'JSC2JSInert';
      if (property === 'toString') return () => `[JSC2JS inert ${label}]`;
      return proxy;
    },
    set(_target, property) {
      observations.stubWrites.push(`${label}.${String(property)}`);
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
  return proxy;
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

function createElectronStub(root, observations) {
  const inert = createInertValue('electron', observations);
  const app = Object.freeze({
    getAppPath: () => root,
    getPath: () => root,
    isPackaged: true,
    whenReady: () => Promise.resolve(),
    on() {}, once() {}, quit() {}, exit(code) { observations.exitCalls.push(code); },
    commandLine: Object.freeze({ appendSwitch() {} })
  });
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
  for (const name of [
    'wx', 'lib', 'game', 'ui', 'get', 'ai', '_status', 'vkcore',
    'window', 'document', 'navigator', 'location', 'localStorage',
    'indexedDB', 'Worker', 'WebSocket', 'fetch', 'Image', 'Audio',
    'requestAnimationFrame', 'cancelAnimationFrame'
  ]) {
    sandbox[name] = createInertValue(`global.${name}`, observations);
  }
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox, { name: `jsc2js:${path.basename(filename)}` });
}

function makeRequire(filename, observations) {
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
    if (label === 'electron') return createElectronStub(root, observations);
    if (label === 'koffi') return createKoffiStub(observations);
    return createInertValue(`require(${label})`, observations);
  };
}

const MAX_EXPORTED_GRAPH_DEPTH = 12;
const MAX_EXPORTED_GRAPH_NODES = 4096;
const MAX_EXPORTED_GRAPH_PROPERTIES = 1024;

function collectFunctions(value, label, seen, destination, depth = 0, state = { nodes: 0 }) {
  if ((typeof value === 'object' || typeof value === 'function') &&
      value !== null && INERT_VALUES.has(value)) return;
  if (seen.has(value) || depth > MAX_EXPORTED_GRAPH_DEPTH ||
      state.nodes >= MAX_EXPORTED_GRAPH_NODES || value === null || value === undefined) return;
  if (typeof value !== 'object' && typeof value !== 'function') return;
  seen.add(value);
  state.nodes += 1;
  if (typeof value === 'function') destination.push({ label, fn: value });

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

function safeKey(text) {
  return text.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120) || 'anonymous';
}

function dumpFunction(key, label, fn, report, emit) {
  let info;
  if (emit === 'trace') console.log(`@@JSC2JS_FUNCTION_BEGIN ${JSON.stringify({ key, label })}`);
  try {
    info = %GetBytecode(fn);
  } catch (error) {
    report.functions.push({ key, label, status: 'get-bytecode-error', error: String(error && error.message || error) });
    if (emit === 'trace') console.log(`@@JSC2JS_FUNCTION_END ${JSON.stringify({ key, status: 'error' })}`);
    return;
  }
  if (emit === 'trace') console.log(`@@JSC2JS_FUNCTION_END ${JSON.stringify({ key, status: info === undefined ? 'no-bytecode' : 'ok' })}`);
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
  console.log(`@@JSC2JS_CONSTANTS_BEGIN ${JSON.stringify({ key, count: info.constant_pool.length })}`);
  for (let index = 0; index < info.constant_pool.length; index += 1) {
    console.log(`@@JSC2JS_CONSTANT_INDEX ${JSON.stringify({ key, index })}`);
    // V8's native printer can represent trusted internal objects without
    // reflecting on them through JavaScript (which is unsafe on modern V8).
    %DebugPrint(info.constant_pool[index]);
  }
  console.log(`@@JSC2JS_CONSTANTS_END ${JSON.stringify({ key })}`);
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
  context.__jsc2js_require = makeRequire(filename, observations);
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

function processFile(filename, options, ordinal, processType) {
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
    dumpFunction(rootKey, `${path.basename(absolute)}:$wrapper`, wrapper, report, options.emit);
    if (options.mode === 'root') return report;

    const { moduleRecord, callbacks } = runModuleWrapper(
      context, wrapper, absolute, options.timeout, report.observations
    );
    const functions = [];
    collectFunctions(moduleRecord.exports, 'exports', new Set(), functions);
    callbacks.forEach((entry, index) => collectFunctions(entry.callback, `callback.${entry.kind}.${index}`, new Set(), functions));
    if (options.mode === 'discover') {
      const discovery = discoverReturnedFunctions(context, functions, options.timeout, report.observations);
      report.discovery = discovery.discovered;
      functions.push(...discovery.functions);
    }
    const emitted = new Set([wrapper]);
    for (const entry of functions) {
      if (emitted.has(entry.fn)) continue;
      emitted.add(entry.fn);
      dumpFunction(
        `${ordinal}-${safeKey(entry.label)}`,
        `${path.basename(absolute)}:${entry.label}`,
        entry.fn,
        report,
        options.emit
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
  const started = new Date().toISOString();
  // This Node-mode invocation uses Electron's browser/main V8 snapshot.
  // Renderer caches must be routed through electron_renderer_verify_*.cjs,
  // whose hidden analysis window provides the actual renderer snapshot.
  const results = options.files.map((file, index) => {
    const browser = processFile(file, options, index + 1, 'browser');
    browser.processType = 'browser';
    return browser;
  });
  const report = {
    tool: 'electron_v8_extract',
    started,
    runtime: { electron: process.versions.electron, v8: process.versions.v8, node: process.versions.node },
    mode: options.mode,
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
  runModuleWrapper
};
