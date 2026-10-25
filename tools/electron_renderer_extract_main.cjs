'use strict';

// Browser-process coordinator for renderer-snapshot extraction. The target
// cache is deserialized only inside a hidden, separate analysis renderer.
// Root mode never invokes its wrapper; module/discover modes execute only in a
// hermetic VM sandbox created by the renderer preload.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const configPath = process.env.JSC2JS_RENDER_CONFIG;
if (!configPath) throw new Error('JSC2JS_RENDER_CONFIG is required');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!Array.isArray(config.files) || !config.files.length || !config.report) {
  throw new Error('config requires non-empty files and report');
}
if (config.mode !== undefined && !['root', 'module', 'discover', 'locals'].includes(config.mode)) {
  throw new Error('config.mode must be root, module, discover, or locals');
}
if (config.emit !== undefined && !['none', 'trace'].includes(config.emit)) {
  throw new Error('config.emit must be none or trace');
}
if (config.emit === 'trace' && !config.traceFile) {
  throw new Error('config.traceFile is required when config.emit is trace');
}

const RENDERER_ROOTS_KEY = '__jsc2js_renderer_inspector_roots';
const MAX_GRAPH_DEPTH = 12;
const MAX_GRAPH_OBJECTS = 4096;
const MAX_GRAPH_PROPERTIES = 1024;
const MAX_FUNCTIONS = 512;

function rendererAnalysisContext(wrapperExecution) {
  return {
    runtimeProcessType: 'renderer',
    cacheSnapshot: 'renderer',
    executionContext: 'isolated-analysis-vm',
    wrapperExecution
  };
}

function createRendererMarkerTrace(debuggerApi, markerRemote) {
  if (!markerRemote || !markerRemote.objectId) {
    return Object.freeze({ async write() {} });
  }
  return Object.freeze({
    async write(text) {
      await callRendererFunction(
        debuggerApi,
        markerRemote.objectId,
        'function (line) { this(line); }',
        [{ value: String(text) }]
      );
    }
  });
}

async function debuggerProperties(debuggerApi, remote, ownProperties = true) {
  if (!remote || !remote.objectId) return [];
  try {
    const response = await debuggerApi.sendCommand('Runtime.getProperties', {
      objectId: remote.objectId,
      ownProperties
    });
    return response.result || [];
  } catch {
    return [];
  }
}

async function debuggerInternalProperties(debuggerApi, remote) {
  if (!remote || !remote.objectId) return [];
  try {
    const response = await debuggerApi.sendCommand('Runtime.getProperties', {
      objectId: remote.objectId,
      ownProperties: false
    });
    return response.internalProperties || [];
  } catch {
    return [];
  }
}

async function functionScriptId(debuggerApi, remote) {
  const location = (await debuggerInternalProperties(debuggerApi, remote)).find(
    property => property.name === '[[FunctionLocation]]'
  );
  return location && location.value && location.value.value !== undefined
    ? String(location.value.value.scriptId)
    : null;
}

async function functionIdentity(debuggerApi, remote) {
  const internals = await debuggerInternalProperties(debuggerApi, remote);
  const location = internals.find(property => property.name === '[[FunctionLocation]]');
  if (location && location.value && location.value.value) {
    const value = location.value.value;
    return `${value.scriptId}:${value.lineNumber}:${value.columnNumber}:${remote.objectId}`;
  }
  return remote && remote.objectId;
}

function intrinsicFunctionProperty(name) {
  return name === 'arguments' || name === 'caller' || name === 'length' || name === 'name';
}

async function collectRendererValue(debuggerApi, remote, label, state, targetScriptId, depth = 0) {
  if (!remote || !remote.objectId || depth > state.maxDepth) return;
  if (remote.type === 'function') {
    await collectRendererFunction(debuggerApi, remote, label, state, targetScriptId, depth);
    return;
  }
  if (remote.type !== 'object' || state.seenObjects.has(remote.objectId) ||
      state.seenObjects.size >= MAX_GRAPH_OBJECTS) return;
  state.seenObjects.add(remote.objectId);
  await collectRendererOwnProperties(debuggerApi, remote, label, state, targetScriptId, depth + 1);
}

async function collectRendererOwnProperties(debuggerApi, remote, label, state, targetScriptId, depth) {
  const properties = await debuggerProperties(debuggerApi, remote, true);
  for (const property of properties.slice(0, MAX_GRAPH_PROPERTIES)) {
    if (remote.type === 'function' && intrinsicFunctionProperty(property.name)) continue;
    const childLabel = `${label}.${property.name}`;
    await collectRendererValue(debuggerApi, property.value, childLabel, state, targetScriptId, depth + 1);
    await collectRendererValue(debuggerApi, property.get, `${childLabel}<get>`, state, targetScriptId, depth + 1);
    await collectRendererValue(debuggerApi, property.set, `${childLabel}<set>`, state, targetScriptId, depth + 1);
  }
}

async function collectRendererClosureScopes(debuggerApi, remote, label, state, targetScriptId, depth) {
  const scopes = (await debuggerInternalProperties(debuggerApi, remote)).find(
    property => property.name === '[[Scopes]]'
  );
  if (!scopes || !scopes.value || !scopes.value.objectId) return;
  for (const scope of await debuggerProperties(debuggerApi, scopes.value, true)) {
    if (!/^\d+$/.test(scope.name) || !scope.value || !scope.value.objectId) continue;
    // Do not enumerate global/module scopes: only lexical closure contexts
    // belonging to the cached target function graph are in scope here.
    if (!String(scope.value.description || '').startsWith('Closure')) continue;
    for (const property of await debuggerProperties(debuggerApi, scope.value, true)) {
      if (!property.value || property.name === 'this') continue;
      await collectRendererValue(
        debuggerApi, property.value, `${label}::${property.name}`,
        state, targetScriptId, depth + 1
      );
    }
  }
}

async function collectRendererFunction(debuggerApi, remote, label, state, targetScriptId, depth = 0) {
  if (!remote || remote.type !== 'function' || !remote.objectId || depth > state.maxDepth) return;
  if (await functionScriptId(debuggerApi, remote) !== targetScriptId) return;
  const identity = await functionIdentity(debuggerApi, remote);
  if (state.seenFunctions.has(identity)) return;
  if (state.functions.size >= MAX_FUNCTIONS) {
    state.functionGraphTruncated = true;
    return;
  }
  state.seenFunctions.add(identity);
  state.functions.set(identity, { remote, label, identity });
  await collectRendererClosureScopes(debuggerApi, remote, label, state, targetScriptId, depth + 1);
  await collectRendererOwnProperties(debuggerApi, remote, label, state, targetScriptId, depth + 1);
}

async function callRendererFunction(debuggerApi, objectId, functionDeclaration, args = []) {
  const response = await debuggerApi.sendCommand('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration,
    arguments: args,
    returnByValue: false
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'renderer inspector call failed');
  return response.result;
}

async function primitiveRendererCall(debuggerApi, objectId, functionDeclaration, args = []) {
  const result = await callRendererFunction(debuggerApi, objectId, functionDeclaration, args);
  return Object.hasOwn(result, 'value') ? result.value : undefined;
}

async function rendererBytecodeValues(debuggerApi, remote) {
  const serialized = await primitiveRendererCall(
    debuggerApi,
    remote.objectId,
    'function () { const info = %GetBytecode(this); return info === undefined ? "" : JSON.stringify(Array.from(new Uint8Array(info.bytecode))); }'
  );
  if (typeof serialized !== 'string' || !serialized) return null;
  try {
    const values = JSON.parse(serialized);
    return Array.isArray(values) ? values : null;
  } catch {
    return null;
  }
}

async function rendererConstantSummary(debuggerApi, remote, index) {
  const value = await callRendererFunction(
    debuggerApi,
    remote.objectId,
    'function (index) { return %GetBytecode(this).constant_pool[index]; }',
    [{ value: index }]
  );
  const summary = { index, type: value.type };
  if (Object.hasOwn(value, 'value')) summary.value = value.value;
  if (value.subtype) summary.subtype = value.subtype;
  if (value.className) summary.className = value.className;
  if (value.description) summary.description = value.description;
  if (value.type === 'function' && value.objectId) {
    summary.functionScriptId = await functionScriptId(debuggerApi, value);
  }
  return summary;
}

async function dumpRendererFunction(debuggerApi, key, label, remote, report, trace) {
  await trace.write(`@@JSC2JS_FUNCTION_BEGIN ${JSON.stringify({ key, label })}`);
  let constantPoolLength;
  try {
    constantPoolLength = await primitiveRendererCall(
      debuggerApi,
      remote.objectId,
      'function () { const info = %GetBytecode(this); return info === undefined ? -1 : info.constant_pool.length; }'
    );
  } catch (error) {
    report.functions.push({ key, label, status: 'get-bytecode-error', error: String(error && error.message || error) });
    await trace.write(`@@JSC2JS_FUNCTION_END ${JSON.stringify({ key, status: 'error' })}`);
    return;
  }
  if (constantPoolLength === -1 || constantPoolLength === undefined) {
    report.functions.push({ key, label, status: 'no-bytecode' });
    await trace.write(`@@JSC2JS_FUNCTION_END ${JSON.stringify({ key, status: 'no-bytecode' })}`);
    return;
  }
  report.functions.push({
    key,
    label,
    status: 'ok',
    identity: await functionIdentity(debuggerApi, remote),
    constantPoolLength,
    bytecodeValues: await rendererBytecodeValues(debuggerApi, remote)
  });
  await trace.write(`@@JSC2JS_FUNCTION_END ${JSON.stringify({ key, status: 'ok' })}`);
  await trace.write(`@@JSC2JS_CONSTANTS_BEGIN ${JSON.stringify({ key, count: constantPoolLength })}`);
  for (let index = 0; index < constantPoolLength; index += 1) {
    await trace.write(`@@JSC2JS_CONSTANT_INDEX ${JSON.stringify({ key, index })}`);
    await callRendererFunction(
      debuggerApi,
      remote.objectId,
      'function (index) { %DebugPrint(%GetBytecode(this).constant_pool[index]); }',
      [{ value: index }]
    );
  }
  const functionReport = report.functions.at(-1);
  functionReport.constantPool = [];
  for (let index = 0; index < constantPoolLength; index += 1) {
    try {
      functionReport.constantPool.push(await rendererConstantSummary(debuggerApi, remote, index));
    } catch (error) {
      functionReport.constantPool.push({
        index,
        error: String(error && error.message || error)
      });
    }
  }
  await trace.write(`@@JSC2JS_CONSTANTS_END ${JSON.stringify({ key })}`);
}

async function findRendererRootContext(debuggerApi, contexts, stamp) {
  for (const [contextId] of contexts) {
    try {
      const response = await debuggerApi.sendCommand('Runtime.evaluate', {
        contextId,
        expression: `(() => { const roots = globalThis[${JSON.stringify(RENDERER_ROOTS_KEY)}]; return roots && roots.stamp || ''; })()`,
        returnByValue: true
      });
      if (response.result && response.result.value === stamp) return contextId;
    } catch {
      // A context can disappear during navigation; try the remaining ones.
    }
  }
  throw new Error('could not locate the renderer isolated analysis context');
}

async function rendererExpression(debuggerApi, contextId, expression) {
  const response = await debuggerApi.sendCommand('Runtime.evaluate', {
    contextId,
    expression,
    returnByValue: false
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'renderer evaluation failed');
  return response.result;
}

async function inspectPreparedRendererRoots(contents, prepared) {
  if (prepared.error) throw new Error(prepared.error);
  const reports = prepared.reports || [];
  const debuggerApi = contents.debugger;
  const contexts = new Map();
  const onMessage = (_event, method, params) => {
    if (method === 'Runtime.executionContextCreated' && params && params.context) {
      contexts.set(params.context.id, params.context);
    } else if (method === 'Runtime.executionContextsCleared') {
      contexts.clear();
    } else if (method === 'Runtime.executionContextDestroyed' && params) {
      contexts.delete(params.executionContextId);
    }
  };
  debuggerApi.on('message', onMessage);
  try {
    debuggerApi.attach('1.3');
    await debuggerApi.sendCommand('Runtime.enable');
    await new Promise(resolve => setTimeout(resolve, 0));
    const contextId = await findRendererRootContext(debuggerApi, contexts, prepared.stamp);
    const options = prepared.options || {};
    const matcher = config.functionMatch ? new RegExp(String(config.functionMatch)) : null;
    const markerRemote = await rendererExpression(debuggerApi, contextId, `${JSON.stringify(RENDERER_ROOTS_KEY)} in globalThis ? globalThis[${JSON.stringify(RENDERER_ROOTS_KEY)}].traceMarker : null`);
    const trace = createRendererMarkerTrace(debuggerApi, markerRemote);
    for (let index = 0; index < reports.length; index += 1) {
      const report = reports[index];
      report.analysisContext = rendererAnalysisContext('hermetic-sandbox-with-cdp-scopes');
      if (report.status !== 'accepted') continue;
      const prefix = `globalThis[${JSON.stringify(RENDERER_ROOTS_KEY)}].entries[${index}]`;
      const root = await rendererExpression(debuggerApi, contextId, `${prefix}.root`);
      if (!root || root.type !== 'function' || !root.objectId) {
        report.status = 'error';
        report.error = 'prepared renderer root is not a function';
        continue;
      }
      const targetScriptId = await functionScriptId(debuggerApi, root);
      if (!targetScriptId) {
        report.status = 'error';
        report.error = 'DevTools could not resolve the renderer root function location';
        continue;
      }
      const exportsRemote = await rendererExpression(debuggerApi, contextId, `${prefix}.exports`);
      const callbacksRemote = await rendererExpression(debuggerApi, contextId, `${prefix}.callbacks`);
      const globalFunctionsRemote = await rendererExpression(debuggerApi, contextId, `${prefix}.globalFunctions`);
      const discoveredRemote = await rendererExpression(debuggerApi, contextId, `${prefix}.discovered`);
      const state = {
        seenFunctions: new Set(),
        seenObjects: new Set(),
        functions: new Map(),
        maxDepth: options.closureDepth === undefined ? MAX_GRAPH_DEPTH : options.closureDepth
      };
      // Discoveries come first: dynamic installer closures otherwise lose their
      // place to a broad root lexical graph under the bounded function budget.
      await collectRendererValue(debuggerApi, discoveredRemote, 'discover', state, targetScriptId);
      await collectRendererFunction(debuggerApi, root, '$wrapper', state, targetScriptId);
      await collectRendererValue(debuggerApi, exportsRemote, 'exports', state, targetScriptId);
      await collectRendererValue(debuggerApi, callbacksRemote, 'callbacks', state, targetScriptId);
      await collectRendererValue(debuggerApi, globalFunctionsRemote, 'global', state, targetScriptId);
      const closures = [...state.functions.values()].filter(item => item.remote.objectId !== root.objectId);
      report.closureCount = closures.length;
      report.functionGraphTruncated = Boolean(state.functionGraphTruncated);
      report.targetScriptId = targetScriptId;
      await dumpRendererFunction(
        debuggerApi, 'root', `${path.basename(report.file)}:$wrapper`, root, report, trace
      );
      let ordinal = 0;
      for (const item of closures) {
        if (matcher && !matcher.test(item.label)) continue;
        await dumpRendererFunction(
          debuggerApi,
          `closure-${ordinal++}`,
          `${path.basename(report.file)}:${item.label}`,
          item.remote,
          report,
          trace
        );
      }
    }
  } finally {
    debuggerApi.removeListener('message', onMessage);
    if (debuggerApi.isAttached()) debuggerApi.detach();
  }
  return reports;
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
// Renderer processes have their own V8 isolate and do not reliably inherit
// browser-process command-line V8 flags.  The extractor preload uses only
// %GetBytecode/%DebugPrint on a wrapper it has materialized, never invokes it.
app.commandLine.appendSwitch('js-flags', '--allow-natives-syntax --print-bytecode');

let finished = false;
let analysisWindow = null;
function finish(report) {
  if (finished) return;
  finished = true;
  try {
    if (config.mode === 'locals' && analysisWindow && !analysisWindow.isDestroyed()) {
      analysisWindow.webContents.send('jsc2js-renderer-inspector-complete');
    }
  } catch {
    // The hidden renderer can already be gone when a timeout wins the race.
  }
  fs.writeFileSync(config.report, JSON.stringify(report, null, 2));
  process.exitCode = report.failed ? 1 : 0;
  app.quit();
}

if (config.mode === 'locals') {
  ipcMain.once('jsc2js-renderer-inspector-ready', async (_event, prepared) => {
    try {
      if (!analysisWindow || analysisWindow.isDestroyed()) {
        throw new Error('renderer analysis window was destroyed before inspection');
      }
      const results = await inspectPreparedRendererRoots(analysisWindow.webContents, prepared);
      const failed = results.filter(result => result.status !== 'accepted').length;
      finish({
        tool: 'electron_renderer_inspector_locals',
        runtime: { electron: process.versions.electron, v8: process.versions.v8, type: 'browser' },
        mode: 'locals',
        emit: prepared.options && prepared.options.emit || 'none',
        traceFile: config.traceFile || null,
        analysisContext: rendererAnalysisContext('hermetic-sandbox-with-cdp-scopes'),
        accepted: results.length - failed,
        failed,
        results
      });
    } catch (error) {
      const reports = prepared && prepared.reports || [];
      const results = reports.length ? reports.map(report => ({
        ...report,
        status: 'error',
        error: String(error && error.stack || error)
      })) : [{ status: 'error', error: String(error && error.stack || error), functions: [] }];
      finish({
        tool: 'electron_renderer_inspector_locals',
        mode: 'locals',
        accepted: 0,
        failed: results.length,
        error: String(error && error.stack || error),
        results
      });
    }
  });
} else {
  ipcMain.once('jsc2js-renderer-extract-result', (_event, report) => finish(report));
}

app.whenReady().then(() => {
  const inspectorLocals = config.mode === 'locals';
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(
        __dirname,
        inspectorLocals
          ? 'electron_renderer_inspector_preload.cjs'
          : 'electron_renderer_extract_preload.cjs'
      ),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  analysisWindow = window;
  window.loadURL('data:text/html,<meta charset=utf-8><title>jsc2js renderer extraction</title>');
  // timeoutMs bounds one target wrapper/closure operation. A module can have
  // hundreds of legitimate recovery roots, so its host-wide deadline must be
  // independent and substantially larger. Override it only with the explicit
  // hostTimeoutMs config field.
  const hostTimeoutMs = Number(config.hostTimeoutMs || 120000);
  setTimeout(() => finish({
    tool: 'electron_renderer_extract', status: 'error',
    failed: config.files.length, error: 'renderer extraction timed out', results: []
  }), Number.isInteger(hostTimeoutMs) && hostTimeoutMs > 0 ? hostTimeoutMs : 120000);
}).catch(error => finish({
  tool: 'electron_renderer_extract', status: 'error',
  failed: config.files.length, error: String(error && error.stack || error), results: []
}));
