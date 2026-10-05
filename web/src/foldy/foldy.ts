// Foldy, the helper. He lives only in a fixed panel at the bottom of every app window (Win.foldySlot), like McZee
// in 3D Movie Maker, and never on the desktop. Plain text next to him, typed out at its own pace while his mouth
// (the folder flap) talks. The animation is player.ts; the timing is timeline.ts; the art is sheet.ts.
//
// Public API (unchanged for callers): say, help, tip, mood, setFace, show, hide, enabled, hiddenForSession,
// applyEnabled, hideBalloon, glitchBurst, enterContext, startTutorial, startChatter, init. New: pain(), tuning().
import { h } from '../ui/dom';
import { ui, onScale } from '../ui/scale';
import { settings, setSubSettings, onSettings, reducedMotion } from '../settings';
import { windows, activeWin, onWm, type Win } from '../ui/wm';
import { jumbled, nonsense, presetLine, reaction, tip, tutorial, type ReactionId, type TutorialStep } from './lines';
import { Player, type Mood } from './player';
import { SPRITE_W, SPRITE_H } from './sheet';
import { sanitizeTiming, textDelay } from './timeline';
import * as bus from '../bus';

/** 'blink' is accepted for old callers and means 'normal'. */
export type Face = Mood | 'blink';

export interface SayAction {
  label: string;
  run: () => void;
}

export interface SayOpts {
  kind?: 'help' | 'tip' | 'chatter' | 'event' | 'tutorial' | 'reaction';
  mood?: Face;
  actions?: SayAction[];
  /** keep the message until the user closes it */
  sticky?: boolean;
  /** where the message makes sense ('simple', 'expert', 'editor', 'empty'): it is hidden when the user leaves */
  context?: string;
}

interface Panel {
  win: Win;
  canvas: HTMLCanvasElement;
  say: HTMLElement;
  text: HTMLElement;
  shown: Text;
  rest: Text;
  actions: HTMLElement;
  ok: HTMLButtonElement;
}

interface Message {
  text: string;
  opts: SayOpts;
  reveal: number;
  done: boolean;
}

/** Windows that always get his panel even though they are dialogs. */
const ALWAYS = new Set(['foldy-tuning']);

const toMood = (f: Face): Mood => (f === 'blink' ? 'normal' : f);

class Foldy {
  readonly player = new Player();
  private panels = new Map<Win, Panel>();
  private home: Win | null = null;
  private msg: Message | null = null;
  private pending: { text: string; opts: SayOpts } | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private moodTimer: ReturnType<typeof setTimeout> | null = null;
  private typing: ReturnType<typeof setTimeout> | null = null;
  private lastInput = Date.now();
  private clicks: number[] = [];
  private moodHold: Mood | null = null;
  private tutorialStep: TutorialStep | null = null;
  private undos: number[] = [];
  private helpOverride = false;
  hiddenForSession = false;

  /** `desktop` is accepted for the old call site; he no longer appears on it. */
  init(_desktop?: HTMLElement) {
    this.player.setTiming(sanitizeTiming(settings.foldyTiming));
    this.player.still = reducedMotion();
    onSettings((s, changed) => {
      if (changed.includes('foldyTiming')) this.player.setTiming(sanitizeTiming(s.foldyTiming));
      if (changed.includes('reducedMotion')) this.player.still = reducedMotion();
      if (changed.includes('foldy')) this.sync();
    });
    onScale(() => {
      for (const p of this.panels.values()) this.sizeCanvas(p.canvas);
      this.player.redraw();
    });
    onWm(() => this.sync());
    for (const ev of ['pointerdown', 'keydown'] as const)
      addEventListener(ev, () => {
        this.lastInput = Date.now();
        if (this.player.mood === 'asleep' && !this.moodHold) {
          this.setFace('normal');
          this.say(reaction('wake'), { kind: 'reaction' });
        }
      }, true);
    setInterval(() => {
      if (!this.msg && !this.moodHold && Date.now() - this.lastInput > 90_000 && this.player.mood !== 'asleep') {
        // his own line, if the user wrote one, first; the face stays asleep after it
        this.say(reaction('idle_asleep'), { kind: 'reaction', mood: 'asleep' });
        this.setFace('asleep');
      }
    }, 5000);
    // the hidden tuning panel
    addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyF') {
        e.preventDefault();
        e.stopPropagation();
        this.tuning();
      }
    }, true);
    this.wireBus();
    this.sync();
  }

  /** Opens the hidden timing panel (Ctrl+Shift+F). */
  tuning() {
    void import('./tuning').then((m) => m.openTuning());
  }

  applyEnabled() {
    if (!this.enabled && !this.helpOverride) this.hideBalloon(true);
    this.sync();
  }

  /** Bring him back (tray icon / Start menu / Help). */
  show() {
    this.hiddenForSession = false;
    if (!settings.foldy.enabled) setSubSettings('foldy', { enabled: true });
    this.applyEnabled();
    this.say(reaction('back'), { kind: 'reaction', mood: 'happy' });
  }

  hide() {
    this.hiddenForSession = true;
    this.applyEnabled();
  }

  get enabled() {
    return settings.foldy.enabled && !this.hiddenForSession;
  }

  // ------------------------------------------------------------ moods

  setFace(f: Face) {
    this.player.setMood(toMood(f));
  }

  /** Hold a mood (e.g. worried during a long carve) until released. */
  mood(f: Face | null) {
    this.moodHold = f ? toMood(f) : null;
    this.setFace(f ?? 'normal');
  }

  /** The pain glitch: he tears like a damaged JPEG, then winces. */
  pain() {
    if (!settings.foldy.glitches || reducedMotion()) return;
    this.player.painGlitch();
  }

  // ------------------------------------------------------------ panels (one per app window)

  private wantsPanel(w: Win): boolean {
    if (ALWAYS.has(w.id)) return true;
    if (w.opts.resizable === false || w.opts.modal) return false;
    return this.enabled || (this.helpOverride && w === this.pickHome());
  }

  private pickHome(): Win | null {
    const ok = (w: Win | null | undefined): w is Win => !!w && !w.minimized && (ALWAYS.has(w.id) || (w.opts.resizable !== false && !w.opts.modal));
    const all = windows();
    const a = activeWin();
    if (ok(a)) return a;
    if (this.home && all.includes(this.home) && ok(this.home)) return this.home;
    for (let i = all.length - 1; i >= 0; i--) if (ok(all[i])) return all[i];
    return null;
  }

  private sizeCanvas(c: HTMLCanvasElement) {
    const k = Math.max(1, ui.k);
    if (c.width !== SPRITE_W * k) c.width = SPRITE_W * k;
    if (c.height !== SPRITE_H * k) c.height = SPRITE_H * k;
  }

  private makePanel(w: Win): Panel {
    const canvas = h('canvas', { class: 'foldy-canvas', 'aria-hidden': 'true' });
    canvas.style.setProperty('width', SPRITE_W + 'px');
    canvas.style.setProperty('height', SPRITE_H + 'px');
    this.sizeCanvas(canvas);
    const face = h('button', { class: 'foldy-face', type: 'button', 'aria-label': 'Foldy the helper. Click for help.', 'data-tip': 'Foldy', onclick: () => this.onClick() }, canvas);
    const shown = document.createTextNode('');
    const rest = document.createTextNode('');
    // the unrevealed rest is laid out but invisible: the text never re-wraps while it is revealed
    const text = h('span', { class: 'tx foldy-text' }, shown, h('span', { class: 'foldy-rest' }, rest));
    const actions = h('div', { class: 'foldy-actions' });
    const say = h('div', { class: 'foldy-say', role: 'status' }, text, actions);
    say.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (this.player.talking) this.player.skip();
    });
    const ok = h('button', { class: 'btn small foldy-ok', type: 'button', 'aria-label': 'Hide Foldy’s message', onclick: () => this.hideBalloon() }, 'OK');
    w.foldySlot.replaceChildren(face, say, ok);
    w.foldySlot.classList.add('on');
    return { win: w, canvas, say, text, shown, rest, actions, ok };
  }

  private dropPanel(p: Panel) {
    this.player.detach(p.canvas);
    p.win.foldySlot.classList.remove('on', 'talking');
    p.win.foldySlot.replaceChildren();
    this.panels.delete(p.win);
  }

  /** Brings the panels in line with the open windows; the message follows the active app window. */
  private sync() {
    const open = new Set(windows());
    for (const p of [...this.panels.values()]) if (!open.has(p.win) || !this.wantsPanel(p.win)) this.dropPanel(p);
    for (const w of open)
      if (!this.panels.has(w) && this.wantsPanel(w)) {
        const p = this.makePanel(w);
        this.panels.set(w, p);
        this.player.attachStill(p.canvas);
        if (w === this.home) this.home = null; // rebuilt: attach it again below
      }
    const home = this.pickHome();
    const homeOk = home && this.panels.has(home) ? home : null;
    if (homeOk !== this.home) {
      const old = this.home ? this.panels.get(this.home) : undefined;
      if (old) {
        this.player.attachStill(old.canvas);
        this.renderText(old, null);
      }
      this.home = homeOk;
      if (homeOk) {
        const p = this.panels.get(homeOk)!;
        this.player.attach(p.canvas);
        this.renderText(p, this.msg);
      }
    }
    // a message that waited for a window
    if (this.home && this.pending) {
      const m = this.pending;
      this.pending = null;
      this.say(m.text, m.opts);
    }
  }

  private homePanel(): Panel | null {
    return this.home ? (this.panels.get(this.home) ?? null) : null;
  }

  private renderText(p: Panel, m: Message | null) {
    p.win.foldySlot.classList.toggle('talking', !!m);
    if (!m) {
      p.shown.data = '';
      p.rest.data = '';
      p.actions.replaceChildren();
      return;
    }
    p.shown.data = m.text.slice(0, m.reveal);
    p.rest.data = m.text.slice(m.reveal);
    p.actions.replaceChildren(...(m.opts.actions ?? []).map((a) => h('button', { class: 'btn small', type: 'button', onclick: () => a.run() }, a.label)));
  }

  private reveal(n: number) {
    const m = this.msg;
    if (!m) return;
    m.reveal = n;
    const p = this.homePanel();
    if (!p) return;
    p.shown.data = m.text.slice(0, n);
    p.rest.data = m.text.slice(n);
  }

  // ------------------------------------------------------------ talking

  private stopTyping() {
    if (this.typing) clearTimeout(this.typing);
    this.typing = null;
  }

  hideBalloon(_silent = false) {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.stopTyping();
    this.player.stopTalking();
    this.msg = null;
    this.pending = null;
    const p = this.homePanel();
    if (p) this.renderText(p, null);
    if (this.helpOverride) {
      this.helpOverride = false;
      this.sync();
    }
  }

  say(text: string, o: SayOpts = {}) {
    if (!this.enabled && !this.helpOverride) return;
    if (!text) return;
    const kind = o.kind ?? 'chatter';
    if (!this.home) {
      // no app window open: he speaks when one opens (only things worth waiting for)
      if (kind === 'help' || kind === 'tutorial' || o.sticky) this.pending = { text, opts: o };
      return;
    }
    const tutorial = kind === 'tutorial' || !settings.foldy.tutorialDone;
    const glitchy = settings.foldy.glitches && !tutorial && (kind === 'chatter' || kind === 'tip');
    // toned down: a rare bit of nonsense before a tip or chatter, never instead of it
    if (glitchy && Math.random() < 0.03) {
      const m = this.speak(nonsense(), { ...o, sticky: true }, () =>
        // only if the nonsense is still what he is showing: never over a message that arrived meanwhile
        setTimeout(() => this.msg === m && this.say(reaction('glitch_recover') + text, { ...o, kind: 'reaction' }), 1600),
      );
      return;
    }
    // rarer still: the words come out jumbled, then he glitches and gets them right
    if (glitchy && Math.random() < 0.01 && reaction('jumble') && text.includes(' ')) {
      const m = this.speak(jumbled(text), { ...o, sticky: true }, () =>
        setTimeout(() => {
          if (this.msg !== m) return;
          this.pain();
          this.speak(text, o);
        }, 600),
      );
      return;
    }
    this.speak(text, o);
  }

  private speak(text: string, o: SayOpts, then?: () => void): Message {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (this.moodTimer) clearTimeout(this.moodTimer);
    if (o.mood) this.setFace(o.mood);
    else if (!this.moodHold) this.setFace('normal');
    const m: Message = { text, opts: o, reveal: 0, done: false };
    this.msg = m;
    const p = this.homePanel();
    if (p) {
      this.renderText(p, m);
      p.say.scrollTop = 0;
    }
    // the text types on its own clock (pausing at punctuation); when it is all typed the line is over, so the
    // mouth stops with it. A skip (a click, reduced motion) forces the rest out at once.
    this.stopTyping();
    const type = () => {
      this.typing = null;
      if (this.msg !== m) return;
      this.reveal(m.reveal + 1);
      if (m.reveal >= text.length) return this.player.skip();
      this.typing = setTimeout(type, textDelay(text, m.reveal - 1, this.player.timing));
    };
    this.typing = setTimeout(type, this.player.timing.textCharMs);
    this.player.say(text, {
      onReveal: (n) => {
        if (n < text.length || this.msg !== m) return;
        this.stopTyping();
        this.reveal(n);
      },
      onDone: () => {
        m.done = true;
        if (this.msg !== m) return;
        then?.();
        this.finish(m);
      },
    });
    return m;
  }

  private finish(m: Message) {
    const o = m.opts;
    const t = this.player.timing;
    if (!o.sticky && !(o.actions && o.actions.length) && o.kind !== 'help') {
      this.hideTimer = setTimeout(() => this.msg === m && this.hideBalloon(), Math.max(t.lingerMs, m.text.length * 40));
    }
    if (!this.moodHold && o.mood && o.mood !== 'normal') this.moodTimer = setTimeout(() => !this.moodHold && this.setFace('normal'), t.moodHoldMs);
  }

  /** Explicit help: always readable and correct (no nonsense), stays until closed. Shown even when he is off. */
  help(text: string, actions?: SayAction[]) {
    if (!this.enabled) {
      this.helpOverride = true;
      this.sync();
    }
    this.say(text, { kind: 'help', actions, sticky: true });
  }

  tip() {
    this.say(tip(), { kind: 'tip' });
  }

  // ------------------------------------------------------------ clicks

  private onClick() {
    const now = Date.now();
    this.clicks = this.clicks.filter((t) => now - t < 1600);
    this.clicks.push(now);
    if (this.clicks.length >= 4 && settings.foldy.glitches) {
      this.clicks = [];
      this.glitchBurst();
      return;
    }
    if (this.player.talking) return this.player.skip();
    if (this.msg) return this.hideBalloon();
    const label = (id: ReactionId, fallback: string) => reaction(id) || fallback;
    this.say(label('click_greet', 'Hi. What can I do for you?'), {
      kind: 'reaction',
      mood: 'happy',
      actions: [
        { label: label('click_btn_why', 'Why does it look like that?'), run: () => bus.emit('explain-image') },
        { label: label('click_btn_tip', 'Give me a tip'), run: () => this.tip() },
        { label: label('click_btn_hide', 'Hide Foldy'), run: () => this.hide() },
      ],
    });
  }

  /** Poked too often: he glitches, then says something odd. */
  glitchBurst() {
    this.pain();
    setTimeout(() => this.say(reaction('click_spam', nonsense()), { kind: 'reaction', mood: 'shocked' }), this.player.still ? 0 : this.player.timing.painMs + this.player.timing.winceMs);
  }

  // ------------------------------------------------------------ reactions & tutorial

  private wireBus() {
    let longTimer: ReturnType<typeof setTimeout> | null = null;
    bus.on('long-start', (d) => {
      if (longTimer) clearTimeout(longTimer);
      longTimer = setTimeout(() => {
        this.mood('worried');
        // the progress dialog's own words, unless the user wrote a "working" line
        this.say(reaction('working', d?.say), { kind: 'reaction', mood: 'worried' });
      }, 1200);
    });
    bus.on('long-end', () => {
      if (longTimer) clearTimeout(longTimer);
      if (this.moodHold === 'worried') this.mood(null);
    });
    // lines the sheet marks "sometimes" / "rarely" (they are silent unless the user wrote them)
    const sometimes = () => Math.random() < 0.5;
    const rarely = () => Math.random() < 0.25;
    const react = (id: ReactionId, mood?: Face) => !this.msg && this.say(reaction(id), { kind: 'reaction', mood, context: 'simple' });
    bus.on('heavy-damage', (d?: { grey?: boolean }) => {
      this.pain();
      const id: ReactionId = d?.grey ? 'all_grey' : 'heavy_damage';
      if (!this.msg) setTimeout(() => !this.msg && this.say(reaction(id), { kind: 'reaction', mood: d?.grey ? 'worried' : 'shocked' }), this.player.still ? 0 : this.player.timing.painMs);
    });
    bus.on('error', () => this.pain());
    bus.on('unreadable', () => this.say(reaction('unreadable'), { kind: 'reaction', mood: 'worried' }));
    bus.on('exported', () => {
      if (!settings.foldy.tutorialDone) {
        this.say(tutorial('tut_done'), { kind: 'tutorial', mood: 'happy' });
        setSubSettings('foldy', { tutorialDone: true });
        this.tutorialStep = null;
      } else this.say(reaction('exported'), { kind: 'reaction', mood: 'happy' });
    });
    bus.on('photo-loaded', () => {
      if (this.msg?.opts.context === 'empty') this.hideBalloon();
      if (!settings.foldy.tutorialDone && !settings.expert && this.tutorialStep !== 'tut_pick' && this.tutorialStep !== 'tut_slider') {
        this.tutorialStep = 'tut_pick';
        this.say(tutorial('tut_pick'), { kind: 'tutorial', sticky: true, context: 'simple' });
      } else if (settings.foldy.tutorialDone && rarely()) react('photo_loaded');
    });
    bus.on('preset-chosen', (p) => {
      if (!settings.foldy.tutorialDone) {
        if (this.tutorialStep !== 'tut_slider') {
          this.tutorialStep = 'tut_slider';
          this.say(tutorial('tut_slider'), { kind: 'tutorial', sticky: true, context: 'simple' });
        }
      } else if (p?.foldy) this.say(presetLine(p), { kind: 'chatter', context: 'simple' });
    });
    bus.on('slider-end', (end: 'low' | 'max') => sometimes() && react(end === 'low' ? 'slider_low' : 'slider_max', end === 'max' ? 'shocked' : undefined));
    bus.on('another-roll', () => rarely() && react('another_roll'));
    bus.on('undo', () => {
      // "several times in a row": the third undo within 4 s
      const now = Date.now();
      this.undos = [...this.undos.filter((t) => now - t < 4000), now];
      if (this.undos.length >= 3 && rarely()) {
        this.undos = [];
        this.say(reaction('undo'), { kind: 'reaction' });
      }
    });
    bus.on('mode-changed', (mode: 'simple' | 'expert' | 'closed') => this.enterContext(mode));
  }

  /** The user moved somewhere else: a message about the old place no longer applies. */
  enterContext(mode: 'simple' | 'expert' | 'closed') {
    const c = this.msg?.opts.context;
    if (c && c !== mode) this.hideBalloon();
    if (mode === 'expert' && !settings.foldy.expertIntroDone) {
      setSubSettings('foldy', { expertIntroDone: true });
      this.say(tutorial('tut_steps'), { kind: 'tutorial', context: 'expert' });
    }
  }

  startTutorial(photoOpen = false) {
    if (settings.foldy.tutorialDone) return;
    if (photoOpen) {
      // a photo is already open (autosave): carry on from where the tour would be
      if (!settings.expert) {
        this.tutorialStep = 'tut_pick';
        setTimeout(() => this.say(tutorial('tut_pick'), { kind: 'tutorial', sticky: true, context: 'simple' }), 700);
      }
      return;
    }
    this.tutorialStep = 'hello';
    setTimeout(() => this.say(tutorial(ui.phone ? 'hello_phone' : 'hello'), { kind: 'tutorial', sticky: true, context: 'empty' }), 700);
  }

  /** Occasional unsolicited tips while the user works. */
  startChatter() {
    setInterval(() => {
      if (!settings.foldy.tutorialDone || this.msg || Date.now() - this.lastInput > 60_000) return;
      if (Math.random() < 0.35) this.tip();
    }, 75_000);
  }
}

export const foldy = new Foldy();
