'use strict';

// Prepare renderer JSC roots for Chromium DevTools Protocol inspection. Node's
// `inspector.Session` is not initialized in every Electron renderer, so the
// browser coordinator owns the protocol session. This preload only performs
// hermetic VM initialization and publishes genuine target function references
// in its isolated world; it never receives a real host API in that VM.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const v8 = require('node:v8');
const { ipcRenderer } = require('electron');
const {
  cacheForRuntime,
  createSandbox,
  runModuleWrapper,
  discoverReturnedFunctions,
  collectCapturedGlobalFunctions,
  createTraceSink
} = require('./electron_v8_extract.cjs');

const configPath = process.env.JSC2JS_RENDER_CONFIG;
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const ROOTS_KEY = '__jsc2js_renderer_inspector_roots';
const TRACE_MARKER_KEY = '__jsc2js_renderer_inspector_trace_marker';

function collectExportedCallables(value, label, seen, destination, depth = 0) {
  if (value === null || value === undefined || seen.has(value) || depth > 12) return;
  if (typeof value !== 'object' && typeof value !== 'function') return;
  seen.add(value);
  if (typeof value === 'function') destination.push({ label, fn: value });
  let keys;
  try { keys = Reflect.ownKeys(value).slice(0, 1024); } catch { return; }
  for (const key of keys) {
    if (typeof value === 'function' && ['arguments', 'caller', 'length', 'name'].includes(key)) continue;
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { continue; }
    if (!descriptor) continue;
    const child = `${label}.${typeof key === 'symbol' ? key.toString() : key}`;
    if (Object.hasOwn(descriptor, 'value')) {
      collectExportedCallables(descriptor.value, child, seen, destination, depth + 1);
    }
    if (typeof descriptor.get === 'function') collectExportedCallables(descriptor.get, `${child}<get>`, seen, destination, depth + 1);
    if (typeof descriptor.set === 'function') collectExportedCallables(descriptor.set, `${child}<set>`, seen, destination, depth + 1);
  }
}

function prepareFile(filename, timeout, discover) {
  const absolute = path.resolve(filename);
  const report = {
    file: absolute,
    status: 'pending',
    functions: [],
    observations: {
      requires: [], reads: [], nativeLoadRequests: [], nativeFunctionBindings: [],
      stubCalls: [], stubWrites: [], console: [], exitCalls: []
    }
  };
  try {
    const context = createSandbox(absolute, report.observations, 'renderer');
    const { cachedData, source } = cacheForRuntime(absolute);
    const script = new vm.Script(source, { cachedData, filename: absolute });
    if (script.cachedDataRejected) throw new Error('cachedDataRejected by Electron renderer runtime');
    const root = script.runInContext(context, { timeout });
    if (typeof root !== 'function') throw new Error('cache did not evaluate to a CommonJS wrapper function');
    let initialized;
    try {
      initialized = runModuleWrapper(context, root, absolute, timeout, report.observations);
      report.moduleInitialization = 'completed';
    } catch (error) {
      initialized = {
        moduleRecord: context.__jsc2js_module,
        callbacks: context.__jsc2js_callbacks || []
      };
      report.moduleInitialization = 'interrupted';
      report.moduleInitializationError = String(error && error.message || error);
    }
    const moduleRecord = initialized.moduleRecord || { exports: {} };
    const callbacks = (initialized.callbacks || [])
      .map(entry => entry.callback)
      .filter(value => typeof value === 'function');
    const globalFunctions = [];
    collectCapturedGlobalFunctions(context, globalFunctions);
    report.materializedGlobalFunctionCount = globalFunctions.length;
    let discovered = {};
    if (discover && report.moduleInitialization === 'completed') {
      const candidates = [];
      collectExportedCallables(moduleRecord.exports, 'exports', new Set(), candidates);
      const result = discoverReturnedFunctions(context, candidates, timeout, report.observations);
      report.discovery = result.discovered;
      discovered = Object.fromEntries(result.functions.map((item, index) => [`${index}:${item.label}`, item.fn]));
    } else if (discover) {
      report.discovery = [{
        status: 'skipped-module-initialization-interrupted',
        error: report.moduleInitializationError
      }];
    }
    report.status = 'accepted';
    return {
      root,
      exports: moduleRecord.exports,
      callbacks,
      globalFunctions: Object.fromEntries(
        globalFunctions.map((item, index) => [`${index}:${item.label}`, item.fn])
      ),
      discovered,
      report
    };
  } catch (error) {
    report.status = 'error';
    report.error = String(error && error.stack || error);
    return { root: null, exports: null, callbacks: [], globalFunctions: {}, discovered: {}, report };
  }
}

function validateConfig() {
  if (!Array.isArray(config.files) || !config.files.length) throw new Error('config requires non-empty files');
  const timeout = Number(config.timeoutMs || config.timeout || 1500);
  const closureDepth = config.closureDepth === undefined ? 12 : Number(config.closureDepth);
  if (!Number.isInteger(timeout) || timeout < 1) throw new Error('renderer timeout must be a positive integer');
  if (!Number.isInteger(closureDepth) || closureDepth < 0 || closureDepth > 12) {
    throw new Error('renderer closureDepth must be an integer from 0 to 12');
  }
  if (config.functionMatch !== undefined) new RegExp(String(config.functionMatch));
  const emit = config.emit || (config.traceFile ? 'trace' : 'none');
  if (!['trace', 'none'].includes(emit)) throw new Error('config.emit must be none or trace');
  if (emit === 'trace' && !config.traceFile) throw new Error('config.traceFile is required when config.emit is trace');
  return { timeout, closureDepth, emit, discover: Boolean(config.discover) };
}

v8.setFlagsFromString('--no-lazy --no-flush-bytecode');
try {
  const options = validateConfig();
  // DebugPrint is executed by the renderer through CDP. Redirect this
  // renderer's native stdout before the coordinator starts dumping constants.
  const trace = options.emit === 'trace' ? createTraceSink(config.traceFile) : null;
  // Markers and %DebugPrint must share the renderer CRT stdout stream. The
  // browser coordinator invokes this function through CDP between native V8
  // prints, avoiding competing file offsets from main-process fs writes.
  globalThis[TRACE_MARKER_KEY] = trace
    ? line => { trace.write(String(line)); trace.flush(); }
    : null;
  const entries = config.files.map(file => prepareFile(file, options.timeout, options.discover));
  globalThis[ROOTS_KEY] = {
    stamp: `${Date.now()}:${Math.random()}`,
    entries,
    traceMarker: globalThis[TRACE_MARKER_KEY]
  };
  ipcRenderer.send('jsc2js-renderer-inspector-ready', {
    stamp: globalThis[ROOTS_KEY].stamp,
    options,
    reports: entries.map(entry => entry.report)
  });
  ipcRenderer.once('jsc2js-renderer-inspector-complete', () => {
    delete globalThis[ROOTS_KEY];
    delete globalThis[TRACE_MARKER_KEY];
  });
} catch (error) {
  ipcRenderer.send('jsc2js-renderer-inspector-ready', {
    error: String(error && error.stack || error),
    options: null,
    reports: []
  });
}
