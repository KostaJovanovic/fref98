// Pure helpers for the 98 Explorer-style folder windows (My Pictures, Recycle Bin, Presets): sizes and dates
// the way 98 printed them, status-bar text, sorting, keyboard neighbours among laid-out items, range
// selection, type-ahead and "Copy of" names. No DOM.

export type ViewMode = 'large' | 'small' | 'list' | 'details' | 'thumbs';

export const VIEW_LABELS: Record<ViewMode, string> = {
  large: 'Lar&ge Icons',
  small: 'S&mall Icons',
  list: '&List',
  details: '&Details',
  thumbs: 'T&humbnails',
};

/** The Views toolbar button cycles through these, as 98's did (Thumbnails only through the menu). */
export function nextView(v: ViewMode, allowed: ViewMode[]): ViewMode {
  const cycle = (['large', 'small', 'list', 'details'] as ViewMode[]).filter((x) => allowed.includes(x));
  if (!cycle.length) return v;
  const i = cycle.indexOf(v);
  return cycle[(i + 1) % cycle.length];
}

/** A FAT volume label as 98's Explorer shows it: all-capital names in mixed case ("CARD" → "Card",
 *  "HOLIDAY 2004" → "Holiday 2004"), the default "Allow all uppercase names" being off. */
export function volumeTitle(label: string): string {
  return label.replace(/[A-Z]+/g, (w, i: number) => (i === 0 || label[i - 1] === ' ' ? w[0] + w.slice(1).toLowerCase() : w.toLowerCase()));
}

/** 98's StrFormatByteSize: three significant digits ("512 bytes", "1.23KB", "12.3KB", "123KB", "1.20MB"). */
export function fmtSize98(n: number): string {
  if (n < 1024) return `${n} bytes`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  // truncated, not rounded, as 98 did
  const s = v >= 100 ? String(Math.floor(v)) : v >= 10 ? (Math.floor(v * 10) / 10).toFixed(1) : (Math.floor(v * 100) / 100).toFixed(2);
  return s + units[u];
}

/** The Size column of Details view: whole kilobytes, rounded up ("1KB" for anything small, "0KB" for empty). */
export function fmtSizeColumn(n: number): string {
  if (n <= 0) return '0KB';
  return Math.ceil(n / 1024).toLocaleString('en-US') + 'KB';
}

/** "123,456 bytes" for property sheets. */
export function fmtBytesExact(n: number): string {
  return n.toLocaleString('en-US') + ' bytes';
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 98 short date and time (US English locale): "10/5/2026 3:04 PM". */
export function fmtDate98(t: number | Date): string {
  const d = typeof t === 'number' ? new Date(t) : t;
  const h = d.getHours();
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${h % 12 || 12}:${pad2(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}

/** 98 long date for property sheets: "Monday, October 05, 2026 3:04:09 PM". */
export function fmtDateLong98(t: number | Date): string {
  const d = typeof t === 'number' ? new Date(t) : t;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const h = d.getHours();
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${pad2(d.getDate())}, ${d.getFullYear()} ${h % 12 || 12}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The left status-bar cell: "5 object(s)" with nothing selected, "2 object(s) selected" otherwise. */
export function statusText(selected: number, total: number): string {
  return selected ? `${selected} object(s) selected` : `${total} object(s)`;
}

/** Natural, case-insensitive compare ("IMG2" before "IMG10"). */
export function natCmp(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true });
}

export interface SortKey<T> {
  /** Compares two items ascending. */
  cmp: (a: T, b: T) => number;
}

/** Sorts a copy; ties keep the original order (stable), and fall back to the name compare when given. */
export function sortItems<T>(items: T[], key: SortKey<T>, desc: boolean, tie?: (a: T, b: T) => number): T[] {
  return items
    .map((it, i) => ({ it, i }))
    .sort((x, y) => {
      const c = key.cmp(x.it, y.it) || (tie ? tie(x.it, y.it) : 0);
      return (desc ? -c : c) || x.i - y.i;
    })
    .map((x) => x.it);
}

export interface ItemBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Dir = 'left' | 'right' | 'up' | 'down';

/** The item an arrow key moves to among laid-out boxes: the nearest one whose centre lies in that direction,
 *  sideways distance counting double (so Down stays in the column when there is one). */
export function neighborBox(boxes: ItemBox[], from: string, dir: Dir): string | null {
  const f = boxes.find((b) => b.id === from);
  if (!f) return null;
  const fx = f.x + f.w / 2;
  const fy = f.y + f.h / 2;
  let best: string | null = null;
  let bestS = Infinity;
  for (const b of boxes) {
    if (b.id === from) continue;
    const dx = b.x + b.w / 2 - fx;
    const dy = b.y + b.h / 2 - fy;
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    const side = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    // strictly in that direction (items in the same row or column are not "below" or "beside")
    if (along < 1) continue;
    const s = along + 2 * side;
    if (s < bestS) {
      bestS = s;
      best = b.id;
    }
  }
  return best;
}

/** Shift+click / Shift+arrow: everything between the anchor and `to` in display order (inclusive). */
export function rangeSelect(order: string[], anchor: string | null, to: string): string[] {
  const j = order.indexOf(to);
  if (j < 0) return [];
  const i = anchor ? order.indexOf(anchor) : -1;
  if (i < 0) return [to];
  const [a, b] = i < j ? [i, j] : [j, i];
  return order.slice(a, b + 1);
}

/** Type-ahead: the next item (after `cur` for a single letter, from `cur` for a longer prefix) whose name
 *  starts with `typed`, wrapping around. */
export function typeAhead(order: string[], names: (id: string) => string, cur: string | null, typed: string): string | null {
  if (!typed || !order.length) return null;
  const t = typed.toLowerCase();
  const i = cur ? order.indexOf(cur) : -1;
  const start = i < 0 ? 0 : i + (t.length === 1 ? 1 : 0);
  const ring = [...order.slice(start), ...order.slice(0, start)];
  return ring.find((id) => names(id).toLowerCase().startsWith(t)) ?? null;
}

/** 98's names for pasted copies: "Copy of X", then "Copy (2) of X", "Copy (3) of X", … */
export function copyName(name: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((s) => s.toLowerCase()));
  const first = `Copy of ${name}`;
  if (!set.has(first.toLowerCase())) return first;
  for (let n = 2; ; n++) {
    const c = `Copy (${n}) of ${name}`;
    if (!set.has(c.toLowerCase())) return c;
  }
}

/** A file name 98 would accept: none of \ / : * ? " < > |, not empty, not only dots or spaces. */
export function validFileName(s: string): boolean {
  const t = s.trim();
  return t.length > 0 && t.length <= 255 && !/[\\/:*?"<>|]/.test(t) && !/^[. ]+$/.test(t);
}

/** "photo.jpg" → "JPEG Image"; anything else by its extension ("RFG File"), as 98's registry did. */
export function fileType(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  const ext = (m?.[1] ?? '').toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'jpe' || ext === 'jfif' || !ext) return 'JPEG Image';
  if (ext === 'avi') return 'Video Clip';
  if (ext === 'rfg') return 'Refragmenter Project';
  return ext.toUpperCase() + ' File';
}

/** Word-wraps an icon label into lines no wider than `maxW` (by `measure`), breaking words that are too long
 *  on their own, as 98's large-icon labels did. */
export function wrapLabel(text: string, maxW: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  let cur = '';
  const pushWord = (w: string) => {
    // a word wider than the label is broken by characters
    while (measure(w) > maxW && w.length > 1) {
      let n = w.length - 1;
      while (n > 1 && measure(w.slice(0, n)) > maxW) n--;
      lines.push(w.slice(0, n));
      w = w.slice(n);
    }
    cur = w;
  };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? cur + ' ' + word : word;
    if (measure(next) <= maxW) cur = next;
    else {
      if (cur) lines.push(cur);
      pushWord(word);
    }
  }
  if (cur || !lines.length) lines.push(cur);
  return lines;
}

/** The first `n` lines, the last one ending in "..." when text was cut (and shortened until it fits). */
export function clampLines(lines: string[], n: number, maxW: number, measure: (s: string) => number): string[] {
  if (lines.length <= n) return lines;
  const out = lines.slice(0, n);
  let last = out[n - 1] + ' ' + lines.slice(n).join(' ');
  while (last.length > 1 && measure(last + '...') > maxW) last = last.slice(0, -1);
  out[n - 1] = last.trimEnd() + '...';
  return out;
}

/** The 8.3 "MS-DOS name" a 98 property sheet shows: "Holiday photo.jpg" → "HOLIDA~1.JPG". */
export function dosName(name: string, n = 1): string {
  const m = /^(.*?)(?:\.([^.]*))?$/.exec(name.trim()) ?? ['', name, ''];
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9!#$%&'()\-@^_`{}~]/g, '');
  const base = clean(m[1] ?? '');
  const ext = clean(m[2] ?? '').slice(0, 3);
  const fits = base.length <= 8 && base === (m[1] ?? '').toUpperCase() && (m[2] ?? '').length <= 3;
  const b = fits ? base : base.slice(0, 6) + '~' + n;
  return (b || '_~' + n) + (ext ? '.' + ext : '');
}

/** When a photo was added, from the time stamp at the start of its uid ("user:" + base-36 Date.now()). Null
 *  for bundled samples and anything that doesn't decode to a plausible date. */
export function uidTime(uid: string): number | null {
  if (!/^(user|ph):/.test(uid)) return null;
  const s = uid.slice(uid.indexOf(':') + 1);
  // uid() is 8 base-36 time digits plus a counter and random digits; a bare name like "ph:testcard" is not a time
  if (s.length <= 8 || !/^[0-9a-z]+$/.test(s)) return null;
  const t = parseInt(s.slice(0, 8), 36);
  return Number.isFinite(t) && t > Date.UTC(2020, 0, 1) && t < Date.UTC(2100, 0, 1) ? t : null;
}

/** Playback clock for the media player: "00:12" or "1:02:03" past an hour; tenths when asked. */
export function fmtClock(sec: number, tenths = false): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const ss = tenths ? (Math.floor(r * 10) / 10).toFixed(1).padStart(4, '0') : pad2(Math.floor(r));
  return h ? `${h}:${pad2(m)}:${ss}` : `${pad2(m)}:${ss}`;
}
