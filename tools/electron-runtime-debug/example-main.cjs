'use strict';

// Example only: place this before the application creates its first
// BrowserWindow. It does not alter the renderer or application state.
const { app, BrowserWindow } = require('electron');
const { installElectronRuntimeDebug } = require('./index.cjs');

installElectronRuntimeDebug({
  electron: require('electron'),
  host: '127.0.0.1',
  port: 9222,
  shortcut: 'F12',
  windowFilter: window => !window.isDestroyed()
});

app.whenReady().then(() => {
  const window = new BrowserWindow({
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  window.loadURL('https://example.invalid');
});
