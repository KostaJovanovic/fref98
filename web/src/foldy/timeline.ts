// Foldy's timing, as pure functions (no DOM, no clock): what his mouth, eyes and text do at every millisecond.
// The player (player.ts) only reads these. Spec: REVISION.md §5 "Foldy animation spec" (Endacopia-style talking).
//
// Talking: the mouth (folder flap) steps open → half → closed every `frameMs`, ONLY while a word is spoken. Between
// words he freezes on the exact frame he was on (even open) for a word / comma / sentence gap. The whole sprite
// jolts on the closed frame. No bob while talking. The plan's `reveal` follows the mouth, but the panel types the
// text faster on its own clock (textCharMs, foldy.ts); the full text shows at the latest when the line ends.

export interface FoldyTiming {
  /** One mouth step while a word is spoken. */
  frameMs: number;
  /** Mouth steps per word: floor(letters / lettersPerStep) + 1 … */
  lettersPerStep: number;
  /** … but at least this many. */
  minSteps: number;
  /** Freeze between two words. */
  wordGapMs: number;
  /** Freeze after , ; : and dashes. */
  commaGapMs: number;
  /** Freeze after . ! ? … */
  sentenceGapMs: number;
  /** How far the whole sprite jolts (right and down) on the closed mouth frame. */
  joltPx: number;
  /** The text types out one character per this many ms, on its own clock (faster than the mouth). */
  textCharMs: number;
  /** Idle bob: one full up-and-down. */
  bobPeriodMs: number;
  bobAmpPx: number;
  /** Idle bob steps per second (stepped, never eased). */
  bobFps: number;
  /** The eyes float this many bob steps behind the folder. */
  eyeLagSteps: number;
  /** A blink comes every blinkMin..blinkMax ms (idle only). */
  blinkMinMs: number;
  blinkMaxMs: number;
  /** Each blink frame (half, closed, closed, half). */
  blinkFrameMs: number;
  /** Chance of a double blink, in percent. */
  doubleBlinkPct: number;
  /** Pain glitch: the JPEG tear. */
  painMs: number;
  painFps: number;
  /** Largest sideways shift of a torn slice. */
  tearPx: number;
  /** The wince held after the tear. */
  winceMs: number;
  /** A finished line stays this long (at least) before the panel clears, unless it waits for the user. */
  lingerMs: number;
  /** A reaction mood (happy, shocked…) is held this long after the line ends. */
  moodHoldMs: number;
}

export const DEFAULT_TIMING: FoldyTiming = {
  frameMs: 100,
  lettersPerStep: 2,
  minSteps: 3,
  wordGapMs: 300,
  commaGapMs: 500,
  sentenceGapMs: 1000,
  joltPx: 1,
  textCharMs: 26,
  bobPeriodMs: 2000,
  bobAmpPx: 1,
  bobFps: 8,
  eyeLagSteps: 2,
  blinkMinMs: 2500,
  blinkMaxMs: 6000,
  blinkFrameMs: 125,
  doubleBlinkPct: 15,
  painMs: 800,
  painFps: 12,
  tearPx: 7,
  winceMs: 1000,
  lingerMs: 6000,
  moodHoldMs: 2500,
};

/** Slider ranges for the tuning panel: [min, max, step, label, unit]. Also used to sanitise saved values. */
export const TIMING_RANGES: Record<keyof FoldyTiming, [number, number, number, string, string]> = {
  frameMs: [40, 300, 5, 'Mouth frame', 'ms'],
  lettersPerStep: [1, 6, 1, 'Letters per mouth step', ''],
  minSteps: [1, 9, 1, 'Min. steps per word', ''],
  wordGapMs: [0, 1500, 25, 'Gap between words', 'ms'],
  commaGapMs: [0, 2000, 25, 'Gap after a comma', 'ms'],
  sentenceGapMs: [0, 3000, 50, 'Gap after a sentence', 'ms'],
  joltPx: [0, 3, 1, 'Jolt on closed frame', 'px'],
  textCharMs: [5, 150, 1, 'Text speed (per letter)', 'ms'],
  bobPeriodMs: [500, 6000, 100, 'Idle bob period', 'ms'],
  bobAmpPx: [0, 4, 1, 'Idle bob amplitude', 'px'],
  bobFps: [2, 30, 1, 'Idle bob steps/s', 'fps'],
  eyeLagSteps: [0, 8, 1, 'Eyes lag the bob by', 'steps'],
  blinkMinMs: [500, 10000, 100, 'Blink every (min)', 'ms'],
  blinkMaxMs: [500, 15000, 100, 'Blink every (max)', 'ms'],
  blinkFrameMs: [30, 300, 5, 'Blink frame', 'ms'],
  doubleBlinkPct: [0, 100, 1, 'Double blink chance', '%'],
  painMs: [100, 3000, 50, 'Pain tear length', 'ms'],
  painFps: [2, 30, 1, 'Pain tear steps/s', 'fps'],
  tearPx: [1, 16, 1, 'Tear shift (max)', 'px'],
  winceMs: [0, 4000, 50, 'Wince after the tear', 'ms'],
  lingerMs: [1000, 30000, 500, 'Line stays (min)', 'ms'],
  moodHoldMs: [0, 10000, 100, 'Reaction mood held', 'ms'],
};

/** Saved values merged over the defaults, each clamped to its slider range (bad or old values never break him). */
export function sanitizeTiming(saved: Partial<Record<string, unknown>> | null | undefined): FoldyTiming {
  const out = { ...DEFAULT_TIMING };
  if (!saved || typeof saved !== 'object') return out;
  for (const k of Object.keys(DEFAULT_TIMING) as (keyof FoldyTiming)[]) {
    const v = Number(saved[k]);
    if (saved[k] === undefined || saved[k] === null || !Number.isFinite(v)) continue;
    const [min, max] = TIMING_RANGES[k];
    out[k] = Math.min(max, Math.max(min, v));
  }
  if (out.blinkMaxMs < out.blinkMinMs) out.blinkMaxMs = out.blinkMinMs;
  return out;
}

// ------------------------------------------------------------------ talking

export type Mouth = 'open' | 'half' | 'closed';
/** Tip's loop from the Endacopia clips: wide open, half, closed. */
export const MOUTH_CYCLE: readonly Mouth[] = ['open', 'half', 'closed'];

export type GapKind = 'word' | 'comma' | 'sentence';

export interface TalkWord {
  /** Character range in the text (with punctuation glued to the word). */
  from: number;
  to: number;
  /** Letters and digits: they set the number of mouth steps. */
  letters: number;
  steps: number;
  /** The word is spoken in [start, end); the freeze after it lasts gapMs. */
  start: number;
  end: number;
  gap: GapKind;
  gapMs: number;
}

/**
 * Every event carries the full state from its time on (the player shows the latest event at or before `now`):
 * - 'step': a mouth step inside a word (the only kind that changes the mouth);
 * - 'gap':  a freeze starts; the state is the previous step's, unchanged;
 * - 'end':  the line is over: mouth closed, no jolt, all text shown. Idle (bob, blinks) may resume after it.
 */
export interface TalkEvent {
  t: number;
  kind: 'step' | 'gap' | 'end';
  mouth: Mouth;
  jolt: number;
  /** Characters of the text revealed. */
  reveal: number;
  /** Index into `words` (-1 for the end). */
  word: number;
}

export interface TalkPlan {
  text: string;
  words: TalkWord[];
  events: TalkEvent[];
  duration: number;
}

const SPOKEN = /[\p{L}\p{N}]/u;
const CLOSERS = /[)"'”’»\]]+$/u;

export function gapKind(token: string): GapKind {
  const t = token.replace(CLOSERS, '');
  const last = t.slice(-1);
  if (/[.!?…]/.test(last)) return 'sentence';
  if (/[,;:—–-]/.test(last)) return 'comma';
  return 'word';
}

export function gapMs(kind: GapKind, timing: FoldyTiming): number {
  return kind === 'sentence' ? timing.sentenceGapMs : kind === 'comma' ? timing.commaGapMs : timing.wordGapMs;
}

export function stepsFor(letters: number, timing: FoldyTiming): number {
  return Math.max(Math.max(1, Math.round(timing.minSteps)), Math.floor(letters / Math.max(1, timing.lettersPerStep)) + 1);
}

/** Splits a line into spoken words. Tokens without letters or digits ("—", "…") are glued to a neighbour. */
export function segment(text: string): { from: number; to: number; letters: number }[] {
  const out: { from: number; to: number; letters: number }[] = [];
  let pending: number | null = null; // start of leading punctuation waiting for the next word
  for (const m of text.matchAll(/\S+/g)) {
    const from = m.index!;
    const to = from + m[0].length;
    const letters = [...m[0]].filter((c) => SPOKEN.test(c)).length;
    if (!letters) {
      if (out.length) out[out.length - 1].to = to;
      else if (pending === null) pending = from;
      continue;
    }
    out.push({ from: pending ?? from, to, letters });
    pending = null;
  }
  return out;
}

/** The whole line as timed events. Pure and deterministic. */
export function talk(text: string, timing: FoldyTiming): TalkPlan {
  const frame = Math.max(1, timing.frameMs);
  const segs = segment(text);
  const words: TalkWord[] = [];
  const events: TalkEvent[] = [];
  let t = 0;
  let last: TalkEvent | null = null;
  segs.forEach((s, wi) => {
    const steps = stepsFor(s.letters, timing);
    const tok = text.slice(s.from, s.to);
    const gap = gapKind(tok);
    const w: TalkWord = { ...s, steps, start: t, end: t + steps * frame, gap, gapMs: gapMs(gap, timing) };
    words.push(w);
    const len = s.to - s.from;
    for (let i = 0; i < steps; i++) {
      const mouth = MOUTH_CYCLE[i % MOUTH_CYCLE.length];
      last = { t: t + i * frame, kind: 'step', mouth, jolt: mouth === 'closed' ? timing.joltPx : 0, reveal: s.from + Math.ceil(((i + 1) * len) / steps), word: wi };
      events.push(last);
    }
    t = w.end;
    // freeze: the exact frame stays (no mouth change, no bob) for the gap
    events.push({ ...last!, t, kind: 'gap' });
    t += w.gapMs;
  });
  events.push({ t, kind: 'end', mouth: 'closed', jolt: 0, reveal: text.length, word: -1 });
  return { text, words, events, duration: t };
}

/** The event in force at time t (ms since the line started). Before the first event: the first one. */
export function eventAt(plan: TalkPlan, t: number): TalkEvent {
  const ev = plan.events;
  let lo = 0;
  let hi = ev.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ev[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return ev[lo];
}

/** When the state next changes after t (Infinity once the line is over). */
export function nextEventTime(plan: TalkPlan, t: number): number {
  for (const e of plan.events) if (e.t > t) return e.t;
  return Infinity;
}

// ------------------------------------------------------------------ idle

/** Bob offset at idle step k (k = 0 is rest): 1 px up and down over the period, stepped. */
export function bobAt(k: number, timing: FoldyTiming): number {
  const n = bobSteps(timing);
  if (timing.bobAmpPx <= 0 || n < 2) return 0;
  const v = Math.round(timing.bobAmpPx * 0.75 * Math.sin((2 * Math.PI * (k - 0.5)) / n));
  return v === 0 ? 0 : v; // no -0
}

export function bobSteps(timing: FoldyTiming): number {
  return Math.max(2, Math.round((timing.bobPeriodMs * timing.bobFps) / 1000));
}

export function bobStepMs(timing: FoldyTiming): number {
  return 1000 / Math.max(1, timing.bobFps);
}

export type Lid = 'open' | 'half' | 'closed';

/** One blink as lid frames, each blinkFrameMs long: half, closed, closed, half (twice for a double blink). */
export function blinkFrames(double: boolean): Lid[] {
  const one: Lid[] = ['half', 'closed', 'closed', 'half'];
  return double ? [...one, 'open', ...one] : one;
}

// ------------------------------------------------------------------ pain glitch

export interface PainFrame {
  t: number;
  /** 'pain' (> <), 'shocked' (pinprick) or 'pain2' (one of each). */
  eyes: 'pain' | 'shocked' | 'pain2';
  /** Tear strength 0..1 (0 = the clean wince). */
  tear: number;
  seed: number;
}

/** The tear at painFps for painMs (hard first, weaker at the end), then the wince, snapped in with no easing. */
export function painFrames(timing: FoldyTiming, seed = 1): PainFrame[] {
  const step = 1000 / Math.max(1, timing.painFps);
  const n = Math.max(1, Math.round(timing.painMs / step));
  const out: PainFrame[] = [];
  for (let i = 0; i < n; i++) out.push({ t: Math.round(i * step), eyes: i % 3 ? 'pain' : 'shocked', tear: i < n * 0.7 ? 1 : 0.4, seed: (seed * 7919 + i * 104729) >>> 0 || 1 });
  out.push({ t: Math.round(n * step), eyes: 'pain', tear: 0, seed: 0 });
  return out;
}

export function painDuration(timing: FoldyTiming): number {
  const step = 1000 / Math.max(1, timing.painFps);
  return Math.round(Math.max(1, Math.round(timing.painMs / step)) * step) + timing.winceMs;
}

/** A small seeded PRNG (the tear must look random but be reproducible per frame). */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}
