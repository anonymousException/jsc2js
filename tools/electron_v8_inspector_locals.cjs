'use strict';

/*
 * Enumerate closures materialized by an arbitrary Bytenode CommonJS wrapper.
 *
 * This tool runs under ELECTRON_RUN_AS_NODE=1 with --allow-natives-syntax and
 * --print-bytecode.  It uses Electron's in-process Inspector protocol to keep
 * references to genuine JSFunction objects; unlike v8.queryObjects(summary),
 * it never substitutes string summaries for internal V8 objects.
 *
 * Module initialization takes place only in electron_v8_extract's isolated
 * Context: host require(), writes, process exit, timers, Electron APIs and
 * Koffi native loads remain inert or read-only.  This file receives only a
 * cache path and has no product- or game-specific branch.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const inspector = require('node:inspector');
const v8 = require('node:v8');
const { fileURLToPath } = require('node:url');
const { cacheForRuntime, createSandbox, runModuleWrapper } = require('./electron_v8_extract.cjs');

function parseArguments(argv) {
  const result = { file: null, report: null, timeout: 1500, discover: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--discover') {
      result.discover = true;
      continue;
    }
    if (argument === '--report' || argument === '--timeout') {
      if (++index >= argv.length) throw new Error(`missing value for ${argument}`);
      if (argument === '--report') result.report = argv[index];
      else result.timeout = Number(argv[index]);
      continue;
    }
    if (argument.startsWith('--') || result.file) throw new Error(`unexpected argument ${argument}`);
    result.file = argument;
  }
  if (!result.file) throw new Error('usage: electron_v8_inspector_locals.cjs [--discover] [--report FILE] [--timeout MS] FILE.jsc');
  if (!Number.isInteger(result.timeout) || result.timeout < 1) throw new Error('timeout must be a positive integer');
  return result;
}

function collectExportedCallables(value, label, seen, destination, depth = 0) {
  if (value === null || value === undefined || seen.has(value) || depth > 12) return;
  if (typeof value !== 'object' && typeof value !== 'function') return;
  seen.add(value);
  if (typeof value === 'function') destination.push({ name: label, value });
  let keys;
  try {
    keys = Reflect.ownKeys(value).slice(0, 1024);
  } catch {
    return;
  }
  for (const key of keys) {
    if (typeof value === 'function' &&
        (key === 'arguments' || key === 'caller' || key === 'length' || key === 'name')) continue;
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      continue;
    }
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      collectExportedCallables(
        descriptor.value, `${label}.${typeof key === 'symbol' ? key.toString() : key}`,
        seen, destination, depth + 1
      );
    }
    if (descriptor && typeof descriptor.get === 'function') {
      collectExportedCallables(descriptor.get, `${label}.${String(key)}<get>`, seen, destination, depth + 1);
    }
    if (descriptor && typeof descriptor.set === 'function') {
      collectExportedCallables(descriptor.set, `${label}.${String(key)}<set>`, seen, destination, depth + 1);
    }
  }
}

function materializeZeroArgumentExports(context, moduleRecord, timeout) {
  const results = [];
  const candidates = [];
  collectExportedCallables(moduleRecord.exports, 'exports', new Set(), candidates);
  for (const { name, value } of candidates) {
    if (typeof value !== 'function' || value.length !== 0) continue;
    if (Object.prototype.toString.call(value) === '[object AsyncFunction]') continue;
    try {
      context.__jsc2js_inspector_factory = value;
      vm.runInContext(
        '__jsc2js_inspector_factory_result = __jsc2js_inspector_factory();',
        context,
        { timeout, filename: `jsc2js-inspector-discover:${name}` }
      );
      results.push({ name, status: 'ok', value: context.__jsc2js_inspector_factory_result });
    } catch (error) {
      results.push({ name, status: 'error', error: String(error && error.message || error) });
    }
  }
  return results;
}

function createSession() {
  const session = new inspector.Session();
  session.connect();
  const parsedScripts = [];
  session.on('Debugger.scriptParsed', event => parsedScripts.push(event.params));
  return {
    async post(method, params = {}) {
      return await new Promise((resolve, reject) => {
        session.post(method, params, (error, result) => error ? reject(error) : resolve(result));
      });
    },
    parsedScripts,
    disconnect() { session.disconnect(); }
  };
}

async function evaluate(session, expression) {
  const response = await session.post('Runtime.evaluate', { expression, returnByValue: false });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Inspector evaluation failed');
  return response.result;
}

async function remoteFunctionScriptId(session, remote) {
  try {
    const properties = await session.post('Runtime.getProperties', {
      objectId: remote.objectId,
      ownProperties: false
    });
    const location = (properties.internalProperties || []).find(
      property => property.name === '[[FunctionLocation]]'
    );
    return location && location.value && location.value.value
      ? String(location.value.value.scriptId)
      : null;
  } catch {
    return null;
  }
}

async function remoteFunctionIdentity(session, remote) {
  try {
    const properties = await session.post('Runtime.getProperties', {
      objectId: remote.objectId,
      ownProperties: false
    });
    const location = (properties.internalProperties || []).find(
      property => property.name === '[[FunctionLocation]]'
    );
    if (location && location.value && location.value.value) {
      const value = location.value.value;
      return `${value.scriptId}:${value.lineNumber}:${value.columnNumber}`;
    }
  } catch {
    // Fall back to the object id below.
  }
  return remote.objectId;
}

async function remoteProperties(session, remote, ownProperties = true) {
  if (!remote || !remote.objectId) return [];
  try {
    const response = await session.post('Runtime.getProperties', {
      objectId: remote.objectId,
      ownProperties
    });
    return response.result || [];
  } catch {
    // Inspector object groups can release ephemeral closure-context values
    // while walking the graph.  A stale value is simply not enumerable; do not
    // let it invalidate an otherwise complete module extraction.
    return [];
  }
}

const MAX_TARGET_GRAPH_DEPTH = 12;
const MAX_TARGET_GRAPH_OBJECTS = 4096;
const MAX_TARGET_GRAPH_PROPERTIES = 1024;

function isIntrinsicFunctionProperty(name) {
  return name === 'arguments' || name === 'caller' ||
    name === 'length' || name === 'name';
}

async function collectTargetValue(session, remote, label, state, targetScriptId, depth = 0) {
  if (!remote || !remote.objectId || depth > MAX_TARGET_GRAPH_DEPTH) return;
  if (remote.type === 'function') {
    await collectTargetFunction(session, remote, label, state, targetScriptId, depth);
    return;
  }
  if (remote.type !== 'object' || state.seenObjects.has(remote.objectId) ||
      state.seenObjects.size >= MAX_TARGET_GRAPH_OBJECTS) return;
  state.seenObjects.add(remote.objectId);
  await collectTargetOwnProperties(session, remote, label, state, targetScriptId, depth + 1);
}

async function collectTargetOwnProperties(session, remote, label, state, targetScriptId, depth) {
  const properties = await remoteProperties(session, remote, true);
  for (const property of properties.slice(0, MAX_TARGET_GRAPH_PROPERTIES)) {
    // Function own `prototype` must be traversed: ES class methods are
    // non-enumerable there.  Skip only intrinsic metadata with no target code.
    if (remote.type === 'function' && isIntrinsicFunctionProperty(property.name)) continue;
    const childLabel = `${label}.${property.name}`;
    await collectTargetValue(session, property.value, childLabel, state, targetScriptId, depth + 1);
    await collectTargetValue(session, property.get, `${childLabel}<get>`, state, targetScriptId, depth + 1);
    await collectTargetValue(session, property.set, `${childLabel}<set>`, state, targetScriptId, depth + 1);
  }
}

async function collectTargetFunction(session, remote, label, state, targetScriptId, depth = 0) {
  if (!remote || remote.type !== 'function' || !remote.objectId || depth > MAX_TARGET_GRAPH_DEPTH) return;
  if (await remoteFunctionScriptId(session, remote) !== targetScriptId) return;
  const identity = await remoteFunctionIdentity(session, remote);
  if (state.seenFunctions.has(identity)) return;
  state.seenFunctions.add(identity);
  state.functions.set(identity, { remote, label, identity });
  await collectClosureScopeFunctions(session, remote, label, state, targetScriptId, depth + 1);
  await collectTargetOwnProperties(session, remote, label, state, targetScriptId, depth + 1);
}

async function collectClosureScopeFunctions(session, remote, label, state, targetScriptId, depth) {
  const response = await session.post('Runtime.getProperties', {
    objectId: remote.objectId,
    ownProperties: false
  });
  const scopes = (response.internalProperties || []).find(item => item.name === '[[Scopes]]');
  if (!scopes || !scopes.value || !scopes.value.objectId) return;
  for (const scope of await remoteProperties(session, scopes.value, true)) {
    if (!/^\d+$/.test(scope.name) || !scope.value || !scope.value.objectId) continue;
    // Stop before global/module contexts: they introduce the whole Node
    // runtime and are unrelated to this cached closure graph.
    if (!String(scope.value.description || '').startsWith('Closure')) continue;
    for (const property of await remoteProperties(session, scope.value, true)) {
      if (!property.value || property.name === 'this') continue;
      // Only target-script functions are retained.  A bounded own-property
      // walk also reaches functions held in local object/class namespaces.
      await collectTargetValue(
        session, property.value, `${label}::${property.name}`,
        state, targetScriptId, depth + 1
      );
    }
  }
}

async function collectTargetExportFunctions(session, remote, label, state, targetScriptId) {
  await collectTargetValue(session, remote, label, state, targetScriptId);
}

function scriptUrlMatches(url, absolute) {
  if (!url) return false;
  if (path.resolve(url) === absolute) return true;
  try {
    return path.resolve(fileURLToPath(url)) === absolute;
  } catch {
    return false;
  }
}

function propertyMap(properties) {
  return new Map(properties.result.map(property => [property.name, property.value]));
}

async function callOn(session, objectId, declaration, args = []) {
  const result = await session.post('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: declaration,
    arguments: args,
    returnByValue: false
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Inspector function call failed');
  return result.result;
}

async function primitiveCall(session, objectId, declaration, args = []) {
  const result = await callOn(session, objectId, declaration, args);
  return Object.hasOwn(result, 'value') ? result.value : undefined;
}

async function dumpRemoteFunction(session, key, label, remote, report) {
  console.log(`@@JSC2JS_FUNCTION_BEGIN ${JSON.stringify({ key, label })}`);
  let constantPoolLength;
  try {
    constantPoolLength = await primitiveCall(
      session,
      remote.objectId,
      'function () { const info = globalThis.__jsc2js_get_bytecode(this); return info === undefined ? -1 : info.constant_pool.length; }'
    );
  } catch (error) {
    report.functions.push({ key, label, status: 'get-bytecode-error', error: String(error.message || error) });
    console.log(`@@JSC2JS_FUNCTION_END ${JSON.stringify({ key, status: 'error' })}`);
    return;
  }
  if (constantPoolLength === -1 || constantPoolLength === undefined) {
    report.functions.push({ key, label, status: 'no-bytecode' });
    console.log(`@@JSC2JS_FUNCTION_END ${JSON.stringify({ key, status: 'no-bytecode' })}`);
    return;
  }
  report.functions.push({
    key,
    label,
    status: 'ok',
    identity: await remoteFunctionIdentity(session, remote),
    constantPoolLength
  });
  console.log(`@@JSC2JS_FUNCTION_END ${JSON.stringify({ key, status: 'ok' })}`);
  console.log(`@@JSC2JS_CONSTANTS_BEGIN ${JSON.stringify({ key, count: constantPoolLength })}`);
  for (let index = 0; index < constantPoolLength; index += 1) {
    console.log(`@@JSC2JS_CONSTANT_INDEX ${JSON.stringify({ key, index })}`);
    await callOn(
      session,
      remote.objectId,
      'function (index) { %DebugPrint(globalThis.__jsc2js_get_bytecode(this).constant_pool[index]); }',
      [{ value: index }]
    );
  }
  console.log(`@@JSC2JS_CONSTANTS_END ${JSON.stringify({ key })}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const absolute = path.resolve(options.file);
  const report = {
    tool: 'electron_v8_inspector_locals',
    file: absolute,
    runtime: { electron: process.versions.electron, v8: process.versions.v8 },
    discover: options.discover,
    status: 'pending',
    functions: [],
    observations: {
      requires: [], reads: [], nativeLoadRequests: [], nativeFunctionBindings: [],
      stubCalls: [], stubWrites: [], console: [], exitCalls: []
    }
  };
  const session = createSession();
  try {
    v8.setFlagsFromString('--no-lazy --no-flush-bytecode');
    await session.post('Debugger.enable');
    globalThis.__jsc2js_get_bytecode = function getBytecode(value) { return %GetBytecode(value); };
    globalThis.__jsc2js_print_value = function printValue(value) { %DebugPrint(value); };
    const context = createSandbox(absolute, report.observations, 'browser');
    const { cachedData, source } = cacheForRuntime(absolute);
    const script = new vm.Script(source, { cachedData, filename: absolute });
    if (script.cachedDataRejected) throw new Error('cachedDataRejected by this Electron runtime');
    const wrapper = script.runInContext(context, { timeout: options.timeout });
    if (typeof wrapper !== 'function') throw new Error('cache did not evaluate to a CommonJS wrapper function');
    globalThis.__jsc2js_inspector_root = wrapper;
    const root = await evaluate(session, 'globalThis.__jsc2js_inspector_root');
    const rootScriptId = await remoteFunctionScriptId(session, root);
    if (!rootScriptId) throw new Error(`Inspector could not resolve root function location for ${absolute}`);
    let initialized;
    try {
      initialized = runModuleWrapper(context, wrapper, absolute, options.timeout, report.observations);
      report.moduleInitialization = 'completed';
    } catch (error) {
      // Static recovery stays useful after a host-dependent initializer fails:
      // its root scope has already materialized some/all nested closures.
      initialized = { moduleRecord: context.__jsc2js_module, callbacks: [] };
      report.moduleInitialization = 'interrupted';
      report.moduleInitializationError = String(error && error.message || error);
    }
    if (!initialized.moduleRecord) throw new Error('module record was not created');
    globalThis.__jsc2js_inspector_exports = initialized.moduleRecord.exports;
    if (options.discover && report.moduleInitialization === 'completed') {
      const discoveries = materializeZeroArgumentExports(
        context, initialized.moduleRecord, options.timeout
      );
      report.discovery = discoveries.map(({ name, status, error }) => ({ name, status, error }));
      globalThis.__jsc2js_inspector_discovered = discoveries
        .filter(item => item.status === 'ok')
        .map(item => item.value);
    }
    const exportsRemote = await evaluate(session, 'globalThis.__jsc2js_inspector_exports');
    const state = { seenFunctions: new Set(), seenObjects: new Set(), functions: new Map() };
    await collectTargetFunction(session, root, '$wrapper', state, rootScriptId);
    await collectTargetExportFunctions(session, exportsRemote, 'exports', state, rootScriptId);
    if (options.discover && report.moduleInitialization === 'completed') {
      const discoveredRemote = await evaluate(session, 'globalThis.__jsc2js_inspector_discovered');
      const discovered = await remoteProperties(session, discoveredRemote, true);
      for (const item of discovered) {
        if (!item.value) continue;
        await collectTargetExportFunctions(
          session, item.value, `discover.${item.name}`, state, rootScriptId
        );
      }
    }
    const closures = [];
    for (const item of state.functions.values()) {
      if (item.remote.objectId === root.objectId) continue;
      if (await remoteFunctionScriptId(session, item.remote) === rootScriptId) closures.push(item);
    }
    report.closureCount = closures.length;
    report.targetScriptId = rootScriptId;
    await dumpRemoteFunction(session, 'root', `${path.basename(absolute)}:$wrapper`, root, report);
    let ordinal = 0;
    for (const item of closures) {
      await dumpRemoteFunction(
        session, `closure-${ordinal++}`,
        `${path.basename(absolute)}:closure-${ordinal - 1}`, item.remote, report
      );
    }
    report.status = 'accepted';
  } catch (error) {
    report.status = 'error';
    report.error = String(error && error.stack || error);
  } finally {
    session.disconnect();
    delete globalThis.__jsc2js_get_bytecode;
    delete globalThis.__jsc2js_print_value;
    delete globalThis.__jsc2js_inspector_root;
    delete globalThis.__jsc2js_inspector_exports;
    delete globalThis.__jsc2js_inspector_discovered;
  }
  if (options.report) fs.writeFileSync(options.report, JSON.stringify(report, null, 2));
  console.error(`JSC2JS_INSPECTOR_LOCALS status=${report.status} closures=${report.closureCount || 0}`);
  if (report.status !== 'accepted') process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
