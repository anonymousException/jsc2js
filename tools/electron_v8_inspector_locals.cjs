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
const {
  cacheForRuntime,
  createSandbox,
  runModuleWrapper,
  discoverReturnedFunctions,
  createTraceSink
} = require('./electron_v8_extract.cjs');

function parseArguments(argv) {
  const result = {
    file: null, report: null, traceFile: null, functionMatch: null,
    timeout: 1500, closureDepth: MAX_TARGET_GRAPH_DEPTH, discover: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--discover') {
      result.discover = true;
      continue;
    }
    if (argument === '--report' || argument === '--trace-file' ||
        argument === '--function-match' || argument === '--closure-depth' ||
        argument === '--timeout') {
      if (++index >= argv.length) throw new Error(`missing value for ${argument}`);
      if (argument === '--report') result.report = argv[index];
      else if (argument === '--trace-file') result.traceFile = argv[index];
      else if (argument === '--function-match') result.functionMatch = argv[index];
      else if (argument === '--closure-depth') result.closureDepth = Number(argv[index]);
      else result.timeout = Number(argv[index]);
      continue;
    }
    if (argument.startsWith('--') || result.file) throw new Error(`unexpected argument ${argument}`);
    result.file = argument;
  }
  if (!result.file) throw new Error('usage: electron_v8_inspector_locals.cjs [--discover] [--report FILE] [--trace-file FILE] [--function-match REGEXP] [--closure-depth 0-12] [--timeout MS] FILE.jsc');
  if (!Number.isInteger(result.timeout) || result.timeout < 1) throw new Error('timeout must be a positive integer');
  if (!Number.isInteger(result.closureDepth) || result.closureDepth < 0 || result.closureDepth > MAX_TARGET_GRAPH_DEPTH) {
    throw new Error(`closure depth must be an integer from 0 to ${MAX_TARGET_GRAPH_DEPTH}`);
  }
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

function materializeExportDiscoveries(context, moduleRecord, timeout, observations) {
  const candidates = [];
  collectExportedCallables(moduleRecord.exports, 'exports', new Set(), candidates);
  return discoverReturnedFunctions(
    context,
    candidates.map(({ name, value }) => ({ label: name, fn: value })),
    timeout,
    observations
  );
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
      const source = `${value.scriptId}:${value.lineNumber}:${value.columnNumber}`;
      const scopes = (properties.internalProperties || []).find(
        property => property.name === '[[Scopes]]'
      );
      if (scopes && scopes.value && scopes.value.objectId) {
        const scopeEntries = await remoteProperties(session, scopes.value, true);
        const closure = scopeEntries.find(entry =>
          /^\d+$/.test(entry.name || '') && entry.value && entry.value.objectId &&
          String(entry.value.description || '').startsWith('Closure')
        );
        // A lexical context identity distinguishes closures from the same
        // source position, while remaining stable when the same function is
        // reached again through `prototype.constructor` or a captured alias.
        if (closure) return `${source}:closure:${closure.value.objectId}`;
      }
      return source;
    }
  } catch {
    // Fall back to the object id below.
  }
  return remote && remote.objectId;
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
const MAX_TARGET_FUNCTIONS = 512;

function isIntrinsicFunctionProperty(name) {
  return name === 'arguments' || name === 'caller' ||
    name === 'length' || name === 'name';
}

async function collectTargetValue(session, remote, label, state, targetScriptId, depth = 0) {
  if (!remote || !remote.objectId || depth > state.maxDepth) return;
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
  if (!remote || remote.type !== 'function' || !remote.objectId || depth > state.maxDepth) return;
  if (await remoteFunctionScriptId(session, remote) !== targetScriptId) return;
  const identity = await remoteFunctionIdentity(session, remote);
  if (state.seenFunctions.has(identity)) return;
  if (state.functions.size >= MAX_TARGET_FUNCTIONS) {
    state.functionGraphTruncated = true;
    return;
  }
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

async function dumpRemoteFunction(session, key, label, remote, report, trace) {
  trace.write(`@@JSC2JS_FUNCTION_BEGIN ${JSON.stringify({ key, label })}`);
  trace.flush();
  let constantPoolLength;
  try {
    constantPoolLength = await primitiveCall(
      session,
      remote.objectId,
      'function () { const info = globalThis.__jsc2js_get_bytecode(this); return info === undefined ? -1 : info.constant_pool.length; }'
    );
  } catch (error) {
    report.functions.push({ key, label, status: 'get-bytecode-error', error: String(error.message || error) });
    trace.write(`@@JSC2JS_FUNCTION_END ${JSON.stringify({ key, status: 'error' })}`);
    return;
  }
  if (constantPoolLength === -1 || constantPoolLength === undefined) {
    report.functions.push({ key, label, status: 'no-bytecode' });
    trace.write(`@@JSC2JS_FUNCTION_END ${JSON.stringify({ key, status: 'no-bytecode' })}`);
    return;
  }
  report.functions.push({
    key,
    label,
    status: 'ok',
    identity: await remoteFunctionIdentity(session, remote),
    constantPoolLength
  });
  trace.flush();
  trace.write(`@@JSC2JS_FUNCTION_END ${JSON.stringify({ key, status: 'ok' })}`);
  trace.write(`@@JSC2JS_CONSTANTS_BEGIN ${JSON.stringify({ key, count: constantPoolLength })}`);
  trace.flush();
  for (let index = 0; index < constantPoolLength; index += 1) {
    trace.write(`@@JSC2JS_CONSTANT_INDEX ${JSON.stringify({ key, index })}`);
    trace.flush();
    await callOn(
      session,
      remote.objectId,
      'function (index) { %DebugPrint(globalThis.__jsc2js_get_bytecode(this).constant_pool[index]); }',
      [{ value: index }]
    );
    trace.flush();
  }
  trace.write(`@@JSC2JS_CONSTANTS_END ${JSON.stringify({ key })}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const functionMatcher = options.functionMatch ? new RegExp(options.functionMatch) : null;
  const absolute = path.resolve(options.file);
  const trace = createTraceSink(options.traceFile);
  const report = {
    tool: 'electron_v8_inspector_locals',
    file: absolute,
    runtime: { electron: process.versions.electron, v8: process.versions.v8 },
    discover: options.discover,
    traceFile: options.traceFile ? path.resolve(options.traceFile) : null,
    functionMatch: options.functionMatch,
    closureDepth: options.closureDepth,
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
    // The isolated extractor retains lifecycle/timer callbacks instead of
    // scheduling them.  Publish those actual JSFunction objects to Inspector
    // as additional roots: otherwise a startup handler passed directly to
    // app.whenReady().then(...) is not reachable from module.exports.
    globalThis.__jsc2js_inspector_callbacks = (initialized.callbacks || [])
      .map(entry => entry.callback)
      .filter(value => typeof value === 'function');
    if (options.discover && report.moduleInitialization === 'completed') {
      const discoveries = materializeExportDiscoveries(
        context, initialized.moduleRecord, options.timeout, report.observations
      );
      report.discovery = discoveries.discovered;
      // Preserve each recovered installer's origin in its Inspector property
      // path. The dynamic closures themselves are real target-script functions
      // and their [[Scopes]] reveal the private wrapper/decorator bodies that
      // plain exported-function traversal cannot reach.
      globalThis.__jsc2js_inspector_discovered = Object.fromEntries(
        discoveries.functions.map((item, index) => [`${index}:${item.label}`, item.fn])
      );
    }
    const exportsRemote = await evaluate(session, 'globalThis.__jsc2js_inspector_exports');
    const callbacksRemote = await evaluate(session, 'globalThis.__jsc2js_inspector_callbacks');
    const discoveredRemote = options.discover && report.moduleInitialization === 'completed'
      ? await evaluate(session, 'globalThis.__jsc2js_inspector_discovered')
      : null;
    const state = {
      seenFunctions: new Set(), seenObjects: new Set(), functions: new Map(),
      maxDepth: options.closureDepth
    };
    // Dynamic installer results are the reason for --discover. Traverse them
    // first, before the module wrapper's broad lexical graph consumes the
    // bounded closure budget.
    if (discoveredRemote) {
      const discovered = await remoteProperties(session, discoveredRemote, true);
      for (const item of discovered) {
        if (!item.value) continue;
        await collectTargetExportFunctions(
          session, item.value, `discover.${item.name}`, state, rootScriptId
        );
      }
    }
    await collectTargetFunction(session, root, '$wrapper', state, rootScriptId);
    await collectTargetExportFunctions(session, exportsRemote, 'exports', state, rootScriptId);
    for (const callback of await remoteProperties(session, callbacksRemote, true)) {
      if (!/^\d+$/.test(callback.name) || !callback.value) continue;
      await collectTargetFunction(
        session, callback.value, `callback.${callback.name}`, state, rootScriptId
      );
    }
    const closures = [];
    for (const item of state.functions.values()) {
      if (item.remote.objectId === root.objectId) continue;
      if (await remoteFunctionScriptId(session, item.remote) === rootScriptId) closures.push(item);
    }
    report.closureCount = closures.length;
    report.functionGraphTruncated = Boolean(state.functionGraphTruncated);
    report.targetScriptId = rootScriptId;
    await dumpRemoteFunction(session, 'root', `${path.basename(absolute)}:$wrapper`, root, report, trace);
    let ordinal = 0;
    for (const item of closures) {
      if (functionMatcher && !functionMatcher.test(item.label)) continue;
      const closureKey = `closure-${ordinal++}`;
      await dumpRemoteFunction(
        session, closureKey,
        `${path.basename(absolute)}:${item.label}`, item.remote, report, trace
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
    delete globalThis.__jsc2js_inspector_callbacks;
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
