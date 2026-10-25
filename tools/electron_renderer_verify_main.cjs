'use strict';

// Browser-process side of the renderer-cache verifier.  It creates one hidden
// analysis renderer whose preload deserializes caches but never calls their
// CommonJS wrappers.  See electron_renderer_verify_preload.cjs.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const configPath = process.env.JSC2JS_RENDER_CONFIG;
if (!configPath) throw new Error('JSC2JS_RENDER_CONFIG is required');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!Array.isArray(config.files) || !config.files.length || !config.report) {
  throw new Error('config requires non-empty files and report');
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

let finished = false;
function finish(report) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(config.report, JSON.stringify(report, null, 2));
  process.exitCode = report.failed ? 1 : 0;
  app.quit();
}

ipcMain.once('jsc2js-renderer-verify-result', (_event, report) => finish(report));

app.whenReady().then(() => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'electron_renderer_verify_preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  window.loadURL('data:text/html,<meta charset=utf-8><title>jsc2js analysis</title>');
  setTimeout(() => finish({
    tool: 'electron_renderer_verify',
    status: 'error',
    failed: config.files.length,
    error: 'renderer verification timed out',
    results: []
  }), Number(config.timeoutMs || 120000));
}).catch(error => finish({
  tool: 'electron_renderer_verify',
  status: 'error',
  failed: config.files.length,
  error: String(error && error.stack || error),
  results: []
}));
