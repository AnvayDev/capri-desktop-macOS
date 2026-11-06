'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function moduleUrl(file) {
  const source = fs.readFileSync(file, 'utf8').replace(/from '(\.\/[^']+)'/g,
    (_, relative) => `from '${moduleUrl(path.resolve(path.dirname(file), relative))}'`);
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

async function setup(t) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 100000 });
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  t.after(() => { delete globalThis.matchMedia; delete globalThis.localStorage; });
  const { Jealousy } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/bond.js')));
  const closed = [], messages = [];
  const win = { id: 42 };
  const capri = { windows: { wins: [win] }, stance: 'stand', mode: 'idle',
    jealous: async () => true, zapShut: async (_win, hit) => hit(), perform() {}, towardCenter: () => 1 };
  const panel = { visible: false, hide() {}, say: (message) => messages.push(message) };
  const brain = { assistant: 'claude', t: { jealous: {
    close: ['Closing {rival}'], download: ['Closing {rival}'], spared: ['Spared {rival}'],
    closed: ['Closed {rival}'], spare: 'Let me',
  } } };
  const bond = { stage: 0, feel() {} };
  const jealousy = new Jealousy({ capri, panel, brain, bond, chat: { open: false }, guide: { running: false },
    host: { closePage: async (id, key) => { closed.push({ id, key }); return ''; } } });
  jealousy.onWindows({ fg: 42, ai: ['chatgpt'], pages: ['chatgpt'] });
  return { jealousy, capri, win, closed, messages };
}

test('Jealousy warns and closes a detected rival tab after the dwell time', async (t) => {
  const { jealousy, closed, messages } = await setup(t);
  jealousy.noticed.chatgpt = Date.now();
  t.mock.timers.tick(10000);
  await Promise.resolve();
  assert.equal(messages[0].actions[0].id, 'spare');
  assert.equal(closed.length, 0);
  t.mock.timers.tick(3000);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.deepEqual(closed, [{ id: 42, key: 'chatgpt' }]);
  assert.equal(jealousy.last, 'closed');
});

test('Let me spares the tab and applies the cooldown', async (t) => {
  const { jealousy, closed } = await setup(t);
  const pending = jealousy.close(jealousy.front);
  await Promise.resolve();
  assert.equal(jealousy.spare(), true);
  await pending;
  assert.equal(jealousy.last, 'spared');
  assert.equal(closed.length, 0);
  assert.equal(jealousy.wait.chatgpt, Date.now() + 600000);
});

test('switching away during the warning leaves the new tab alone', async (t) => {
  const { jealousy, closed } = await setup(t);
  const pending = jealousy.close(jealousy.front);
  await Promise.resolve();
  jealousy.onWindows({ fg: 42, ai: [], pages: [] });
  t.mock.timers.tick(3000);
  await pending;
  assert.equal(jealousy.last, 'left');
  assert.equal(closed.length, 0);
});

for (const setting of ['enabled', 'closePages']) {
  test(`turning off ${setting} during the zap prevents the close request`, async (t) => {
    const { jealousy, capri, closed, win } = await setup(t);
    jealousy.warn = async () => false;
    capri.zapShut = async (_win, hit) => { jealousy[setting] = false; return hit(); };
    assert.equal(await jealousy.chase(jealousy.front, win), 'left');
    assert.equal(closed.length, 0);
  });
}

test('a title mention followed by an actual AI page starts a new dwell time', async (t) => {
  const { jealousy } = await setup(t);
  jealousy.onWindows({ fg: 42, ai: ['chatgpt'], pages: [] });
  const before = jealousy.front.since;
  t.mock.timers.setTime(before + 15000);
  jealousy.onWindows({ fg: 42, ai: ['chatgpt'], pages: ['chatgpt'] });
  assert.equal(jealousy.front.since, before + 15000);
});

test('the assistant she watches is not treated as a rival', async (t) => {
  const { jealousy } = await setup(t);
  jealousy.onWindows({ fg: 42, ai: ['claude'], pages: ['claude'] });
  assert.equal(jealousy.front, null);
});

test('re-enabling Jealousy notices the current tab without another helper update', async (t) => {
  const { jealousy, capri } = await setup(t);
  capri.windows = { fg: 42, ai: ['chatgpt'], pages: ['chatgpt'], wins: [{ id: 42 }] };
  jealousy.configure({ jealous: false });
  assert.equal(jealousy.front, null);
  jealousy.configure({ jealous: true });
  assert.equal(jealousy.front.key, 'chatgpt');
  assert.equal(jealousy.front.page, 'site');
  assert.equal(jealousy.front.since, Date.now());
});
