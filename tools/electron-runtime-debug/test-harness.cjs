'use strict';

// A no-Electron integration harness for the bridge. It supplies only the
// documented app/window/webContents/debugger surface used by index.cjs and
// verifies the HTTP target list plus a late DevTools Runtime.enable replay.
const { EventEmitter } = require('node:events');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { installElectronRuntimeDebug } = require('./index.cjs');

class FakeDebugger extends EventEmitter {
  constructor() {
    super();
    this.attached = false;
  }
  isAttached() { return this.attached; }
  attach() { this.attached = true; }
  detach() { this.attached = false; }
  async sendCommand(method) {
    if (method === 'Runtime.enable') {
      this.emit('message', null, 'Runtime.executionContextCreated', {
        context: { id: 11, origin: 'app://example', name: 'Electron Isolated Context', auxData: { isDefault: false, type: 'isolated' } }
      });
    }
    if (method === 'Debugger.enable') {
      this.emit('message', null, 'Debugger.scriptParsed', { scriptId: '1', url: 'app://example/app.js' });
    }
    return {};
  }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.debugger = new FakeDebugger();
  }
  isDestroyed() { return false; }
  getURL() { return 'app://example/index.html'; }
  getUserAgent() { return 'fake-electron'; }
}

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.id = 7;
    this.webContents = new FakeWebContents();
  }
  isDestroyed() { return false; }
  getTitle() { return 'Harness renderer'; }
}

function request(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).once('error', reject);
  });
}

function websocket(port, path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    socket.once('connect', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    socket.once('data', chunk => {
      const separator = chunk.indexOf('\r\n\r\n');
      if (separator < 0) return reject(Error('incomplete WebSocket handshake'));
      const header = chunk.subarray(0, separator).toString('latin1');
      if (!header.startsWith('HTTP/1.1 101')) return reject(Error(`unexpected WebSocket handshake: ${header}`));
      resolve({ socket, head: chunk.subarray(separator + 4) });
    });
    socket.once('error', reject);
  });
}

async function main() {
  const app = new EventEmitter();
  app.isReady = () => true;
  const window = new FakeWindow();
  const electron = {
    app,
    shell: { openExternal: async () => '' },
    BrowserWindow: { getAllWindows: () => [window] }
  };
  const controller = installElectronRuntimeDebug({ electron, host: '127.0.0.1', port: 0, shortcut: false, log() {} });
  await new Promise(resolve => setTimeout(resolve, 30));
  const port = controller.port;
  if (!Number.isInteger(port) || port < 1) throw new Error('controller did not expose a bridge port');
  const targets = await request(port, '/json/list');
  const list = JSON.parse(targets.body);
  if (targets.status !== 200 || list.length !== 1 || list[0].id !== 'electron-7') {
    throw new Error(`unexpected target list: ${targets.status} ${targets.body}`);
  }
  if (!list[0].webSocketDebuggerUrl.includes(`:${port}/`)) {
    throw new Error(`target list retained the requested port instead of the active port: ${targets.body}`);
  }
  const { socket, head } = await websocket(port, '/devtools/page/electron-7');
  // A minimal masked Runtime.enable frame; parser behavior itself is covered by
  // unit tests. The bridge must reply then replay the cached isolated context.
  const command = Buffer.from(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
  const mask = Buffer.from([1, 2, 3, 4]);
  const payload = Buffer.from(command.map((value, index) => value ^ mask[index % 4]));
  socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | command.length]), mask, payload]));
  const records = [];
  let frameBuffer = Buffer.alloc(0);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('timed out waiting for replayed CDP contexts')), 1000);
    const consume = chunk => {
      frameBuffer = Buffer.concat([frameBuffer, chunk]);
      while (frameBuffer.length >= 2) {
        let length = frameBuffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (frameBuffer.length < offset + 2) return;
          length = frameBuffer.readUInt16BE(offset);
          offset += 2;
        } else if (length === 127) {
          if (frameBuffer.length < offset + 8) return;
          length = Number(frameBuffer.readBigUInt64BE(offset));
          offset += 8;
        }
        if (frameBuffer.length < offset + length) return;
        const text = frameBuffer.subarray(offset, offset + length).toString('utf8');
        frameBuffer = frameBuffer.subarray(offset + length);
        records.push(JSON.parse(text));
        if (records.some(record => record.id === 1) && records.some(record => record.method === 'Runtime.executionContextCreated' && record.params.context.name === 'Electron Isolated Context')) {
          clearTimeout(timer);
          resolve();
        }
      }
    };
    socket.on('data', consume);
    if (head.length) consume(head);
  });
  socket.destroy();
  controller.close();
  console.log(JSON.stringify({ port, records: records.length, replayedIsolatedContext: true }));
}

main().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
