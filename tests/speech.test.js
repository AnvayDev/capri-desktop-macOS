'use strict';

// Her voice: the Fish Audio request (main process) and what she says of each line (renderer).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const speech = require('../src/main/speech');

function fakeFetch(respond) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond(calls.length);
  };
  return calls;
}

const mp3 = (bytes = [1, 2, 3]) => ({ ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(bytes).buffer });

test('Fish Audio: the request its API expects, and repeated lines from the cache', async () => {
  const calls = fakeFetch(() => mp3());
  const audio = await speech.speak('  Hi, choom.  ', { key: 'k1', voice: 'abc123def456', model: 's1', language: 'en' });
  assert.deepStrictEqual([...audio], [1, 2, 3]);
  assert.strictEqual(calls[0].url, 'https://api.fish.audio/v1/tts');
  assert.strictEqual(calls[0].init.method, 'POST');
  assert.strictEqual(calls[0].init.headers.authorization, 'Bearer k1');
  assert.strictEqual(calls[0].init.headers.model, 's1');
  assert.deepStrictEqual(calls[0].body, { text: 'Hi, choom.', format: 'mp3', latency: 'balanced', reference_id: 'abc123def456', language: 'en' });
  await speech.speak('Hi, choom.', { key: 'k1', voice: 'abc123def456', model: 's1', language: 'en' });
  assert.strictEqual(calls.length, 1, 'the same line in the same voice is not paid for twice');
  await speech.speak('Hi, choom.', { key: 'k1', voice: 'other-voice-1', model: 's1' });
  assert.strictEqual(calls.length, 2, 'another voice is another line');
});

test('Fish Audio: no voice or unknown model sends neither, and refusals say why', async () => {
  const calls = fakeFetch(() => mp3());
  await speech.speak('Default voice.', { key: 'k', model: 'nope' });
  assert.ok(!('reference_id' in calls[0].body));
  assert.ok(!('model' in calls[0].init.headers));
  await assert.rejects(speech.speak('x', {}), (err) => err.code === 'nokey');
  for (const [status, code] of [[401, 'auth'], [402, 'credit'], [503, 'busy'], [400, 'bad']]) {
    fakeFetch(() => ({ ok: false, status, json: async () => ({ status, message: 'nope' }) }));
    await assert.rejects(speech.speak(`line ${status}`, { key: 'k' }), (err) => err.code === code && /nope/.test(err.message));
  }
  assert.strictEqual(await speech.speak('   ', { key: 'k' }), null);
});

test('her voice: each line once, only what is added under an answer, a new line cuts the old one', async () => {
  const { Speech } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'speech.js')));
  const said = [];
  const played = [];
  const host = { speak: async (text) => { said.push(text); return { ok: true, audio: new Uint8Array([9]) }; } };
  const s = new Speech(host);
  s.play = (bytes) => played.push(bytes);
  s.configure({ voice: true, fishKey: true, volume: 0.5 });
  await s.say('Hey. Look at `this` and https://example.com/x **now**');
  assert.deepStrictEqual(said, ['Hey. Look at this and now']);
  await s.say('Here is the answer.', { stream: true });
  await s.say('Here is the answer.\nOpened YouTube.', { stream: true });
  assert.deepStrictEqual(said.slice(1), ['Here is the answer.', 'Opened YouTube.']);
  await s.say('Same line twice.');
  await s.say('Same line twice.');
  assert.strictEqual(said.filter((t) => t === 'Same line twice.').length, 2, 'a line said again is said again');
  assert.strictEqual(played.length, said.length);

  // muted, or no key: nothing goes out
  const before = said.length;
  s.configure({ voice: true, fishKey: true, muted: true });
  await s.say('quiet');
  s.configure({ voice: true, fishKey: false });
  await s.say('no key');
  assert.strictEqual(said.length, before);

  // a slow line overtaken by a newer one is never played
  let release;
  const slow = new Speech({ speak: (text) => (text === 'slow' ? new Promise((r) => { release = r; }) : Promise.resolve({ ok: true, audio: new Uint8Array([2]) })) });
  const heard = [];
  slow.play = (b) => heard.push(b[0]);
  slow.configure({ voice: true, fishKey: true });
  const first = slow.say('slow');
  await slow.say('fast');
  release({ ok: true, audio: new Uint8Array([1]) });
  await first;
  assert.deepStrictEqual(heard, [2]);

  // a refused key: one error, then quiet until the settings change
  const errors = [];
  const bad = new Speech({ speak: async () => ({ ok: false, code: 'auth', error: 'bad key' }) });
  bad.onError = (res) => errors.push(res.code);
  bad.configure({ voice: true, fishKey: true });
  await bad.say('one');
  await bad.say('two');
  assert.deepStrictEqual(errors, ['auth']);
});

test('Fish Audio speech-to-text: the recording goes as a multipart upload, and only the words come back', async () => {
  let sent;
  global.fetch = async (url, init) => {
    sent = { url, init };
    return { ok: true, status: 200, json: async () => ({ text: '<|speaker:0|> focus for  45 minutes ', duration: 2 }) };
  };
  const text = await speech.hear(Uint8Array.from([82, 73, 70, 70]), { key: 'k', language: 'en' });
  assert.strictEqual(text, 'focus for 45 minutes');
  assert.strictEqual(sent.url, 'https://api.fish.audio/v1/asr');
  assert.strictEqual(sent.init.headers.authorization, 'Bearer k');
  assert.strictEqual(sent.init.headers.model, 'transcribe-1-pro');
  assert.ok(sent.init.body instanceof FormData);
  assert.strictEqual(sent.init.body.get('language'), 'en');
  assert.strictEqual(sent.init.body.get('diarize'), 'false');
  assert.ok(sent.init.body.get('audio') instanceof Blob);
  await assert.rejects(speech.hear(Uint8Array.from([1]), {}), (err) => err.code === 'nokey');
  global.fetch = async () => ({ ok: false, status: 402, json: async () => ({ message: 'no credit' }) });
  await assert.rejects(speech.hear(Uint8Array.from([1]), { key: 'k' }), (err) => err.code === 'credit');
});
