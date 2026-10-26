'use strict';

/*
 * Local Chromium DevTools bridge for Electron main processes.
 *
 * Some Electron distributions ignore Chromium's --remote-debugging-port even
 * when it is present at process startup. This module publishes a loopback-only
 * CDP-compatible target list and bridges one external DevTools client through
 * Electron's documented webContents.debugger API instead.
 *
 * It is deliberately application-agnostic: no filenames, game objects,
 * Bytenode details, or target-specific JavaScript are required.
 */

const crypto = require('node:crypto');
const http = require('node:http');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9222;
const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_SCRIPT_CACHE = 2048;

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function protocolUrl(host, port) {
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${port}`;
}

function encodeWebSocketFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function encodeWebSocketText(message) {
  return encodeWebSocketFrame(0x1, Buffer.from(JSON.stringify(message)));
}

function createClientWebSocketParser(handlers = {}) {
  let buffer = Buffer.alloc(0);
  let fragmentedOpcode = null;
  let fragments = [];

  const fail = message => {
    if (typeof handlers.onError === 'function') handlers.onError(Error(message));
  };

  const finishFragment = () => {
    const payload = Buffer.concat(fragments);
    const opcode = fragmentedOpcode;
    fragmentedOpcode = null;
    fragments = [];
    if (opcode === 0x1 && typeof handlers.onText === 'function') {
      handlers.onText(payload.toString('utf8'));
    }
  };

  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const first = buffer[0];
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < offset + 2) return;
          length = buffer.readUInt16BE(offset);
          offset += 2;
        } else if (length === 127) {
          if (buffer.length < offset + 8) return;
          const bigintLength = buffer.readBigUInt64BE(offset);
          if (bigintLength > BigInt(MAX_WS_MESSAGE_BYTES)) {
            fail('WebSocket message exceeds the bridge limit');
            return;
          }
          length = Number(bigintLength);
          offset += 8;
        }
        if (!masked) {
          fail('Client WebSocket frames must be masked');
          return;
        }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        offset += 4;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
        buffer = buffer.subarray(offset + length);

        if (opcode === 0x8) {
          if (typeof handlers.onClose === 'function') handlers.onClose(payload);
          continue;
        }
        if (opcode === 0x9) {
          if (typeof handlers.onPing === 'function') handlers.onPing(payload);
          continue;
        }
        if (opcode === 0xa) continue;
        if (opcode === 0x1 || opcode === 0x2) {
          if (fragmentedOpcode !== null) {
            fail('Unexpected new WebSocket data frame during a fragmented message');
            return;
          }
          if (fin) {
            if (opcode === 0x1 && typeof handlers.onText === 'function') handlers.onText(payload.toString('utf8'));
          } else {
            fragmentedOpcode = opcode;
            fragments = [payload];
          }
          continue;
        }
        if (opcode === 0x0) {
          if (fragmentedOpcode === null) {
            fail('Unexpected WebSocket continuation frame');
            return;
          }
          fragments.push(payload);
          if (Buffer.concat(fragments).length > MAX_WS_MESSAGE_BYTES) {
            fail('WebSocket message exceeds the bridge limit');
            return;
          }
          if (fin) finishFragment();
          continue;
        }
        fail(`Unsupported WebSocket opcode ${opcode}`);
        return;
      }
    }
  };
}

function makeTargetDescription(tracker, host, port) {
  const id = tracker.id;
  const base = protocolUrl(host, port);
  const path = `/devtools/page/${encodeURIComponent(id)}`;
  const contents = tracker.contents;
  const title = (() => {
    try { return tracker.window.getTitle() || 'Electron renderer'; } catch { return 'Electron renderer'; }
  })();
  const url = (() => {
    try { return contents.getURL() || 'about:blank'; } catch { return 'about:blank'; }
  })();
  const authority = `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
  return {
    id,
    type: 'page',
    title,
    url,
    description: 'Local Electron renderer bridged through webContents.debugger',
    devtoolsFrontendUrl: `devtools://devtools/bundled/inspector.html?ws=${authority}${path}`,
    webSocketDebuggerUrl: `${base.replace(/^http/, 'ws')}${path}`
  };
}

function makeTargetInfo(tracker) {
  const contents = tracker.contents;
  return {
    targetId: tracker.id,
    type: 'page',
    title: (() => {
      try { return tracker.window.getTitle() || 'Electron renderer'; } catch { return 'Electron renderer'; }
    })(),
    url: (() => {
      try { return contents.getURL() || 'about:blank'; } catch { return 'about:blank'; }
    })(),
    attached: true,
    canAccessOpener: false
  };
}

function sendHttp(response, statusCode, type, body) {
  response.writeHead(statusCode, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  response.end(body);
}

function defaultLog(level, message, details) {
  const writer = level === 'error' ? console.error : console.log;
  writer(`[electron-runtime-debug] ${message}`, details || '');
}

function installElectronRuntimeDebug(options = {}) {
  const electron = options.electron || require('electron');
  const app = options.app || electron.app;
  const shell = options.shell || electron.shell;
  if (!app || typeof app.on !== 'function') throw Error('Electron app EventEmitter is required');

  const host = options.host || DEFAULT_HOST;
  const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
  if (!isLoopbackHost(host) && options.allowNonLoopback !== true) {
    throw Error('Refusing non-loopback DevTools bridge host; set allowNonLoopback: true only after a security review');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('port must be an integer from 0 to 65535');

  const logger = typeof options.log === 'function' ? options.log : defaultLog;
  const windowFilter = typeof options.windowFilter === 'function' ? options.windowFilter : () => true;
  const shortcut = options.shortcut === false ? null : (options.shortcut || 'F12');
  const openOnShortcut = options.openOnShortcut !== false;
  let activePort = port;
  let bridgeUrl = protocolUrl(host, activePort);
  const trackers = new Map();
  const clients = new Map();
  let server = null;
  let closed = false;

  const log = (level, message, details) => {
    try { logger(level, message, details); } catch {}
  };

  const sendClient = (tracker, message) => {
    const socket = clients.get(tracker.id);
    if (!socket || socket.destroyed) return;
    try { socket.write(encodeWebSocketText(message)); } catch {}
  };

  const replayContexts = tracker => {
    for (const context of tracker.contexts.values()) {
      sendClient(tracker, { method: 'Runtime.executionContextCreated', params: { context } });
    }
    return tracker.contexts.size;
  };

  const replayScripts = tracker => {
    for (const script of tracker.scripts.values()) {
      sendClient(tracker, { method: 'Debugger.scriptParsed', params: script });
    }
    return tracker.scripts.size;
  };

  const respond = (tracker, message, result) => {
    if (message.id !== undefined) sendClient(tracker, { id: message.id, result: result || {} });
  };

  const reject = (tracker, message, error) => {
    if (message.id !== undefined) {
      sendClient(tracker, {
        id: message.id,
        error: { code: -32000, message: String(error && error.message || error) }
      });
    }
  };

  const targetInfos = () => [...trackers.values()].map(makeTargetInfo);

  const routeCommand = async (tracker, message) => {
    const contents = tracker.contents;
    try {
      if (message.method === 'Browser.getVersion') {
        return respond(tracker, message, {
          protocolVersion: '1.3',
          product: `Electron/${process.versions.electron}`,
          revision: '',
          userAgent: contents.getUserAgent(),
          jsVersion: process.versions.v8
        });
      }
      if (message.method === 'Target.getTargetInfo') {
        return respond(tracker, message, { targetInfo: targetInfos().find(info => info.targetId === tracker.id) || makeTargetInfo(tracker) });
      }
      if (message.method === 'Target.getTargets') return respond(tracker, message, { targetInfos: targetInfos() });
      if (message.method === 'Target.setDiscoverTargets' || message.method === 'Target.setAutoAttach' ||
          message.method === 'Target.setAttachToFrames') return respond(tracker, message, {});

      const result = await contents.debugger.sendCommand(message.method, message.params || {});
      respond(tracker, message, result);
      if (message.method === 'Runtime.enable') {
        log('info', 'replayed renderer execution contexts', { targetId: tracker.id, count: replayContexts(tracker) });
      } else if (message.method === 'Debugger.enable') {
        log('info', 'replayed cached renderer scripts', { targetId: tracker.id, count: replayScripts(tracker) });
      }
    } catch (error) {
      reject(tracker, message, error);
    }
  };

  const attachClient = (tracker, socket, head) => {
    const existing = clients.get(tracker.id);
    if (existing && !existing.destroyed) existing.destroy();
    clients.set(tracker.id, socket);
    const close = () => {
      if (clients.get(tracker.id) === socket) clients.delete(tracker.id);
    };
    const parser = createClientWebSocketParser({
      onText(text) {
        try { void routeCommand(tracker, JSON.parse(text)); } catch (error) { log('error', 'invalid DevTools protocol message', { message: String(error && error.message || error) }); }
      },
      onPing(payload) { try { socket.write(encodeWebSocketFrame(0xA, payload)); } catch {} },
      onClose() { try { socket.end(encodeWebSocketFrame(0x8, Buffer.alloc(0))); } catch {} },
      onError(error) { log('error', 'invalid DevTools WebSocket frame', { message: String(error && error.message || error) }); socket.destroy(); }
    });
    socket.on('data', chunk => parser.push(chunk));
    socket.once('close', close);
    socket.once('error', close);
    if (head && head.length) parser.push(head);
    log('info', 'DevTools client connected', { targetId: tracker.id });
  };

  const trackWindow = window => {
    if (closed || !window || typeof window.isDestroyed !== 'function' || window.isDestroyed()) return;
    try {
      if (!windowFilter(window)) return;
    } catch (error) {
      log('error', 'windowFilter threw while registering renderer', { message: String(error && error.message || error) });
      return;
    }
    const contents = window.webContents;
    if (!contents || contents.isDestroyed()) return;
    const id = `electron-${window.id}`;
    if (trackers.has(id)) return;
    const tracker = {
      id,
      window,
      contents,
      contexts: new Map(),
      scripts: new Map(),
      attachedByBridge: false
    };
    trackers.set(id, tracker);
    const onMessage = (_event, method, params) => {
      if (method === 'Runtime.executionContextCreated' && params && params.context) {
        tracker.contexts.set(params.context.id, params.context);
      } else if (method === 'Runtime.executionContextsCleared') {
        tracker.contexts.clear();
      } else if (method === 'Runtime.executionContextDestroyed' && params) {
        tracker.contexts.delete(params.executionContextId);
      } else if (method === 'Debugger.scriptParsed' && params && params.scriptId) {
        tracker.scripts.set(params.scriptId, params);
        if (tracker.scripts.size > MAX_SCRIPT_CACHE) tracker.scripts.delete(tracker.scripts.keys().next().value);
      }
      sendClient(tracker, { method, params });
    };
    contents.debugger.on('message', onMessage);
    try {
      if (!contents.debugger.isAttached()) {
        contents.debugger.attach('1.3');
        tracker.attachedByBridge = true;
      }
      void contents.debugger.sendCommand('Runtime.enable').catch(error => {
        log('error', 'could not enable Runtime domain', { targetId: id, message: String(error && error.message || error) });
      });
      void contents.debugger.sendCommand('Debugger.enable').catch(error => {
        log('error', 'could not enable Debugger domain', { targetId: id, message: String(error && error.message || error) });
      });
    } catch (error) {
      log('error', 'could not attach Electron debugger', { targetId: id, message: String(error && error.message || error) });
    }
    const dispose = () => {
      contents.debugger.removeListener('message', onMessage);
      const client = clients.get(id);
      if (client && !client.destroyed) client.destroy();
      clients.delete(id);
      trackers.delete(id);
      if (tracker.attachedByBridge && !contents.isDestroyed() && contents.debugger.isAttached()) {
        try { contents.debugger.detach(); } catch {}
      }
    };
    window.once('closed', dispose);
    log('info', 'Electron renderer registered for DevTools', { targetId: id });

    if (shortcut) {
      contents.on('before-input-event', (event, input) => {
        const key = String(input && input.key || '').toUpperCase();
        const matchesF12 = shortcut.toUpperCase() === 'F12' && input && input.type === 'keyDown' && key === 'F12';
        const matchesCtrlShiftI = shortcut.toUpperCase() === 'CTRL+SHIFT+I' && input && input.type === 'keyDown' && Boolean(input.control) && Boolean(input.shift) && key === 'I';
        if (!matchesF12 && !matchesCtrlShiftI) return;
        event.preventDefault();
        if (openOnShortcut && shell && typeof shell.openExternal === 'function') {
          void shell.openExternal(bridgeUrl);
        }
      });
    }
  };

  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, bridgeUrl).pathname;
    if (pathname === '/' || pathname === '/index.html') {
      const links = [...trackers.values()].map(tracker => {
        const target = makeTargetDescription(tracker, host, activePort);
        return `<li><a href="${target.devtoolsFrontendUrl.replace(/&/g, '&amp;')}">${target.title}</a> <code>${target.url}</code></li>`;
      }).join('') || '<li>No matching Electron renderer window is available yet.</li>';
      return sendHttp(response, 200, 'text/html; charset=utf-8', `<!doctype html><meta charset="utf-8"><title>Electron runtime debug</title><style>body{font:16px system-ui;margin:32px;max-width:900px}code{background:#eee;padding:2px 5px}a{font-weight:600}</style><h1>Electron runtime debug</h1><p>Loopback-only CDP bridge through <code>webContents.debugger</code>.</p><ul>${links}</ul><p>If your browser blocks a <code>devtools://</code> URL, add <code>${host}:${activePort}</code> in <code>chrome://inspect/#devices</code> and select <em>inspect</em>.</p>`);
    }
    if (pathname === '/json' || pathname === '/json/list') return sendHttp(response, 200, 'application/json; charset=utf-8', JSON.stringify([...trackers.values()].map(tracker => makeTargetDescription(tracker, host, activePort))));
    if (pathname === '/json/version') return sendHttp(response, 200, 'application/json; charset=utf-8', JSON.stringify({ Browser: `Electron/${process.versions.electron}`, 'Protocol-Version': '1.3' }));
    return sendHttp(response, 404, 'text/plain; charset=utf-8', 'Not found');
  });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, bridgeUrl).pathname;
    const match = /^\/devtools\/page\/([^/]+)$/.exec(pathname);
    const tracker = match && trackers.get(decodeURIComponent(match[1]));
    const key = request.headers['sec-websocket-key'];
    if (!tracker || typeof key !== 'string') { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    attachClient(tracker, socket, head);
  });
  server.once('error', error => log('error', 'local DevTools bridge failed', { host, port, message: String(error && error.message || error) }));
  server.listen(port, host, () => {
    const address = server.address();
    if (address && typeof address === 'object' && Number.isInteger(address.port)) {
      activePort = address.port;
      bridgeUrl = protocolUrl(host, activePort);
      controller.port = activePort;
      controller.url = bridgeUrl;
    }
    log('info', 'local DevTools bridge ready', { url: controller.url });
    if (closed && server.listening) server.close();
  });

  app.on('browser-window-created', (_event, window) => trackWindow(window));
  const trackExistingWindows = () => {
    const BrowserWindow = electron.BrowserWindow;
    if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') return;
    for (const window of BrowserWindow.getAllWindows()) trackWindow(window);
  };
  if (typeof app.isReady === 'function' && app.isReady()) queueMicrotask(trackExistingWindows);
  else app.once('ready', trackExistingWindows);
  app.once('will-quit', () => controller.close());

  const controller = {
    host,
    port: activePort,
    url: bridgeUrl,
    getTargets: () => [...trackers.values()].map(tracker => makeTargetDescription(tracker, host, activePort)),
    open: () => shell && typeof shell.openExternal === 'function' ? shell.openExternal(bridgeUrl) : Promise.reject(Error('Electron shell.openExternal is unavailable')),
    close() {
      if (closed) return;
      closed = true;
      for (const tracker of [...trackers.values()]) {
        const client = clients.get(tracker.id);
        if (client && !client.destroyed) client.destroy();
        if (!tracker.contents.isDestroyed() && tracker.attachedByBridge && tracker.contents.debugger.isAttached()) {
          try { tracker.contents.debugger.detach(); } catch {}
        }
      }
      trackers.clear();
      clients.clear();
      if (server && server.listening) server.close();
    }
  };
  return controller;
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  createClientWebSocketParser,
  encodeWebSocketFrame,
  encodeWebSocketText,
  installElectronRuntimeDebug,
  isLoopbackHost,
  makeTargetDescription,
  makeTargetInfo,
  protocolUrl
};
