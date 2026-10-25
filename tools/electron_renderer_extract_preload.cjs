'use strict';

// Renderer-snapshot extractor. A Bytenode cache is deserialized only in this
// renderer, whose V8 snapshot matches renderer-generated JSC. `module` and
// `discover` then run the CommonJS wrapper in the same hermetic VM sandbox used
// by electron_v8_extract.cjs; they never receive the real renderer globals,
// Node process, Electron bridge, or writable filesystem.
const fs = require('node:fs');
const vm = require('node:vm');
const v8 = require('node:v8');
const { brotliDecompressSync } = require('node:zlib');
const { ipcRenderer } = require('electron');
const {
  createTraceSink,
  processFile
} = require('./electron_v8_extract.cjs');

const configPath = process.env.JSC2JS_RENDER_CONFIG;
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const magic = Buffer.from([0xde, 0xc0]);
const zeroExternalReferenceTable = Buffer.alloc(2);
const MODULE_MODES = new Set(['module', 'discover']);
const ROOT_MODE = 'root';

function extractionOptions() {
  const mode = config.mode || ROOT_MODE;
  const emit = config.emit || (config.traceFile ? 'trace' : 'none');
  const timeout = Number(config.timeoutMs || config.timeout || 1500);
  if (![ROOT_MODE, ...MODULE_MODES].includes(mode)) {
    throw new Error(`unsupported renderer extraction mode ${JSON.stringify(mode)}`);
  }
  if (!['trace', 'none'].includes(emit)) {
    throw new Error(`unsupported renderer emit mode ${JSON.stringify(emit)}`);
  }
  if (emit === 'trace' && !config.traceFile) {
    throw new Error('renderer trace mode requires config.traceFile');
  }
  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new Error('renderer timeout must be a positive integer');
  }
  return { mode, emit, timeout };
}

function isV8Cache(buffer) {
  return Buffer.isBuffer(buffer) &&
    !buffer.subarray(0, 2).equals(zeroExternalReferenceTable) &&
    buffer.subarray(2, 4).equals(magic);
}

function loadRootWrapper(filename) {
  let cache = Buffer.from(fs.readFileSync(filename));
  if (!isV8Cache(cache)) cache = brotliDecompressSync(cache);
  if (!isV8Cache(cache)) throw new Error('not a V8/Bytenode cache');
  const sourceLength = cache.readUInt32LE(8);
  if (sourceLength < 1 || sourceLength > 64 * 1024 * 1024) {
    throw new Error(`invalid source length ${sourceLength}`);
  }
  const dummy = new vm.Script('"ಠ_ಠ"', { produceCachedData: true }).createCachedData();
  dummy.subarray(12, 16).copy(cache, 12);
  const source = sourceLength > 1 ? `"${'\u200b'.repeat(sourceLength - 2)}"` : '';
  const script = new vm.Script(source, { cachedData: cache, filename });
  if (script.cachedDataRejected) throw new Error('cachedDataRejected by Electron renderer runtime');
  const wrapper = script.runInThisContext();
  if (typeof wrapper !== 'function') throw new Error('cache did not evaluate to a CommonJS wrapper function');
  return wrapper;
}

function emit(line, trace) {
  trace.write(`${line}\n`);
  trace.flush();
}

function dumpRoot(key, filename, wrapper, trace) {
  emit(`@@JSC2JS_FUNCTION_BEGIN ${JSON.stringify({ key, label: `${filename}:$wrapper` })}`, trace);
  let info;
  try {
    info = %GetBytecode(wrapper);
  } catch (error) {
    emit(`@@JSC2JS_FUNCTION_END ${JSON.stringify({ key, status: 'error' })}`, trace);
    return { key, status: 'get-bytecode-error', error: String(error && error.message || error) };
  }
  emit(`@@JSC2JS_FUNCTION_END ${JSON.stringify({ key, status: info === undefined ? 'no-bytecode' : 'ok' })}`, trace);
  if (info === undefined) return { key, status: 'no-bytecode' };
  emit(`@@JSC2JS_CONSTANTS_BEGIN ${JSON.stringify({ key, count: info.constant_pool.length })}`, trace);
  for (let index = 0; index < info.constant_pool.length; index += 1) {
    emit(`@@JSC2JS_CONSTANT_INDEX ${JSON.stringify({ key, index })}`, trace);
    %DebugPrint(info.constant_pool[index]);
    trace.flush();
  }
  emit(`@@JSC2JS_CONSTANTS_END ${JSON.stringify({ key })}`, trace);
  let bytecodeValues = null;
  try {
    bytecodeValues = Array.from(new Uint8Array(info.bytecode));
  } catch {
    // Some V8 builds expose the BytecodeArray only as an internal wrapper.
  }
  return {
    key, status: 'ok', parameterCount: info.parameter_count,
    frameSize: info.frame_size, constantPoolLength: info.constant_pool.length,
    bytecodeInfoKeys: Reflect.ownKeys(info).map(String),
    bytecodeType: Object.prototype.toString.call(info.bytecode),
    bytecodeLength: Number(info.bytecode && info.bytecode.byteLength) || 0,
    bytecodeValues
  };
}

function rendererContext(wrapperExecution) {
  return Object.freeze({
    runtimeProcessType: process.type,
    cacheSnapshot: 'renderer',
    executionContext: 'isolated-analysis-vm',
    wrapperExecution
  });
}

function extractRoot(filename, ordinal, trace) {
  try {
    const wrapper = loadRootWrapper(filename);
    return {
      file: filename, status: 'accepted', wrapperArity: wrapper.length,
      analysisContext: rendererContext('not-invoked'),
      functions: [dumpRoot(`${ordinal}-root`, filename.split(/[\\/]/).pop(), wrapper, trace)]
    };
  } catch (error) {
    return { file: filename, status: 'error', error: String(error && error.stack || error), functions: [] };
  }
}

function extractModule(filename, ordinal, options, trace) {
  const result = processFile(filename, options, ordinal + 1, 'renderer', trace);
  result.analysisContext = rendererContext('hermetic-sandbox');
  return result;
}

v8.setFlagsFromString('--no-lazy --no-flush-bytecode');
let options;
let results;
try {
  options = extractionOptions();
  const trace = options.emit === 'trace'
    ? createTraceSink(config.traceFile)
    : Object.freeze({ write() {}, flush() {} });
  results = config.files.map((file, index) => options.mode === ROOT_MODE
    ? extractRoot(file, index, trace)
    : extractModule(file, index, options, trace));
} catch (error) {
  options = options || { mode: config.mode || ROOT_MODE, emit: config.emit || 'none' };
  results = config.files.map(file => ({
    file, status: 'error', error: String(error && error.stack || error), functions: []
  }));
}
const failed = results.filter(result => result.status !== 'accepted').length;
ipcRenderer.send('jsc2js-renderer-extract-result', {
  tool: 'electron_renderer_extract',
  runtime: { electron: process.versions.electron, v8: process.versions.v8, type: process.type },
  mode: options.mode,
  emit: options.emit,
  traceFile: config.traceFile || null,
  analysisContext: rendererContext(options.mode === ROOT_MODE ? 'not-invoked' : 'hermetic-sandbox'),
  accepted: results.length - failed, failed, results
});
