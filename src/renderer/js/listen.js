// Talking to her out loud: ⌃⌥T (or her menu) and she listens, until you stop talking (or press it
// again). What you said becomes text through Fish Audio (the key of her voice), goes into her chat,
// and her answer comes back out loud. Only while she listens is the microphone on.

import { fmt } from './util.js';

const RATE = 16000;        // what's sent: 16 kHz mono WAV, small and plenty for speech
const MAX_MS = 30000;      // one thing said at a time
const QUIET_MS = 1400;     // this long quiet after talking: you're done
const NOTHING_MS = 8000;   // nothing said at all: she stops listening
const LOUD = 0.018;        // the level (RMS) that counts as talking

// Float32 chunks at `rate` -> 16-bit PCM WAV at RATE
export function wav(chunks, rate) {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(length);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  const ratio = rate / RATE;
  const out = Math.floor(length / ratio);
  const buffer = new ArrayBuffer(44 + out * 2);
  const view = new DataView(buffer);
  const text = (offset, s) => [...s].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + out * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, out * 2, true);
  for (let i = 0; i < out; i++) {
    // the average of the samples this one stands for (a simple low-pass on the way down)
    const from = Math.floor(i * ratio);
    const to = Math.max(from + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to && j < length; j++) sum += all[j];
    const v = Math.max(-1, Math.min(1, sum / (to - from)));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

export class Listen {
  constructor({ host, panel, chat, brain, capri, speech }) {
    Object.assign(this, { host, panel, chat, brain, capri, speech });
    this.rec = null;
    this.hasKey = false;
  }

  get t() {
    return this.brain.t.listen;
  }

  configure(cfg) {
    this.hasKey = Boolean(cfg.fishKey);
  }

  toggle() {
    return this.rec ? this.finish() : this.start();
  }

  note(line, face = 'aside', hold = 4500) {
    this.panel.say({ kind: 'info', face, line, hold, silent: true });
  }

  async start() {
    if (!this.hasKey) return this.note(this.t.noKey, 'aside', 6000);
    if (!(await this.host.askMic())) return this.note(this.t.denied, 'wide', 7000);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      return this.note(fmt(this.t.failed, { error: err.message }), 'wide', 6000);
    }
    this.speech?.stop(); // not her own voice in what she hears
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const rec = { stream, ctx, source, node, chunks: [], started: performance.now(), talked: 0, quietSince: 0, spoke: false };
    this.rec = rec;
    node.onaudioprocess = (e) => {
      if (this.rec !== rec) return;
      const data = e.inputBuffer.getChannelData(0);
      rec.chunks.push(new Float32Array(data));
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const level = Math.sqrt(sum / data.length);
      this.panel.setProgress(Math.min(1, level * 12));
      const now = performance.now();
      if (level >= LOUD) {
        rec.spoke = true;
        rec.talked += (data.length / ctx.sampleRate) * 1000;
        rec.quietSince = 0;
      } else if (rec.spoke) {
        rec.quietSince ||= now;
      }
      if ((rec.spoke && rec.quietSince && now - rec.quietSince > QUIET_MS) || now - rec.started > MAX_MS || (!rec.spoke && now - rec.started > NOTHING_MS)) {
        this.finish();
      }
    };
    source.connect(node);
    node.connect(ctx.destination); // it only runs connected; what it puts out is silence
    this.capri.wake();
    if (this.capri.free) this.capri.perform('curious', this.capri.towardCenter());
    this.panel.say({ kind: 'info', face: 'look', line: this.t.listening, progress: 0, hold: null, silent: true });
  }

  async finish() {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    rec.node.onaudioprocess = null;
    rec.source.disconnect();
    rec.node.disconnect();
    rec.stream.getTracks().forEach((track) => track.stop());
    const rate = rec.ctx.sampleRate;
    rec.ctx.close().catch(() => {});
    this.panel.setProgress(null);
    if (rec.talked < 300) return this.note(this.t.nothing, 'aside', 3000);
    this.panel.say({ kind: 'info', face: 'look', line: this.t.thinking, hold: null, silent: true });
    const res = await this.host.hear(wav(rec.chunks, rate)).catch((err) => ({ ok: false, error: err.message }));
    if (!res?.ok) return this.note(fmt(this.t.failed, { error: res?.error || res?.code || '…' }), 'wide', 6000);
    const text = String(res.text || '').trim();
    if (!text) return this.note(this.t.nothing, 'aside', 3000);
    // into her chat, as if typed: she answers, out loud
    await this.chat.start();
    if (this.chat.open) this.chat.send(text);
  }
}
