// What Foldy says: tips, explanations of decoder events, reactions and (when he glitches) nonsense.
// The user writes their own lines in docs/foldy-lines.xlsx; `npm run lines` turns them into lines.gen.json, and
// userLine() prefers those over the built-in text below. Every line here has the ID of its row in column A
// (LINE_IDS lists them; a test checks the sheet and this file name the same IDs).
import type { DecodeEvent } from '../engine/types';
import gen from './lines.gen.json';

const USER = gen as Record<string, string[]>;

/** Placeholders the app fills in, per line ID (the "why_" explanations); every other line gets none. */
export const PLACEHOLDERS: Record<string, string[]> = { why_: ['byte', 'where', 'detail', 'kind', 'count'] };

export function allowedPlaceholders(id: string): string[] {
  const k = Object.keys(PLACEHOLDERS).find((p) => id.startsWith(p));
  return k ? PLACEHOLDERS[k] : [];
}

/**
 * The user's line for an ID: one of their alternatives picked at random, '' when they want silence there, or
 * `fallback` when they haven't written one. `vars` fills {placeholders}.
 */
export function userLine(id: string, fallback: string, vars: Record<string, string | number> = {}, rnd = Math.random): string {
  const alts = USER[id];
  const text = alts === undefined ? fallback : alts.length ? alts[Math.floor(rnd() * alts.length)] : '';
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Every user line, for the placeholder check in tests. */
export function allUserLines(): [string, string[]][] {
  return Object.entries(USER);
}

const two = (i: number) => String(i + 1).padStart(2, '0');

const TIPS = [
  'Tip: zoom to 1:1 (the "1:1" button) to see the real 8×8 blocks.',
  'Tip: the before/after split has a handle in the middle. Drag it!',
  'Tip: every random step has its own seed. Press the dice for a different roll.',
  'Tip: steps can be reordered. Damage first, then re-save, looks very different from the other way round.',
  'Tip: "Save As…" gives you the actual broken JPEG. Other programs may show it differently. Try it!',
  'Tip: the grid button draws the 8×8 (or 16×16) block grid that JPEG works in.',
  'Tip: nothing you do leaves your computer. Look at the tray: Network: blocked.',
  'Tip: My Pictures can hold lots of photos. Some steps borrow a neighbour photo, like a real SD card would.',
  'Tip: the Removable Disk (E:) icon is a whole simulated memory card. You can delete, format and carve it.',
  'Tip: Ctrl+Z undoes. There is no limit.',
  'Tip: the heatmap shows where the encoder spent its bits.',
];

/** A random tip (tip_01…). */
export function tip(rnd = Math.random): string {
  const i = Math.floor(rnd() * TIPS.length);
  return userLine(`tip_${two(i)}`, TIPS[i]);
}

/** "at x 120, y 64" when the event is tied to a spot in the picture. */
export function where(e: DecodeEvent): string {
  return e.x !== undefined && e.y !== undefined && e.x >= 0 && e.y >= 0 ? ` (at x ${e.x}, y ${e.y} in the picture)` : '';
}

const EXPLAIN: Record<string, (e: DecodeEvent) => string> = {
  truncated: (e) => `The file stops early (at byte ${e.byte.toLocaleString()}). Everything after that point${where(e)} never arrived, so it is filled in. That is the flat band at the bottom.`,
  arithmetic: () => 'This file uses arithmetic coding, a rare (once patented) way to pack JPEG data. My decoder reads it fine, but most browsers and viewers refuse to open it at all.',
  bad_code: (e) => `The arithmetic decoder hit a value that can’t happen${where(e)}, so the rest of that strip was skipped.`,
  extra_data: () => 'There are leftover bytes after the picture ended. Viewers ignore them; recovery tools often find a second file hiding there.',
  bogus_progression: () => 'The progressive passes come in an impossible order, so some detail passes refine data that never arrived.',
  unsupported: (e) => `This is an unusual JPEG flavour (${e.detail || '12-bit or lossless'}). I show it as well as I can, but it won’t look exactly right.`,
  bad_marker: (e) => `There is a marker in the middle of the picture data (${e.detail || 'unexpected'})${where(e)}. The decoder trips over it and loses its place.`,
  resync: (e) => `The decoder lost track and found its way again${where(e)}. The strip in between came out scrambled or grey.`,
  rst_missing: () => 'A restart marker is missing, so a strip of blocks either slides up or leaves a gap.',
  dc_jump: (e) => `Why is it pink or green? Colour is stored as a difference from the previous block. One wrong step${where(e)} and every block after it keeps the same wrong offset: a tint.`,
  fill: (e) => `These blocks had no data at all, so they were filled (${e.detail || 'grey'}).`,
  bad_huffman: (e) => `A bit pattern that is not in the Huffman table${where(e)}: from here on the data is nonsense, so the decoder guesses.`,
  eoi_early: () => 'An "end of image" marker turned up too early. Everything after it is ignored.',
  header_repaired: (e) => `The header was broken, so I patched it with a best guess${e.detail ? ` (${e.detail})` : ''}.`,
};

/** why_<kind>, or why_other for a kind without its own line. */
export function explainEvent(e: DecodeEvent): string {
  const vars = { byte: e.byte.toLocaleString(), where: where(e), detail: e.detail || '', kind: e.kind };
  const f = EXPLAIN[e.kind];
  if (f) return userLine('why_' + e.kind, f(e), vars);
  return userLine('why_other', `Something odd happened ("${e.kind}")${where(e)}${e.detail ? `: ${e.detail}` : ''}.`, vars);
}

/** Summarises a decode's events into one friendly explanation (why_clean, the first two, why_more). */
export function explainEvents(events: DecodeEvent[]): string {
  if (!events.length) return userLine('why_clean', 'This file decodes cleanly. Any damage you see is "valid" damage: the data is broken in a way the decoder accepts, like heavy compression or a wrong table.');
  const kinds = [...new Set(events.map((e) => e.kind))];
  const first = kinds.slice(0, 2).map((k) => explainEvent(events.find((e) => e.kind === k)!));
  const more = events.length > 2 ? userLine('why_more', `(${events.length} things went wrong in total; the Hex view lists them all.)`, { count: events.length }) : '';
  return [...first, more].filter(Boolean).join(' ');
}

const NONSENSE = [
  'Did you know? Every JPEG secretly contains a very small horse.',
  'I have defragmented the moon. You are welcome.',
  'BEEP. Huffman says hi. Huffman is my uncle.',
  'Please insert disk 2 of 1.',
  'My favourite colour is 0xFFD8.',
  'The quantisation table is looking at me again.',
  'Error: success.',
  'I used to be a .ZIP. Long story.',
  'Who put a restart marker in my sandwich?',
  'All your blocks are belong to 8×8.',
  'One time I decoded a photo upside down and nobody noticed. Nobody.',
  'Loading personality… 23 of 166…',
];

const NOUNS = ['the Huffman tree', 'your DC predictor', 'a zigzag scan', 'the quantisation table', 'every MCU', 'restart marker 7', 'the chroma plane', 'an EOI', 'the SOF0 header', 'byte stuffing', 'the Cb channel', 'an inverse DCT', 'the luma', 'cluster 41812', 'the EXIF thumbnail', 'sector zero', 'a lonely AC coefficient', 'the FAT', 'the progressive scan', 'a 0xFF00'];
const VERBS = ['has upsampled', 'is quietly re-quantising', 'forgot', 'zigzagged into', 'carved', 'unstuffed', 'is dequantising', 'bit-flipped', 'resynced with', 'swapped places with', 'ate', 'is negotiating with', 'subsampled'];
const ENDS = ['again.', 'for science.', 'and it felt great.', 'at 4:2:0.', 'without asking.', 'in 1998.', 'twice.', '— classic.', 'and now it is Tuesday.'];

export function jargonSentence(rnd: () => number = Math.random): string {
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const s = `${pick(NOUNS)} ${pick(VERBS)} ${pick(NOUNS)} ${pick(ENDS)}`;
  return s[0].toUpperCase() + s.slice(1);
}

/** A glitch line: one of nonsense_01… or a made-up jargon sentence. */
export function nonsense(rnd: () => number = Math.random): string {
  if (rnd() >= 0.5) return jargonSentence(rnd);
  const i = Math.floor(rnd() * NONSENSE.length);
  return userLine(`nonsense_${two(i)}`, NONSENSE[i]);
}

const TUTORIAL_TEXT = {
  hello: 'Hi! I’m Foldy. I explain things. Drop a photo onto the editor, or press "Try a sample photo".',
  hello_phone: 'Hi! I’m Foldy. I explain things. Press "Choose photo…" to pick one of yours, or "Try a sample photo".',
  tut_pick: 'Now pick what happened to this photo from the list. Every choice really breaks the JPEG data.',
  tut_slider: 'Drag "How bad?" to make it better or worse. When you like it, press Save As… to save the broken file.',
  tut_steps: 'These are the real steps behind the story. They run top to bottom. Press a step’s name for its settings, untick it to switch it off, and use ▲▼ (or drag the dots) to reorder.',
  tut_done: 'That is a real broken JPEG! Open it in other programs: each one shows the damage a little differently.',
};
export type TutorialStep = keyof typeof TUTORIAL_TEXT;

export function tutorial(id: TutorialStep): string {
  return userLine(id, TUTORIAL_TEXT[id]);
}

/** Reactions and the click menu. An empty built-in line means he only says something there if the user wrote it. */
const REACTION_TEXT = {
  heavy_damage: 'Whoa. That photo has seen things.',
  all_grey: '',
  slider_low: '',
  slider_max: '',
  another_roll: '',
  undo: '',
  working: '',
  exported: 'Saved. Enjoy your broken file.',
  photo_loaded: '',
  unreadable: '',
  idle_asleep: '',
  wake: '',
  click_greet: 'Hi. What can I do for you?',
  click_btn_why: 'Why does it look like that?',
  click_btn_tip: 'Give me a tip',
  click_btn_hide: 'Hide Foldy',
  back: 'I’m back. Click me any time for help.',
  click_spam: '',
  glitch_recover: '…sorry, where was I? ',
  // a switch, not a line: "—" in the sheet turns the jumbled-words glitch off
  jumble: 'on',
};
export type ReactionId = keyof typeof REACTION_TEXT;

/** A reaction line; `fallback` replaces an empty built-in (e.g. the progress dialog's own words for "working"). */
export function reaction(id: ReactionId, fallback?: string): string {
  return userLine(id, REACTION_TEXT[id] || fallback || '');
}

/** What he says after a preset is applied (preset_<id>). */
export function presetLine(p: { id: string; foldy: string }): string {
  return userLine('preset_' + p.id, p.foldy);
}

/** The words of a line in a shuffled order (the "jumble" glitch). */
export function jumbled(text: string, rnd: () => number = Math.random): string {
  const w = text.split(' ');
  for (let i = w.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [w[i], w[j]] = [w[j], w[i]];
  }
  return w.join(' ');
}

/** Every line ID this file speaks, except preset_<id> (one per preset). */
export const LINE_IDS: string[] = [
  ...Object.keys(TUTORIAL_TEXT),
  ...Object.keys(REACTION_TEXT),
  'why_clean',
  ...Object.keys(EXPLAIN).map((k) => 'why_' + k),
  'why_other',
  'why_more',
  ...TIPS.map((_, i) => `tip_${two(i)}`),
  ...NONSENSE.map((_, i) => `nonsense_${two(i)}`),
];
