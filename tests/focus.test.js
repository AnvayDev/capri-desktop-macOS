'use strict';

// Focus Guard (focus.js) and the recording sent when you talk to her (listen.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// what util.js reads from the page when it loads
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} });

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', file)));

function stage() {
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  const realInterval = global.setInterval;
  global.setInterval = () => 0;
  const said = [];
  const calls = { closed: [], hidden: 0, config: [], celebrate: 0 };
  const panel = {
    visible: false, current: null, tickerAction: null,
    say(msg) { said.push(msg); this.current = msg; this.visible = true; return true; },
    hide() { this.visible = false; },
    setTicker(a) { this.tickerAction = a; },
  };
  const capri = {
    free: true, windows: { wins: [{ id: 7, x: 0, y: 0, w: 800, h: 600 }] },
    wake() {}, perform() {}, towardCenter: () => 1,
    zapShut: async (_win, hit) => hit(),
    celebrate({ onSpeak }) { calls.celebrate += 1; onSpeak(); },
  };
  const host = {
    focusCloseTab: async (id, host) => { calls.closed.push([id, host]); return ''; },
    focusHideApp: async () => { calls.hidden += 1; return true; },
    setConfig: (patch) => calls.config.push(patch),
  };
  const restore = () => { Date.now = realNow; global.setInterval = realInterval; };
  return { panel, capri, host, said, calls, restore, advance: (ms) => { now += ms; } };
}

const T = {
  focus: {
    ticker: 'FOCUS', start: 'start {minutes}', startTask: 'start {minutes} {task}', warn: [['w0 {site}'], ['w1 {site}'], ['w2 {site}']],
    closeNow: 'close', beg: 'beg', begNo: 'please', granted: [['g0'], ['g1'], ['g2']], refused: ['no'], closed: ['closed {site}'],
    hidden: ['hidden {site}'], half: ['half'], five: ['five'], stopped: ['stopped {minutes}'], done: ['done {minutes}'],
    doneBegged: ['begged {minutes}'], summary: '{minutes}|{blocked}|{begs}|{claude}|{streak}',
  },
};

test('Focus Guard: a distracting site gets a warning, then its tab is closed', async () => {
  const { Focus } = await load('focus.js');
  const s = stage();
  try {
    const f = new Focus({ capri: s.capri, panel: s.panel, brain: { t: T }, bond: { add() {}, feel() {} }, host: s.host });
    f.configure({ focusSites: ['youtube.com'], focusApps: ['Discord'] });
    f.start(30, 'the API');
    assert.strictEqual(s.said.at(-1).line, 'start 30 the API');
    f.onWindows({ host: 'www.youtube.com', app: 'Safari', fg: 7 });
    s.advance(1000); f.tick();
    assert.ok(!s.said.some((m) => m.line?.startsWith('w0')), 'passing through is not a distraction');
    s.advance(1500); f.tick();
    assert.strictEqual(s.said.at(-1).line, 'w0 youtube.com');
    s.advance(6500); f.tick();
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(s.calls.closed, [[7, 'youtube.com']]);
    assert.strictEqual(s.said.at(-1).line, 'closed youtube.com');
    assert.strictEqual(f.session.blocked, 1);
    assert.strictEqual(s.panel.tickerAction.verb, 'FOCUS');
    assert.match(s.panel.tickerAction.target, /· the API$/);
    // a page that isn't on the list: nothing
    f.onWindows({ host: 'github.com', app: 'Safari', fg: 7 });
    s.advance(20000); f.tick();
    assert.strictEqual(s.calls.closed.length, 1);
  } finally {
    s.restore();
  }
});

test('Focus Guard: begging buys five minutes a few times, then she stops listening; apps get hidden', async () => {
  const { Focus } = await load('focus.js');
  const s = stage();
  try {
    const f = new Focus({ capri: s.capri, panel: s.panel, brain: { t: T }, bond: { add() {}, feel() {} }, host: s.host });
    f.configure({ focusSites: ['reddit.com'], focusApps: ['Discord'] });
    f.start(60);
    for (let i = 0; i < 3; i++) {
      f.onWindows({ host: null, app: 'Safari', fg: 1 });
      f.onWindows({ host: 'reddit.com', app: 'Safari', fg: 7 });
      s.advance(2100); f.tick();
      s.said.at(-1).onAction('beg');
      assert.strictEqual(s.said.at(-1).line, `g${i}`);
      s.advance(60 * 1000); f.tick();
      assert.strictEqual(s.calls.closed.length, 0, 'allowed for five minutes');
      s.advance(5 * 60 * 1000);
    }
    f.onWindows({ host: null, app: 'Safari', fg: 1 });
    f.onWindows({ host: 'reddit.com', app: 'Safari', fg: 7 });
    s.advance(2100); f.tick();
    s.said.at(-1).onAction('beg'); // a fourth time: no
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(s.calls.closed.length, 1);
    f.onWindows({ host: null, app: 'Discord', fg: 9 });
    s.advance(2100); f.tick();
    s.said.at(-1).onAction('close');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(s.calls.hidden, 1);
    assert.strictEqual(s.said.at(-1).line, 'hidden Discord');
  } finally {
    s.restore();
  }
});

test('Focus Guard: the end brings her victory, the recap, and the streak', async () => {
  const { Focus } = await load('focus.js');
  const s = stage();
  try {
    let gained = 0;
    const f = new Focus({ capri: s.capri, panel: s.panel, brain: { t: T }, bond: { add: (_k, n) => { gained += n; }, feel() {} }, host: s.host });
    f.configure({ focusSites: [], focusApps: [], focusStats: { date: '2000-01-01', minutes: 0, sessions: 0, blocked: 0, streak: 4, last: new Date(Date.now() - 86400000).toISOString().slice(0, 10) } });
    f.start(25);
    f.onClaude({ hook_event_name: 'PostToolUse' });
    f.onClaude({ hook_event_name: 'PostToolUse' });
    s.advance(25 * 60 * 1000 + 1000); f.tick();
    assert.strictEqual(s.calls.celebrate, 1);
    assert.strictEqual(s.said.at(-1).line, 'done 25');
    assert.strictEqual(s.said.at(-1).summary, '25|0|0|2|5');
    assert.ok(gained > 0);
    assert.strictEqual(s.calls.config.at(-1).focusStats.streak, 5);
    assert.strictEqual(f.active, false);
    assert.strictEqual(s.panel.tickerAction, null);
  } finally {
    s.restore();
  }
});

test('talking to her: the recording goes out as 16 kHz mono 16-bit WAV', async () => {
  const { wav } = await load('listen.js');
  const second = new Float32Array(48000).map((_, i) => Math.sin(i / 10) * 0.5);
  const bytes = wav([second.subarray(0, 24000), second.subarray(24000)], 48000);
  const view = new DataView(bytes.buffer);
  const text = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
  assert.strictEqual(text(0, 4), 'RIFF');
  assert.strictEqual(text(8, 4), 'WAVE');
  assert.strictEqual(view.getUint16(22, true), 1, 'mono');
  assert.strictEqual(view.getUint32(24, true), 16000, '16 kHz');
  assert.strictEqual(view.getUint16(34, true), 16, '16-bit');
  assert.strictEqual(view.getUint32(40, true), 16000 * 2, 'one second of audio');
  assert.strictEqual(bytes.length, 44 + 32000);
});
