'use strict';

// Her voice: every line she says, spoken by Fish Audio's text-to-speech (fish.audio), in the voice
// model you pick (its ID from fish.audio; none: Fish Audio's default voice). Your key stays here,
// encrypted like her other keys (setup.js); only the line's text goes to Fish Audio.

const API = 'https://api.fish.audio/v1/tts';
const MODELS = ['s2.1-pro', 's2.1-pro-free', 's2-pro', 's1'];
const MAX_CHARS = 1500;  // one line, or one of her chat answers
const CACHE = 80;        // lines she says again (her stock lines) aren't paid for twice

const cache = new Map(); // `${voice}|${model}|${text}` -> Buffer (mp3)

class SpeechError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // 'nokey', 'auth', 'credit', 'busy', 'net'
  }
}

// mp3 of `text`, said in voice `voice` (a Fish Audio model ID, or none) with model `model`
async function speak(text, { key, voice = '', model = '', language = '' } = {}) {
  const line = String(text || '').trim().slice(0, MAX_CHARS);
  if (!line) return null;
  if (!key) throw new SpeechError('no Fish Audio key', 'nokey');
  const id = `${voice}|${model}|${line}`;
  if (cache.has(id)) {
    const hit = cache.get(id);
    cache.delete(id);
    cache.set(id, hit); // used again: the last to go
    return hit;
  }
  const body = { text: line, format: 'mp3', latency: 'balanced' };
  if (voice) body.reference_id = voice;
  if (language) body.language = language;
  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        ...(MODELS.includes(model) && { model }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new SpeechError(`Fish Audio can't be reached (${err.message})`, 'net');
  }
  if (!res.ok) {
    let message = `Fish Audio answered ${res.status}`;
    try {
      const err = await res.json();
      if (err?.message) message = `Fish Audio: ${err.message}`;
    } catch {
      // not JSON
    }
    const code = res.status === 401 || res.status === 403 ? 'auth' : res.status === 402 ? 'credit' : res.status >= 500 || res.status === 429 ? 'busy' : 'bad';
    throw new SpeechError(message, code);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  cache.set(id, audio);
  while (cache.size > CACHE) cache.delete(cache.keys().next().value);
  return audio;
}

// What you said, from a recording (WAV): Fish Audio's speech-to-text, with the same key.
async function hear(wav, { key, language = '' } = {}) {
  if (!key) throw new SpeechError('no Fish Audio key', 'nokey');
  if (!wav?.length) return '';
  const form = new FormData();
  form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('ignore_timestamps', 'true');
  form.append('tag_audio_events', 'false');
  form.append('diarize', 'false');
  if (/^[a-z]{2}$/.test(language)) form.append('language', language);
  let res;
  try {
    res = await fetch('https://api.fish.audio/v1/asr', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, model: 'transcribe-1-pro' },
      body: form,
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    throw new SpeechError(`Fish Audio can't be reached (${err.message})`, 'net');
  }
  if (!res.ok) {
    let message = `Fish Audio answered ${res.status}`;
    try {
      const err = await res.json();
      if (err?.message) message = `Fish Audio: ${err.message}`;
    } catch {
      // not JSON
    }
    throw new SpeechError(message, res.status === 401 || res.status === 403 ? 'auth' : res.status === 402 ? 'credit' : 'bad');
  }
  const body = await res.json();
  return String(body.text || '').replace(/<\|[^|]*\|>/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { speak, hear, MODELS, SpeechError };
