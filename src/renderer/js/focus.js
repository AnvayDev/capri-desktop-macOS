// Focus Guard: you give her a stretch of time ("focus for 45 minutes on the API") and she keeps
// the distractions off you. A page on one of your distracting sites, or a distracting app, in front:
// she warns you, then closes the tab (like another AI's page) or hides the app. You can beg for five
// minutes, a few times, and she gets snippier each time. At the end, her victory, and how it went.
// Her menu › Focus Guard, or ask her in her chat. Pages are known by their domain only (macOS).

import { pick, fmt } from './util.js';

const NOTICE_MS = 2000;      // on a distraction this long: not just passing through
const WARN_MS = 6000;        // her warning, before she acts
const BEG_MS = 5 * 60 * 1000;
const BEGS = 3;              // more than this and she stops listening
const MIN = 60 * 1000;

const day = () => new Date().toISOString().slice(0, 10);
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export class Focus {
  constructor({ capri, panel, brain, bond, host }) {
    Object.assign(this, { capri, panel, brain, bond, host });
    this.session = null;    // { until, start, minutes, task, blocked, begs, allowed: { key: until }, claude, half, five }
    this.front = null;      // the distraction in front: { key, kind: 'site' | 'app', id, since, warned, acting }
    this.sites = [];
    this.apps = [];
    this.stats = null;
    setInterval(() => this.tick(), 1000);
  }

  get t() {
    return this.brain.t.focus;
  }

  get active() {
    return Boolean(this.session);
  }

  configure(cfg) {
    this.sites = (cfg.focusSites || []).map((s) => String(s).toLowerCase().replace(/^www\./, ''));
    this.apps = (cfg.focusApps || []).map((a) => String(a).toLowerCase());
    this.stats = cfg.focusStats || null;
  }

  // `quiet`: started from her chat, which says it itself
  start(minutes = 25, task = '', { quiet = false } = {}) {
    const m = Math.max(1, Math.min(240, Math.round(Number(minutes) || 25)));
    const now = Date.now();
    this.session = { start: now, until: now + m * MIN, minutes: m, task: String(task).slice(0, 40), blocked: 0, begs: 0, allowed: {}, claude: 0, half: false, five: false };
    this.front = null;
    this.capri.wake();
    if (!quiet) {
      this.panel.say({ kind: 'info', face: 'smug', line: fmt(task ? this.t.startTask : this.t.start, { minutes: m, task }), hold: 5000 });
      if (this.capri.free) this.capri.perform('hop');
    }
    return this.startLine(m, task);
  }

  startLine(m, task) {
    return fmt(task ? this.t.startTask : this.t.start, { minutes: m, task });
  }

  stop({ early = true } = {}) {
    const s = this.session;
    if (!s) return null;
    this.session = null;
    this.front = null;
    this.ticker(null);
    if (!early) return s;
    const minutes = Math.floor((Date.now() - s.start) / MIN);
    this.record(minutes, s.blocked, false);
    this.panel.say({ kind: 'info', face: 'aside', line: fmt(pick(this.t.stopped), { minutes }), hold: 4500 });
    return s;
  }

  // Claude at work meanwhile: counted for the recap
  onClaude(evt) {
    if (this.session && evt?.hook_event_name === 'PostToolUse') this.session.claude += 1;
  }

  // What's in front, from her window watch: { host, app, fg }
  onWindows({ host = null, app = '', fg = 0 } = {}) {
    const s = this.session;
    if (!s) return;
    const site = host && this.sites.find((d) => host === d || host.endsWith(`.${d}`) || host.replace(/^www\./, '') === d);
    const name = String(app).toLowerCase();
    const key = site ? `site:${site}` : this.apps.includes(name) ? `app:${name}` : null;
    if (!key) {
      if (this.front?.warned && !this.front.acting) this.panel.hide();
      this.front = null;
      return;
    }
    if (this.front?.key === key && this.front.id === fg) return;
    this.front = { key, kind: site ? 'site' : 'app', label: site || app, host: site, id: fg, since: Date.now(), warned: false, acting: false };
  }

  tick() {
    const s = this.session;
    if (!s) return;
    const now = Date.now();
    const left = s.until - now;
    if (left <= 0) return this.finish();
    this.ticker(`${clock(left)}${s.task ? ` · ${s.task}` : ''}`);
    if (!s.half && now - s.start >= (s.until - s.start) / 2 && s.minutes >= 10) {
      s.half = true;
      this.say(fmt(pick(this.t.half), { left: Math.round(left / MIN) }), 'look');
    }
    if (!s.five && left <= 5 * MIN && s.minutes >= 15) {
      s.five = true;
      this.say(pick(this.t.five), 'smug');
    }
    const f = this.front;
    if (!f || f.acting || (s.allowed[f.key] || 0) > now) return;
    const on = now - f.since;
    if (!f.warned && on >= NOTICE_MS) this.warn(f);
    else if (f.warned && on >= NOTICE_MS + WARN_MS) this.act(f);
  }

  // her countdown on the ticker, unless Claude's at work there
  ticker(text) {
    const cur = this.panel.tickerAction;
    if (cur && !cur.focus) return;
    this.panel.setTicker(text ? { verb: this.t.ticker, target: text, focus: true } : null);
  }

  say(line, face = 'look', hold = 4000) {
    if (!this.panel.visible || this.panel.current?.kind === 'idle') this.panel.say({ kind: 'info', face, line, hold });
  }

  warn(f) {
    const s = this.session;
    f.warned = true;
    const tier = Math.min(2, s.blocked + s.begs);
    this.capri.wake();
    if (this.capri.free) this.capri.perform('glare', this.capri.towardCenter());
    this.panel.say({
      kind: 'info', face: ['look', 'aside', 'wide'][tier], line: fmt(pick(this.t.warn[tier]), { site: f.label }), hold: null,
      actions: [
        { id: 'close', label: this.t.closeNow, primary: true },
        { id: 'beg', label: s.begs < BEGS ? this.t.beg : this.t.begNo },
      ],
      onAction: (id) => (id === 'close' ? this.act(f) : this.beg(f)),
    });
  }

  beg(f) {
    const s = this.session;
    if (!s || f !== this.front) return;
    if (s.begs >= BEGS) {
      this.panel.say({ kind: 'info', face: 'wide', line: pick(this.t.refused), hold: 2500 });
      return this.act(f);
    }
    s.begs += 1;
    s.allowed[f.key] = Date.now() + BEG_MS;
    this.capri.perform('huff', this.capri.towardCenter());
    this.panel.say({ kind: 'info', face: 'aside', line: fmt(pick(this.t.granted[Math.min(2, s.begs - 1)]), { site: f.label }), hold: 3500 });
    this.bond.feel?.('sulk', { rival: f.label });
  }

  // the tab closed (a zap at its window first), or the app put out of the way
  async act(f) {
    const s = this.session;
    if (!s || f !== this.front || f.acting) return;
    f.acting = true;
    let done = false;
    if (f.kind === 'site') {
      const win = this.capri.windows.wins.find((w) => w.id === f.id);
      const shut = () => this.host.focusCloseTab(f.id, f.host).then((why) => why === '', () => false);
      let res = win && this.capri.free ? await this.capri.zapShut(win, shut) : await shut();
      if (res === 'cut') res = await shut(); // her zap was cut short: the tab still goes
      done = res === true;
    } else {
      if (this.capri.free) this.capri.perform('zap', this.capri.towardCenter());
      done = await this.host.focusHideApp();
    }
    if (this.session !== s) return;
    if (done) {
      s.blocked += 1;
      this.panel.say({ kind: 'info', face: 'smug', line: fmt(pick(f.kind === 'site' ? this.t.closed : this.t.hidden), { site: f.label }), hold: 3500 });
    } else {
      this.panel.hide();
    }
    if (this.front === f) this.front = null;
  }

  finish() {
    const s = this.stop({ early: false });
    if (!s) return;
    this.record(s.minutes, s.blocked, true);
    const summary = fmt(this.t.summary, { minutes: s.minutes, blocked: s.blocked, begs: s.begs, claude: s.claude, streak: this.stats?.streak || 1 });
    const line = fmt(pick(s.begs ? this.t.doneBegged : this.t.done), { minutes: s.minutes, task: s.task });
    this.bond.add?.('focus', Math.min(15, Math.round(s.minutes / 3)));
    this.capri.wake();
    this.capri.celebrate({ onSpeak: () => this.panel.say({ kind: 'info', face: 'laugh', line, summary, hold: 12000 }) });
  }

  // today's focus, and the days in a row with a session done
  record(minutes, blocked, completed) {
    const today = day();
    const st = this.stats && this.stats.date === today ? { ...this.stats } : { date: today, minutes: 0, sessions: 0, blocked: 0, streak: this.stats?.streak || 0, last: this.stats?.last || null };
    st.minutes += minutes;
    st.blocked += blocked;
    if (completed) {
      st.sessions += 1;
      if (st.last !== today) {
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        st.streak = st.last === yesterday ? (st.streak || 0) + 1 : 1;
        st.last = today;
      }
    }
    this.stats = st;
    this.host.setConfig({ focusStats: st });
  }
}
