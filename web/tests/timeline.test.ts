import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMING,
  MOUTH_CYCLE,
  TIMING_RANGES,
  blinkFrames,
  bobAt,
  bobSteps,
  eventAt,
  gapKind,
  nextEventTime,
  painDuration,
  painFrames,
  sanitizeTiming,
  segment,
  stepsFor,
  talk,
  type FoldyTiming,
  type TalkPlan,
} from '../src/foldy/timeline';

const T = DEFAULT_TIMING;
const LINES = [
  "Hi! I'm Foldy. I explain what happened to your photo, block by block.",
  'One flipped bit in the compressed data can derail everything after it until the next restart marker.',
  'Saved! Enjoy your broken file.',
  '…sorry, where was I? The file stops early (at byte 1,024).',
  'Tip: zoom to 1:1 (the "1:1" button) to see the real 8×8 blocks — really.',
  'a',
  '   leading and trailing spaces   ',
  'Whoa. That photo has seen things.',
];

/** True when t lies inside a word being spoken. */
const inWord = (p: TalkPlan, t: number) => p.words.some((w) => t >= w.start && t < w.end);

describe('Foldy talk timeline', () => {
  it('changes the mouth only inside words', () => {
    for (const line of LINES) {
      const p = talk(line, T);
      // every event that changes the mouth or the jolt is a step inside a word
      let prev = { mouth: 'closed', jolt: 0 };
      for (const e of p.events) {
        if (e.mouth !== prev.mouth || e.jolt !== prev.jolt) {
          if (e.kind === 'end') expect(e.t).toBe(p.duration);
          else {
            expect(e.kind, `${line} @${e.t}`).toBe('step');
            expect(inWord(p, e.t), `${line} @${e.t}`).toBe(true);
          }
        }
        prev = e;
      }
      // sampled every 5 ms: the shown mouth never changes during a gap
      let last = eventAt(p, 0);
      for (let t = 0; t < p.duration; t += 5) {
        const e = eventAt(p, t);
        if (e.mouth !== last.mouth) expect(inWord(p, t), `${line} mouth changed in a gap at ${t}`).toBe(true);
        last = e;
      }
    }
  });

  it('freezes on the exact frame through every gap', () => {
    const p = talk("Hi! I'm Foldy, okay. Then a really long word: incomprehensibilities", T);
    for (const w of p.words) {
      const at = eventAt(p, w.end - 1);
      for (let t = w.end; t < w.end + w.gapMs; t += 10) {
        const e = eventAt(p, t);
        expect(e.kind).toBe('gap');
        expect([e.mouth, e.jolt, e.reveal]).toEqual([at.mouth, at.jolt, at.reveal]);
      }
    }
    // a freeze can be on an open mouth (a 4-step word ends on "open")
    const four = p.words.find((w) => w.steps % 3 === 1)!;
    expect(eventAt(p, four.end).mouth).toBe('open');
  });

  it('uses the right gap lengths', () => {
    const p = talk('one two, three. four! five? six; seven… eight', T);
    expect(p.words.map((w) => w.gap)).toEqual(['word', 'comma', 'sentence', 'sentence', 'sentence', 'comma', 'sentence', 'word']);
    for (let i = 0; i + 1 < p.words.length; i++) {
      const a = p.words[i];
      const b = p.words[i + 1];
      expect(b.start - a.end).toBe(a.gapMs);
      expect(a.gapMs).toBe(a.gap === 'sentence' ? 1000 : a.gap === 'comma' ? 500 : 300);
    }
    expect(gapKind('end."')).toBe('sentence');
    expect(gapKind('(this),')).toBe('comma');
    expect(gapKind('word)')).toBe('word');
    // the line ends after the last word's gap
    const lastW = p.words[p.words.length - 1];
    expect(p.duration).toBe(lastW.end + lastW.gapMs);
  });

  it('steps the mouth open → half → closed every frameMs, at least minSteps per word', () => {
    const p = talk('a incomprehensibilities', T);
    for (const w of p.words) {
      const steps = p.events.filter((e) => e.kind === 'step' && e.t >= w.start && e.t < w.end);
      expect(steps.length).toBe(w.steps);
      expect(w.steps).toBe(stepsFor(w.letters, T));
      steps.forEach((e, i) => {
        expect(e.t).toBe(w.start + i * T.frameMs);
        expect(e.mouth).toBe(MOUTH_CYCLE[i % 3]);
        expect(e.jolt).toBe(e.mouth === 'closed' ? T.joltPx : 0);
      });
    }
    expect(p.words[0].steps).toBe(3); // minimum
    expect(p.words[1].steps).toBe(Math.floor(21 / 2) + 1);
  });

  it('reveals the text in step with the mouth, ending with all of it', () => {
    for (const line of LINES) {
      const p = talk(line, T);
      let r = 0;
      for (const e of p.events) {
        expect(e.reveal).toBeGreaterThanOrEqual(r);
        if (e.kind === 'gap') expect(e.reveal).toBe(r);
        r = e.reveal;
      }
      expect(p.events[p.events.length - 1].reveal).toBe(line.length);
      // a word is fully shown by its last step
      for (const w of p.words) expect(eventAt(p, w.end - 1).reveal).toBe(w.to);
    }
  });

  it('has no bob (or any other kind of) event while talking', () => {
    for (const line of LINES) {
      const p = talk(line, T);
      expect(new Set(p.events.map((e) => e.kind))).toEqual(new Set(p.words.length ? ['step', 'gap', 'end'] : ['end']));
      for (const e of p.events) expect(Object.keys(e).sort()).toEqual(['jolt', 'kind', 'mouth', 'reveal', 't', 'word']);
    }
  });

  it('is deterministic and handles empty and punctuation-only text', () => {
    for (const line of LINES) expect(talk(line, T)).toEqual(talk(line, T));
    const e = talk('', T);
    expect(e.duration).toBe(0);
    expect(e.events).toEqual([{ t: 0, kind: 'end', mouth: 'closed', jolt: 0, reveal: 0, word: -1 }]);
    const dots = talk('… — !', T);
    expect(dots.words.length).toBe(0);
    expect(dots.events[0].reveal).toBe(5);
    // punctuation tokens are glued to a neighbour word
    expect(segment('— hello — world').map((s) => [s.from, s.to])).toEqual([[0, 9], [10, 15]]);
  });

  it('follows the timing it is given', () => {
    const fast: FoldyTiming = { ...T, frameMs: 50, wordGapMs: 0, sentenceGapMs: 200, joltPx: 0 };
    const p = talk('quick brown. fox', fast);
    expect(p.words[1].start - p.words[0].end).toBe(0);
    expect(p.words[2].start - p.words[1].end).toBe(200);
    expect(p.events.every((e) => e.jolt === 0)).toBe(true);
    expect(nextEventTime(p, 0)).toBe(50);
    expect(nextEventTime(p, p.duration)).toBe(Infinity);
  });
});

describe('Foldy idle and pain', () => {
  it('bobs 1 px each way over 2 s at 8 fps (the mockup pattern)', () => {
    expect(bobSteps(T)).toBe(16);
    const seq = Array.from({ length: 16 }, (_, k) => bobAt(k, T));
    expect(seq).toEqual([0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, -1, -1, -1, -1, 0]);
    expect(bobAt(5, { ...T, bobAmpPx: 0 })).toBe(0);
  });

  it('blinks half, closed, closed, half', () => {
    expect(blinkFrames(false)).toEqual(['half', 'closed', 'closed', 'half']);
    expect(blinkFrames(true).length).toBe(9);
  });

  it('tears at painFps, then holds the wince', () => {
    const f = painFrames(T, 3);
    expect(f.length).toBe(Math.round(T.painMs / (1000 / T.painFps)) + 1);
    expect(f[f.length - 1].tear).toBe(0);
    expect(f.slice(0, -1).every((x) => x.tear > 0)).toBe(true);
    expect(painDuration(T)).toBeGreaterThanOrEqual(T.painMs + T.winceMs - 50);
    expect(painFrames(T, 3)).toEqual(f);
  });

  it('sanitises saved timing against the slider ranges', () => {
    expect(sanitizeTiming(undefined)).toEqual(T);
    const s = sanitizeTiming({ frameMs: 5, wordGapMs: 'x', blinkMinMs: 9000, blinkMaxMs: 1000, bogus: 3 } as never);
    expect(s.frameMs).toBe(TIMING_RANGES.frameMs[0]);
    expect(s.wordGapMs).toBe(T.wordGapMs);
    expect(s.blinkMaxMs).toBe(9000);
    expect('bogus' in s).toBe(false);
    for (const [k, [min, max]] of Object.entries(TIMING_RANGES)) {
      const d = T[k as keyof FoldyTiming];
      expect(d, k).toBeGreaterThanOrEqual(min);
      expect(d, k).toBeLessThanOrEqual(max);
    }
  });
});
