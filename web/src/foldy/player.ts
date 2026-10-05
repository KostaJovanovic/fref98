// Foldy's player: ONE clock for everything he does (idle bob, blinks, talking, the pain glitch). It wakes only
// when the picture is due to change (setTimeout up to the next change, then one requestAnimationFrame), sleeps
// while nothing changes and stops while the tab is hidden. Each frame is composed at 1:1 from the sprite sheet
// and copied to the canvases at an integer scale: no layout work per frame.
import {
  DEFAULT_TIMING,
  blinkFrames,
  bobAt,
  bobStepMs,
  bobSteps,
  eventAt,
  nextEventTime,
  painDuration,
  painFrames,
  rng,
  talk,
  type FoldyTiming,
  type Lid,
  type PainFrame,
  type TalkPlan,
} from './timeline';
import { SPRITE_W, SPRITE_H, drawLayer, loadSheet } from './sheet';

export type Mood = 'normal' | 'happy' | 'worried' | 'shocked' | 'asleep' | 'think' | 'pain' | 'proud';

type BodyMouth = 'closed' | 'quarter' | 'half' | 'open';

/** Per mood: the mouth at rest, the eye layer, whether there is paper in the folder, whether he blinks. */
export const MOODS: Record<Mood, { rest: BodyMouth; eyes: string; paper: boolean; blinks: boolean }> = {
  normal: { rest: 'closed', eyes: 'eyes.open', paper: false, blinks: true },
  happy: { rest: 'quarter', eyes: 'eyes.happy', paper: true, blinks: false },
  proud: { rest: 'quarter', eyes: 'eyes.open', paper: true, blinks: true },
  worried: { rest: 'closed', eyes: 'eyes.worried', paper: false, blinks: true },
  shocked: { rest: 'open', eyes: 'eyes.shocked', paper: true, blinks: true },
  asleep: { rest: 'closed', eyes: 'eyes.closed', paper: false, blinks: false },
  think: { rest: 'closed', eyes: 'eyes.open.up', paper: false, blinks: true },
  pain: { rest: 'half', eyes: 'eyes.pain', paper: false, blinks: false },
};

export interface Pose {
  body: string;
  eyes: string;
  /** Folder offset. */
  dx: number;
  dy: number;
  /** Eye offset (the eyes float a beat behind the folder when bobbing). */
  ex: number;
  ey: number;
  tear: number;
  seed: number;
}

const bodyName = (m: BodyMouth, paper: boolean) => (paper && m !== 'closed' ? `body.${m}.paper` : `body.${m}`);
const now = () => performance.now();

export interface TalkCallbacks {
  onReveal?: (chars: number) => void;
  onDone?: () => void;
}

export class Player {
  timing: FoldyTiming = { ...DEFAULT_TIMING };
  /** Animation off (reduced motion): no bob, no blinks, lines appear at once. */
  still = false;
  private live = new Set<HTMLCanvasElement>();
  private mirrors = new Set<HTMLCanvasElement>();
  private buf: HTMLCanvasElement | null = null;
  private moodNow: Mood = 'normal';
  private plan: TalkPlan | null = null;
  private planT0 = 0;
  private cb: TalkCallbacks = {};
  private lastReveal = -1;
  private pain: PainFrame[] | null = null;
  private painT0 = 0;
  private idleT0 = now();
  private blinkAt = 0;
  private blinkT0 = -1;
  private blinkSeq: Lid[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private ticking = false;
  private lastKey = '';
  private hiddenAt = 0;
  private seed = 1;
  /** Every mouth frame drawn while talking, for tests: [ms since the line started, mouth]. */
  trace: [number, string][] | null = null;

  constructor() {
    this.scheduleBlink(now());
    void loadSheet().then(() => this.redraw(), () => {});
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', () => {
        const t = now();
        if (document.hidden) {
          this.hiddenAt = t;
          this.cancel();
        } else {
          // the clock stood still while hidden: talking and the glitch carry on where they were
          const d = this.hiddenAt ? t - this.hiddenAt : 0;
          this.hiddenAt = 0;
          this.planT0 += d;
          this.painT0 += d;
          this.idleT0 += d;
          this.blinkAt += d;
          if (this.blinkT0 >= 0) this.blinkT0 += d;
          this.wake();
        }
      });
  }

  // ------------------------------------------------------------ targets

  /** The canvas that shows him live (the panel he is talking in). */
  attach(c: HTMLCanvasElement) {
    this.mirrors.delete(c);
    this.live.add(c);
    this.redraw();
  }

  /** A canvas that shows him at rest (his panel in the other windows). */
  attachStill(c: HTMLCanvasElement) {
    this.live.delete(c);
    this.mirrors.add(c);
    this.drawStill(c);
  }

  detach(c: HTMLCanvasElement) {
    this.live.delete(c);
    this.mirrors.delete(c);
  }

  /** Draw everything again (new scale, sheet loaded, timing changed). */
  redraw() {
    this.lastKey = '';
    for (const c of this.mirrors) this.drawStill(c);
    this.wake();
  }

  // ------------------------------------------------------------ state

  get mood(): Mood {
    return this.moodNow;
  }

  setMood(m: Mood) {
    if (m === this.moodNow) return;
    this.moodNow = m;
    for (const c of this.mirrors) this.drawStill(c);
    this.wake();
  }

  setTiming(t: FoldyTiming) {
    this.timing = t;
    this.scheduleBlink(now());
    this.redraw();
  }

  get talking(): boolean {
    return !!this.plan;
  }

  /** Speaks a line (replacing any line in progress). */
  say(text: string, cb: TalkCallbacks = {}) {
    this.plan = talk(text, this.timing);
    this.planT0 = now();
    this.cb = cb;
    this.lastReveal = -1;
    if (this.trace) this.trace.length = 0;
    if (this.still) return this.skip();
    this.wake();
  }

  /** Finishes the line at once (a click on the text). */
  skip() {
    const p = this.plan;
    if (!p) return;
    this.plan = null;
    this.idleT0 = now();
    const cb = this.cb;
    this.cb = {};
    cb.onReveal?.(p.text.length);
    cb.onDone?.();
    this.wake();
  }

  /** Stops talking without finishing the line. */
  stopTalking() {
    this.plan = null;
    this.cb = {};
    this.idleT0 = now();
    this.wake();
  }

  /** The JPEG tear and the wince. */
  painGlitch() {
    if (this.still) return;
    this.pain = painFrames(this.timing, this.seed++);
    this.painT0 = now();
    this.wake();
  }

  // ------------------------------------------------------------ the clock

  private cancel() {
    if (this.timer) clearTimeout(this.timer);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.timer = null;
    this.raf = 0;
  }

  /** Runs a tick in the next animation frame (coalesced). */
  wake() {
    // inside a tick the tick itself schedules the next one
    if (this.ticking || (typeof document !== 'undefined' && document.hidden)) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.raf) this.raf = requestAnimationFrame(() => this.tick());
  }

  private tick() {
    this.raf = 0;
    this.ticking = true;
    try {
      this.step();
    } finally {
      this.ticking = false;
    }
  }

  private step() {
    const t = now();
    // a line that has run out
    if (this.plan && t - this.planT0 >= this.plan.duration) this.skip();
    if (this.pain && t - this.painT0 >= painDuration(this.timing)) {
      this.pain = null;
      this.idleT0 = t;
    }
    this.advanceBlink(t);
    const pose = this.poseAt(t);
    const key = `${pose.body}|${pose.eyes}|${pose.dx},${pose.dy}|${pose.ex},${pose.ey}|${pose.tear}|${pose.seed}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.draw(pose);
    }
    if (this.plan) {
      const e = eventAt(this.plan, t - this.planT0);
      if (this.trace && (!this.trace.length || this.trace[this.trace.length - 1][1] !== e.mouth)) this.trace.push([Math.round(t - this.planT0), e.mouth]);
      if (e.reveal !== this.lastReveal) {
        this.lastReveal = e.reveal;
        this.cb.onReveal?.(e.reveal);
      }
    }
    const next = this.nextChange(t);
    if (next === Infinity || (typeof document !== 'undefined' && document.hidden)) return;
    const delay = next - now();
    if (delay <= 12) this.raf = requestAnimationFrame(() => this.tick());
    else
      this.timer = setTimeout(() => {
        this.timer = null;
        this.raf = requestAnimationFrame(() => this.tick());
      }, delay - 8);
  }

  private idle(): boolean {
    return !this.plan && !this.pain;
  }

  private scheduleBlink(t: number) {
    const { blinkMinMs: a, blinkMaxMs: b } = this.timing;
    this.blinkAt = t + a + Math.random() * Math.max(0, b - a);
    this.blinkT0 = -1;
  }

  /** The first step of the idle grid at or after x (the grid restarts whenever he becomes idle again). */
  private gridCeil(x: number): number {
    const step = bobStepMs(this.timing);
    return this.idleT0 + Math.ceil((x - this.idleT0) / step - 1e-9) * step;
  }

  private advanceBlink(t: number) {
    if (!this.idle() || this.still || !MOODS[this.moodNow].blinks) {
      // no blinks while talking, glitching or with closed eyes: the next one comes a while after
      if (this.blinkT0 >= 0 || this.blinkAt < t + 400) this.scheduleBlink(t);
      return;
    }
    if (this.blinkT0 >= 0 && t >= this.blinkT0 + this.blinkSeq.length * this.timing.blinkFrameMs) this.scheduleBlink(t);
    if (this.blinkT0 < 0 && t >= this.gridCeil(this.blinkAt) - 1) {
      // on the same stepped grid as the bob (one idle clock, 8 fps by default)
      this.blinkT0 = this.gridCeil(this.blinkAt);
      this.blinkSeq = blinkFrames(Math.random() * 100 < this.timing.doubleBlinkPct);
    }
  }

  /** What he looks like at time t. */
  poseAt(t: number): Pose {
    const m = MOODS[this.moodNow];
    if (this.pain) {
      const e = t - this.painT0;
      let f = this.pain[0];
      for (const p of this.pain) if (p.t <= e) f = p;
      const body = f.tear ? (f.eyes === 'shocked' ? 'body.open' : 'body.half') : 'body.closed';
      return { body, eyes: `eyes.${f.eyes}`, dx: 0, dy: 0, ex: 0, ey: 0, tear: f.tear, seed: f.seed };
    }
    if (this.plan) {
      const e = eventAt(this.plan, t - this.planT0);
      const mouth: BodyMouth = e.mouth;
      return { body: bodyName(mouth, m.paper), eyes: m.eyes, dx: e.jolt, dy: e.jolt, ex: e.jolt, ey: e.jolt, tear: 0, seed: 0 };
    }
    let eyes = m.eyes;
    if (this.blinkT0 >= 0) {
      const lid = this.blinkSeq[Math.floor((t - this.blinkT0) / this.timing.blinkFrameMs)] ?? 'open';
      if (lid !== 'open') eyes = lid === 'half' ? 'eyes.half' : 'eyes.closed';
    }
    let dy = 0;
    let ey = 0;
    if (!this.still) {
      const k = Math.floor((t - this.idleT0) / bobStepMs(this.timing));
      dy = bobAt(k, this.timing);
      ey = bobAt(k - this.timing.eyeLagSteps, this.timing);
    }
    return { body: bodyName(m.rest, m.paper), eyes, dx: 0, dy, ex: 0, ey, tear: 0, seed: 0 };
  }

  /** The next time the picture (or the text) changes. */
  private nextChange(t: number): number {
    if (this.pain) {
      const e = t - this.painT0;
      const nx = this.pain.find((p) => p.t > e);
      return this.painT0 + (nx ? nx.t : painDuration(this.timing));
    }
    if (this.plan) {
      const n = nextEventTime(this.plan, t - this.planT0);
      return this.planT0 + (n === Infinity ? this.plan.duration : n);
    }
    if (!this.live.size) return Infinity;
    let next = Infinity;
    if (!this.still && MOODS[this.moodNow].blinks) {
      next = this.blinkT0 >= 0 ? this.blinkT0 + (Math.floor((t - this.blinkT0) / this.timing.blinkFrameMs) + 1) * this.timing.blinkFrameMs : this.gridCeil(this.blinkAt);
    }
    if (!this.still && this.timing.bobAmpPx > 0) {
      // the next bob step that actually moves the folder or the eyes
      const step = bobStepMs(this.timing);
      const k = Math.floor((t - this.idleT0) / step);
      const cur = [bobAt(k, this.timing), bobAt(k - this.timing.eyeLagSteps, this.timing)];
      for (let j = k + 1; j <= k + bobSteps(this.timing); j++) {
        if (bobAt(j, this.timing) !== cur[0] || bobAt(j - this.timing.eyeLagSteps, this.timing) !== cur[1]) {
          next = Math.min(next, this.idleT0 + j * step);
          break;
        }
      }
    }
    return next;
  }

  // ------------------------------------------------------------ drawing

  private compose(p: Pose): HTMLCanvasElement {
    if (!this.buf) {
      this.buf = document.createElement('canvas');
      this.buf.width = SPRITE_W;
      this.buf.height = SPRITE_H;
    }
    const x = this.buf.getContext('2d', { willReadFrequently: true })!;
    x.clearRect(0, 0, SPRITE_W, SPRITE_H);
    drawLayer(x, p.body, p.dx, p.dy);
    drawLayer(x, p.eyes, p.ex, p.ey);
    if (p.tear) tearImage(x, SPRITE_W, SPRITE_H, p.tear, p.seed, this.timing.tearPx);
    return this.buf;
  }

  private blit(src: HTMLCanvasElement, c: HTMLCanvasElement) {
    const x = c.getContext('2d')!;
    x.imageSmoothingEnabled = false;
    x.clearRect(0, 0, c.width, c.height);
    // whole multiples only: a canvas is SPRITE × ui.k device pixels
    const k = Math.max(1, Math.floor(c.width / SPRITE_W));
    x.drawImage(src, 0, 0, SPRITE_W * k, SPRITE_H * k);
  }

  private draw(p: Pose) {
    if (!this.live.size) return;
    const src = this.compose(p);
    for (const c of this.live) this.blit(src, c);
  }

  private drawStill(c: HTMLCanvasElement) {
    const m = MOODS[this.moodNow === 'pain' ? 'normal' : this.moodNow];
    this.blit(this.compose({ body: bodyName(m.rest, m.paper), eyes: m.eyes, dx: 0, dy: 0, ex: 0, ey: 0, tear: 0, seed: 0 }), c);
    this.lastKey = '';
  }
}

/** A damaged-JPEG tear, in place: horizontal slices shifted sideways, 8×8 blocks displaced, red channel offset. */
export function tearImage(ctx: CanvasRenderingContext2D, W: number, H: number, strength: number, seed: number, maxShift: number) {
  const r = rng(seed);
  const src = ctx.getImageData(0, 0, W, H);
  const s = src.data;
  const o = new Uint8ClampedArray(s);
  const span = Math.max(2, maxShift);
  const copyPx = (dst: Uint8ClampedArray, di: number, from: Uint8ClampedArray, si: number) => {
    dst[di] = from[si];
    dst[di + 1] = from[si + 1];
    dst[di + 2] = from[si + 2];
    dst[di + 3] = from[si + 3];
  };
  // slices
  for (let y = 0; y < H; ) {
    const h = [2, 4, 4, 8][Math.floor(r() * 4)];
    if (r() < 0.55 * strength) {
      const sh = (r() < 0.5 ? -1 : 1) * (2 + Math.floor(r() * (span - 1)));
      for (let yy = y; yy < Math.min(H, y + h); yy++)
        for (let x = 0; x < W; x++) {
          const di = (yy * W + x) * 4;
          const sx = x - sh;
          if (sx < 0 || sx >= W) o[di + 3] = 0;
          else copyPx(o, di, s, (yy * W + sx) * 4);
        }
    }
    y += h;
  }
  // 8×8 blocks moved one block sideways
  const blocks = Math.floor(4 * strength);
  const torn = new Uint8ClampedArray(o);
  for (let n = 0; n < blocks; n++) {
    const bx = Math.floor(r() * Math.floor((W - 8) / 8)) * 8;
    const by = Math.floor(r() * Math.floor((H - 8) / 8)) * 8;
    const tx = bx + (r() < 0.5 ? -8 : 8);
    for (let yy = 0; yy < 8; yy++)
      for (let xx = 0; xx < 8; xx++) {
        const x = tx + xx;
        if (x < 0 || x >= W) continue;
        copyPx(o, ((by + yy) * W + x) * 4, torn, ((by + yy) * W + bx + xx) * 4);
      }
  }
  // red channel smeared 1–2 px to the right
  const rs = 1 + Math.floor(r() * 2);
  const red = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i++) red[i] = o[i * 4];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      o[i * 4] = x - rs >= 0 ? red[i - rs] : 0;
    }
  src.data.set(o);
  ctx.putImageData(src, 0, 0);
}
