'use strict';

// Renderer-side cache compatibility verifier.  This executes only the cached
// script's outer expression to recover its CommonJS wrapper; the wrapper is
// not invoked, so target module logic, `require`, and app APIs never run.
const fs = require('node:fs');
const vm = require('node:vm');
const v8 = require('node:v8');
const { brotliDecompressSync } = require('node:zlib');
const { ipcRenderer } = require('electron');

const configPath = process.env.JSC2JS_RENDER_CONFIG;
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const magic = Buffer.from([0xde, 0xc0]);
const zeroExternalReferenceTable = Buffer.alloc(2);

function isV8Cache(buffer) {
  return Buffer.isBuffer(buffer) &&
    !buffer.subarray(0, 2).equals(zeroExternalReferenceTable) &&
    buffer.subarray(2, 4).equals(magic);
}

function verify(filename) {
  try {
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
    return { file: filename, status: 'accepted', wrapperArity: wrapper.length };
  } catch (error) {
    return { file: filename, status: 'error', error: String(error && error.stack || error) };
  }
}

v8.setFlagsFromString('--no-lazy --no-flush-bytecode');
const results = config.files.map(verify);
const failed = results.filter(result => result.status !== 'accepted').length;
ipcRenderer.send('jsc2js-renderer-verify-result', {
  tool: 'electron_renderer_verify',
  runtime: { electron: process.versions.electron, v8: process.versions.v8, type: process.type },
  accepted: results.length - failed,
  failed,
  results
});
