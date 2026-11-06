// Her voice: every line she says out loud, through Fish Audio (main process, speech.js). Each panel
// line as it shows up, and her chat answers once they're in. A new line cuts off the one before; a
// line added under an answer (what she did) is said on its own, not the answer again.

const MAX = 1500;

// what's said of a line: no code, no addresses, no markdown marks
function spoken(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_#>~|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX);
}

export class Speech {
  constructor(host) {
    this.host = host;
    this.on = false;      // her menu › Her voice, with a Fish Audio key set
    this.muted = false;
    this.volume = 0.7;
    this.audio = null;
    this.url = null;
    this.token = 0;
    this.answer = '';     // her chat answer said last, to say only what's added under it
    this.broken = null;   // why Fish Audio refused (a bad key, no credit): quiet until the settings change
    this.onError = null;  // (res) => void, once per refusal
  }

  configure(cfg) {
    const on = cfg.voice !== false && Boolean(cfg.fishKey);
    const changed = cfg.fishKey !== this.key || cfg.fishVoice !== this.voiceId || cfg.fishModel !== this.model;
    this.key = cfg.fishKey;
    this.voiceId = cfg.fishVoice;
    this.model = cfg.fishModel;
    if (changed) this.broken = null;
    this.on = on;
    this.muted = Boolean(cfg.muted);
    this.volume = typeof cfg.volume === 'number' ? cfg.volume : 0.7;
    if (!on || this.muted) this.stop();
  }

  // A line she says. `stream`: her chat answer, said once it's all in.
  async say(text, { stream = false } = {}) {
    let line = spoken(text);
    if (stream) {
      // the same answer with a line added under it: only the new part
      const before = this.answer;
      this.answer = line;
      if (before && line.startsWith(before)) line = line.slice(before.length).trim();
    } else {
      this.answer = '';
    }
    if (!line || !this.on || this.muted || this.broken) return;
    const token = ++this.token;
    this.stop();
    const res = await this.host.speak(line).catch((err) => ({ ok: false, error: err.message }));
    if (token !== this.token || !this.on || this.muted) return; // a newer line came meanwhile
    if (!res?.ok) {
      if (['auth', 'credit', 'nokey', 'bad'].includes(res?.code)) {
        this.broken = res.code;
        this.onError?.(res);
      }
      return;
    }
    this.play(res.audio);
  }

  play(bytes) {
    this.stop();
    this.url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
    const audio = new Audio(this.url);
    audio.volume = Math.max(0, Math.min(1, this.volume));
    audio.onended = () => this.stop();
    this.audio = audio;
    audio.play().catch(() => {});
  }

  stop() {
    this.audio?.pause();
    this.audio = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}
