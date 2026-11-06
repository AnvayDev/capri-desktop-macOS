'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Exercise main.js with Electron windows that throw on use after destruction, just like Electron.
function main(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ready, stopped = 0;
  const cfg = { assistant: 'claude' }, handled = new Map(), windows = [], sent = [], permissions = [];
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true, whenReady: () => ({ then(fn) { ready = fn; } }),
    getPath: () => '/capri-test-no-user-data', dock: { hide() {} }, isPackaged: false,
  });
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.bounds = options; this.destroyed = false;
      this.contents = Object.assign(new EventEmitter(), {
        isDestroyed: () => this.destroyed, send: (...args) => { this.check(); sent.push(args); },
      });
      windows.push(this);
    }
    check() { if (this.destroyed) throw new TypeError('Object has been destroyed'); }
    get webContents() { this.check(); return this.contents; }
    isDestroyed() { return this.destroyed; }
    setBounds(bounds) { this.check(); this.bounds = bounds; }
    getBounds() { this.check(); return this.bounds; }
    setAlwaysOnTop() { this.check(); }
    setIgnoreMouseEvents() { this.check(); }
    setVisibleOnAllWorkspaces() { this.check(); }
    loadURL() { this.check(); }
    showInactive() { this.check(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 20, width: 1000, height: 760 } };
  const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => [display], getPrimaryDisplay: () => display });
  const electron = {
    app, BrowserWindow: Window, screen, powerMonitor: new EventEmitter(),
    ipcMain: Object.assign(new EventEmitter(), { handle: (name, fn) => handled.set(name, fn) }),
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    globalShortcut: { register() {}, unregisterAll() {} },
    shell: { openExternal: async (url) => permissions.push(url) },
    dialog: { showMessageBox: (options) => permissions.push(options.detail) },
  };
  const deps = {
    './config': { load: () => cfg, save: (patch) => Object.assign(cfg, patch) },
    './labels': {}, './bridge': { createBridge() {} },
    './windows': { startWindowWatch: () => ({ stop() { stopped++; }, refresh() {}, close: () => '' }) },
    './mac': { MAC: true, fixPath() {}, trusted: async (prompt) => { permissions.push(prompt); return false; } },
    './tabs': { askAccess: async () => ({ allowed: ['Safari'], denied: [], none: false }) },
    './llm': { restoreClaude() {} }, './assistants': { assistant: () => ({ id: 'claude' }) },
  };
  const module = { exports: {} };
  const context = vm.createContext({
    module, __dirname: path.join(__dirname, '../src/main'), process: { argv: [], env: {}, platform: 'darwin' },
    console, setTimeout, clearTimeout, require(name) {
      if (name === 'electron') return electron;
      if (name.startsWith('node:')) return require(name);
      return deps[name] || {};
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8') + `
    // Keep these tests independent of tray menus and model discovery.
    createTray = () => {}; rebuildTray = () => {}; refreshModels = () => {};
    module.exports = { fitOverlay, sendCommand, allowTabs, getOverlay: () => overlay };
  `, context);
  ready();
  return { ...module.exports, app, screen, handled, win: windows[0], cfg, sent, permissions, stopped: () => stopped };
}

test('display changes after overlay destruction do not reproduce the reported crash', (t) => {
  const h = main(t);
  h.win.destroy();
  assert.equal(h.getOverlay(), null);
  assert.equal(h.stopped(), 1);
  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
    assert.doesNotThrow(() => h.screen.emit(event));
  }
  assert.doesNotThrow(() => h.sendCommand('status'));
  assert.doesNotThrow(() => h.win.emit('ready-to-show'));
  assert.doesNotThrow(() => h.app.emit('window-all-closed'));
});

test('fit and sends ignore a destroyed object even before its closed callback runs', (t) => {
  const h = main(t);
  h.win.destroyed = true;
  assert.doesNotThrow(() => h.fitOverlay());
  assert.doesNotThrow(() => h.sendCommand('status'));
});

test('normal window close keeps Capri alive, while Quit releases her listeners', (t) => {
  const h = main(t);
  let prevented = false;
  h.win.emit('close', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  h.app.emit('before-quit');
  assert.equal(h.screen.listenerCount('display-metrics-changed'), 0);
  assert.equal(h.screen.listenerCount('display-added'), 0);
  assert.equal(h.screen.listenerCount('display-removed'), 0);
  prevented = false;
  h.win.emit('close', { preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  h.win.destroy();
  h.app.emit('will-quit');
});

test('a delayed screen move does not resize a closed window', async (t) => {
  const h = main(t);
  const pending = h.handled.get('screens:move')(null, 1);
  h.win.destroy();
  t.mock.timers.tick(60);
  assert.equal(await pending, null);
});

test('main process checks both Jealousy settings at the moment of closing', (t) => {
  const h = main(t);
  const close = () => h.handled.get('windows:closePage')(null, { id: 42, key: 'chatgpt' });
  assert.equal(close(), '');
  h.cfg.jealous = false;
  assert.equal(close(), 'disabled');
  h.cfg.jealous = true;
  h.cfg.closePages = false;
  assert.equal(close(), 'disabled');
});

test('tab access setup requests Accessibility and explains Automation separately', async (t) => {
  const h = main(t);
  await h.allowTabs();
  assert.equal(h.permissions[0], true);
  assert.match(h.permissions[1], /Privacy_Accessibility$/);
  assert.match(h.permissions[2], /For Jealousy, enable Capri.*Accessibility/);
});
