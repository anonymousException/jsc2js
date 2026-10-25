'use strict';

// Renderer-side root-function extractor.  Run through
// electron_renderer_extract_main.cjs with --allow-natives-syntax and
// --print-bytecode.  Only script.runInThisContext() is used to materialize a
// CommonJS wrapper; the wrapper itself is never invoked.
const fs = require('node:fs');
const vm = require('node:vm');
const v8 = require('node:v8');
const { brotliDecompressSync } = require('node:zlib');
const { ipcRenderer } = require('electron');

const configPath = process.env.JSC2JS_RENDER_CONFIG;
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const magic = Buffer.from([0xde, 0xc0]);
const zeroExternalReferenceTable = Buffer.alloc(2);

function emit(line) {
  // Renderer stdout is inherited by the isolated analysis host.  The adapter
  // consumes only these explicit markers and ignores Electron bootstrap logs.
  process.stdout.write(`${line}\n`);
}

function isV8Cache(buffer) {
  return Buffer.isBuffer(buffer) &&
    !buffer.subarray(0, 2).equals(zeroExternalReferenceTable) &&
    buffer.subarray(2, 4).equals(magic);
}

function loadWrapper(filename) {
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

function dumpRoot(key, filename, wrapper) {
  emit(`@@JSC2JS_FUNCTION_BEGIN ${JSON.stringify({ key, label: `${filename}:$wrapper` })}`);
  let info;
  try {
    info = %GetBytecode(wrapper);
  } catch (error) {
    emit(`@@JSC2JS_FUNCTION_END ${JSON.stringify({ key, status: 'error' })}`);
    return { key, status: 'get-bytecode-error', error: String(error && error.message || error) };
  }
  emit(`@@JSC2JS_FUNCTION_END ${JSON.stringify({ key, status: info === undefined ? 'no-bytecode' : 'ok' })}`);
  if (info === undefined) return { key, status: 'no-bytecode' };
  emit(`@@JSC2JS_CONSTANTS_BEGIN ${JSON.stringify({ key, count: info.constant_pool.length })}`);
  for (let index = 0; index < info.constant_pool.length; index += 1) {
    emit(`@@JSC2JS_CONSTANT_INDEX ${JSON.stringify({ key, index })}`);
    %DebugPrint(info.constant_pool[index]);
  }
  emit(`@@JSC2JS_CONSTANTS_END ${JSON.stringify({ key })}`);
  let bytecodeValues = null;
  try {
    bytecodeValues = Array.from(new Uint8Array(info.bytecode));
  } catch {
    // Some V8 builds expose the BytecodeArray as a non-iterable internal
    // wrapper.  The metadata remains useful even in that case.
  }
  return {
    key, status: 'ok', parameterCount: info.parameter_count,
    frameSize: info.frame_size, constantPoolLength: info.constant_pool.length,
    // Kept in the JSON report because renderer stdout is not generally wired
    // to the browser process by Electron.  This tells callers whether a given
    // Electron build exposes a JS-readable instruction payload in addition to
    // its standard bytecode metadata.
    bytecodeInfoKeys: Reflect.ownKeys(info).map(String),
    bytecodeType: Object.prototype.toString.call(info.bytecode),
    bytecodeLength: Number(info.bytecode && info.bytecode.byteLength) || 0,
    bytecodeValues
  };
}

function extract(filename, ordinal) {
  try {
    const wrapper = loadWrapper(filename);
    return {
      file: filename, status: 'accepted', wrapperArity: wrapper.length,
      functions: [dumpRoot(`${ordinal}-root`, filename.split(/[\\/]/).pop(), wrapper)]
    };
  } catch (error) {
    return { file: filename, status: 'error', error: String(error && error.stack || error), functions: [] };
  }
}

v8.setFlagsFromString('--no-lazy --no-flush-bytecode');
const results = config.files.map(extract);
const failed = results.filter(result => result.status !== 'accepted').length;
ipcRenderer.send('jsc2js-renderer-extract-result', {
  tool: 'electron_renderer_extract',
  runtime: { electron: process.versions.electron, v8: process.versions.v8, type: process.type },
  accepted: results.length - failed, failed, results
});
