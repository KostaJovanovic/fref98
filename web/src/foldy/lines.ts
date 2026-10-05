// What Foldy says: tips, explanations of decoder events, and (when he glitches) nonsense.
// The user writes their own lines in docs/foldy-lines.xlsx; `npm run lines` turns them into lines.gen.json, and
// userLine() prefers those over the built-in text below.
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

export const TIPS = [
  'Tip: zoom to 1:1 (the "1:1" button) to see the real 8×8 blocks.',
  'Tip: the before/after split has a handle in the middle. Drag it!',
  'Tip: every random step has its own seed. Press the dice for a different roll.',
  'Tip: steps can be reordered. Damage first, then re-save, looks very different from the other way round.',
  'Tip: "Export" gives you the actual broken JPEG. Other programs may show it differently. Try it!',
  'Tip: the grid button draws the 8×8 (or 16×16) block grid that JPEG works in.',
  'Tip: nothing you do leaves your computer. Look at the tray: Network: blocked.',
  'Tip: My Pictures can hold lots of photos. Some steps borrow a neighbour photo, like a real SD card would.',
  'Tip: the Removable Disk (E:) icon is a whole simulated memory card. You can delete, format and carve it.',
  'Tip: Ctrl+Z undoes. There is no limit.',
  'Tip: the heatmap shows where the encoder spent its bits.',
];

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

export function explainEvent(e: DecodeEvent): string {
  const f = EXPLAIN[e.kind];
  if (f) return f(e);
  return `Something odd happened ("${e.kind}")${where(e)}${e.detail ? `: ${e.detail}` : ''}.`;
}

/** Summarises a decode's events into one friendly explanation. */
export function explainEvents(events: DecodeEvent[]): string {
  if (!events.length) return 'This file decodes cleanly. Any damage you see is "valid" damage: the data is broken in a way the decoder accepts, like heavy compression or a wrong table.';
  const kinds = [...new Set(events.map((e) => e.kind))];
  const first = kinds.slice(0, 2).map((k) => explainEvent(events.find((e) => e.kind === k)!));
  const more = events.length > 2 ? ` (${events.length} things went wrong in total; the Hex view lists them all.)` : '';
  return first.join(' ') + more;
}

export const NONSENSE = [
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

export function nonsense(): string {
  return Math.random() < 0.5 ? NONSENSE[Math.floor(Math.random() * NONSENSE.length)] : jargonSentence();
}

export const TUTORIAL = {
  hello: 'Hi! I’m Foldy. I explain things. Drop a photo onto the editor, or press "Try a sample photo".',
  helloPhone: 'Hi! I’m Foldy. I explain things. Press "Choose photo…" to pick one of yours, or "Try a sample photo".',
  pick: 'Now pick what happened to this photo from the list. Every choice really breaks the JPEG data.',
  slider: 'Drag "How bad?" to make it better or worse. When you like it, press Export to save the broken file.',
  expert: 'These are the real steps behind the story. They run top to bottom. Press a step’s name for its settings, untick it to switch it off, and use ▲▼ (or drag the dots) to reorder.',
  done: 'That is a real broken JPEG! Open it in other programs: each one shows the damage a little differently.',
};
