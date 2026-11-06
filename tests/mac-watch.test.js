'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function watch(t, visible = true) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const processes = [], updates = [], writes = [];
  const overlay = Object.assign(new EventEmitter(), {
    destroyed: false, isDestroyed() { return this.destroyed; },
    isVisible: () => visible, getMediaSourceId: () => 'window:1:0',
    getBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
  });
  const mac = { spawnHelper() {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false,
      kill() { this.killed = true; this.emit('exit', 0); },
    });
    proc.stdin.on('data', (data) => writes.push(String(data)));
    processes.push(proc);
    return proc;
  } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/windows.js'), 'utf8'), {
    module, __dirname, process: { platform: 'darwin', pid: 123 },
    setTimeout, clearTimeout, console: { error() {} },
    require(name) {
      if (name === './mac') return mac;
      if (name === 'electron') return { screen: { getAllDisplays: () => [] } };
      return require(name);
    },
  });
  const watcher = module.exports.startWindowWatch({ overlay, onUpdate: (data) => updates.push(data) });
  t.after(() => { watcher.stop(); for (const proc of processes) { proc.stdout.end(); proc.stderr.end(); proc.stdin.end(); } });
  return { watcher, overlay, processes, updates, writes };
}

test('Mac watch delivers an AI page and correlates the close reply', async (t) => {
  const { watcher, processes, updates, writes } = watch(t);
  processes[0].stdout.write(JSON.stringify({ fg: 42, fgPid: 456, ai: ['chatgpt'], pages: ['chatgpt'], wins: [] }) + '\n');
  assert.equal(updates[0].pages[0], 'chatgpt');
  assert.equal(watcher.frontPid(), 456);
  const pending = watcher.close(42, 'chatgpt');
  assert.equal(writes[0], 'close 42 chatgpt 1\n');
  processes[0].stdout.write('{"closed":1,"why":""}\n');
  assert.equal(await pending, '');
  t.mock.timers.tick(3000);
  assert.equal(processes.length, 1);
});

test('stopping before the overlay is shown never starts a helper', (t) => {
  const { watcher, overlay, processes } = watch(t, false);
  watcher.stop();
  overlay.emit('show');
  assert.equal(processes.length, 0);
});

test('stopping after a helper crash cancels restart and clears stale Jealousy', async (t) => {
  const { watcher, processes, updates } = watch(t);
  const pending = watcher.close(42, 'chatgpt');
  processes[0].emit('exit', 1);
  assert.equal(await pending, 'gone');
  assert.equal(updates.at(-1).fg, 0);
  assert.equal(updates.at(-1).pages.length, 0);
  watcher.stop();
  t.mock.timers.tick(3000);
  assert.equal(processes.length, 1);
});

test('spawn errors are handled once and a destroyed overlay is never restarted', (t) => {
  const { overlay, processes } = watch(t);
  assert.doesNotThrow(() => processes[0].emit('error', new Error('ENOENT')));
  processes[0].emit('exit', 1);
  overlay.destroyed = true;
  t.mock.timers.tick(3000);
  assert.equal(processes.length, 1);
});

test('stop immediately resolves close requests even if no exit event arrives', async (t) => {
  const { watcher, processes } = watch(t);
  processes[0].kill = () => {};
  const pending = watcher.close(42, 'chatgpt');
  watcher.stop();
  assert.equal(await pending, 'gone');
  assert.equal(await watcher.close(42, 'chatgpt'), 'gone');
});

test('an unresponsive helper reports late', async (t) => {
  const { watcher } = watch(t);
  const pending = watcher.close(42, 'chatgpt');
  t.mock.timers.tick(3000);
  assert.equal(await pending, 'late');
});

test('a broken helper pipe resolves pending requests and stops the old process', async (t) => {
  const { watcher, processes } = watch(t);
  const pending = watcher.close(42, 'chatgpt');
  processes[0].stdin.emit('error', new Error('EPIPE'));
  assert.equal(await pending, 'gone');
  assert.equal(processes[0].killed, true);
  t.mock.timers.tick(3000);
  assert.equal(processes.length, 2);
});
