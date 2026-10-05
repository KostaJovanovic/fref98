// Windows 98 window chrome, drawn pixel by pixel: 16×14 caption buttons (normal, pressed, disabled) and the
// status-bar size grip. Colours and glyph sizes follow docs/WIN98_METRICS.md.
import { ascii, cached, C98 } from './art';

export type CapKind = 'min' | 'max' | 'restore' | 'close' | 'help';
export type CapState = 'n' | 'p' | 'd';

/** W hilight, L light, F face, G shadow, K dark shadow, T button text: the current scheme's colours. */
const pal = (): Record<string, string> => ({ W: C98.hi, L: C98.light, F: C98.face, G: C98.shadow, K: C98.dark, T: C98.text });

/** The editor's stack-row drag grip, 8×18 (shown at 1× or 2×, never stretched): two raised 98 bars, like a
 *  rebar grip. W white, G shadow, '.' transparent. */
export const GRIP_ROWS = ['........', '.WW..WW.', ...Array<string>(14).fill('.WG..WG.'), '.GG..GG.', '........'];

// glyphs at their 98 offsets inside the 16×14 face (unpressed)
const GLYPHS: Record<CapKind, { x: number; y: number; rows: string[] }> = {
  min: { x: 4, y: 9, rows: ['######', '######'] },
  max: { x: 3, y: 2, rows: ['#########', '#########', '#.......#', '#.......#', '#.......#', '#.......#', '#.......#', '#.......#', '#########'] },
  restore: { x: 3, y: 2, rows: ['..######', '..######', '..#....#', '######.#', '######.#', '#....###', '#....#', '#....#', '######'] },
  close: { x: 4, y: 3, rows: ['##....##', '.##..##', '..####', '...##', '..####', '.##..##', '##....##'] },
  help: { x: 5, y: 2, rows: ['.####', '##..##', '##..##', '...##', '..##', '..##', '', '..##', '..##'] },
};

/** Character rows (16×14) of a caption button: W/L/F/G/K are the bevel shades and T the glyph, '.' never
 *  occurs. */
export function captionButtonRows(kind: CapKind, state: CapState = 'n'): string[] {
  const W = 16;
  const H = 14;
  const g: string[][] = Array.from({ length: H }, () => Array<string>(W).fill('F'));
  const pressed = state === 'p';
  // two 1 px rings: raised = W/K outside, L/G inside; pressed swaps them (K/W outside, G/L inside)
  const ring = (i: number, tl: string, br: string) => {
    for (let x = i; x < W - i; x++) {
      g[i][x] = tl;
      g[H - 1 - i][x] = br;
    }
    for (let y = i; y < H - i; y++) {
      g[y][i] = tl;
      g[y][W - 1 - i] = br;
    }
    g[H - 1 - i][i] = br;
    g[i][W - 1 - i] = br;
  };
  ring(0, pressed ? 'K' : 'W', pressed ? 'W' : 'K');
  ring(1, pressed ? 'G' : 'L', pressed ? 'L' : 'G');
  const gl = GLYPHS[kind];
  const put = (ox: number, oy: number, c: string) =>
    gl.rows.forEach((r, y) => {
      for (let x = 0; x < r.length; x++) if (r[x] === '#') g[oy + y][ox + x] = c;
    });
  const d = pressed ? 1 : 0;
  if (state === 'd') {
    put(gl.x + 1, gl.y + 1, 'W');
    put(gl.x, gl.y, 'G');
  } else put(gl.x + d, gl.y + d, 'T');
  return g.map((r) => r.join(''));
}

/** Data URL of a caption button sprite. */
export function captionButton(kind: CapKind, state: CapState = 'n'): string {
  return cached(`cap98:${kind}:${state}`, () => ascii(captionButtonRows(kind, state), pal()));
}

/** 12×12 size grip: three diagonal pairs of highlight and shadow (transparent elsewhere). */
export function sizeGripRows(): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 12; y++) {
    let r = '';
    for (let x = 0; x < 12; x++) {
      const s = x + y - 11;
      r += s >= 1 && s <= 11 ? ['W', 'G', 'G', '.'][(s - 1) % 4] : '.';
    }
    rows.push(r);
  }
  return rows;
}

export function sizeGrip(): string {
  return cached('grip98', () => ascii(sizeGripRows(), pal()));
}

/** Sets the chrome sprites as CSS custom properties (--cap-min, --cap-min-p, --cap-min-d, …, --grip98). */
export function applyChromeVars(root: HTMLElement) {
  const url = (u: string) => `url("${u}")`;
  for (const k of ['min', 'max', 'restore', 'close', 'help'] as CapKind[]) {
    root.style.setProperty(`--cap-${k}`, url(captionButton(k, 'n')));
    root.style.setProperty(`--cap-${k}-p`, url(captionButton(k, 'p')));
    root.style.setProperty(`--cap-${k}-d`, url(captionButton(k, 'd')));
  }
  root.style.setProperty('--grip98', url(sizeGrip()));
}
