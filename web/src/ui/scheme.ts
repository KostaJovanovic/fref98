// Colour schemes (Display ▸ Appearance ▸ Scheme), as 98 had them: each sets the system colours: 3D objects and
// their bevel shades, window and text colours, the selection, active and inactive captions, tooltip. The CSS
// reads them as --c-* variables on the document root (css/base.css has the Standard values); the control and
// chrome sprites are redrawn in them (art.ts setArtColors). Our own set and values, in the spirit of 98's.
// Pure data + one DOM function.

export interface SchemeColors {
  face: string;
  hi: string;
  light: string;
  shadow: string;
  dark: string;
  text: string;
  win: string;
  wtext: string;
  sel: string;
  seltext: string;
  gray: string;
  tip: string;
  cap1: string;
  cap2: string;
  captext: string;
  icap1: string;
  icap2: string;
  icaptext: string;
}

const hexOf = (n: number) => '#' + n.toString(16).padStart(6, '0');
const rgbOf = (c: string) => {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** a + (b - a) · t per channel, rounded. */
export function mix(a: string, b: string, t: number): string {
  const x = rgbOf(a);
  const y = rgbOf(b);
  return hexOf(x.reduce((acc, v, i) => (acc << 8) | Math.round(v + (y[i] - v) * t), 0));
}

/** A 98-style scheme from a face colour and a caption colour: the bevel shades come from the face as 98
 *  derives them (light halfway to white, shadow two thirds of the face), inactive captions from the shadow. */
function tinted(face: string, cap: string, cap2 = mix(cap, '#ffffff', 0.45)): SchemeColors {
  const shadow = mix(face, '#000000', 1 / 3);
  return {
    face,
    hi: '#ffffff',
    light: mix(face, '#ffffff', 0.5),
    shadow,
    dark: '#000000',
    text: '#000000',
    win: '#ffffff',
    wtext: '#000000',
    sel: cap,
    seltext: '#ffffff',
    gray: shadow,
    tip: '#ffffe1',
    cap1: cap,
    cap2,
    captext: '#ffffff',
    icap1: shadow,
    icap2: mix(shadow, face, 0.6),
    icaptext: face,
  };
}

export const SCHEMES: Record<string, { name: string; colors: SchemeColors }> = {
  standard: {
    name: 'Windows Standard',
    colors: {
      face: '#c0c0c0', hi: '#ffffff', light: '#dfdfdf', shadow: '#808080', dark: '#000000', text: '#000000', win: '#ffffff', wtext: '#000000',
      sel: '#000080', seltext: '#ffffff', gray: '#808080', tip: '#ffffe1', cap1: '#000080', cap2: '#1084d0', captext: '#ffffff',
      icap1: '#808080', icap2: '#b5b5b5', icaptext: '#c0c0c0',
    },
  },
  brick: { name: 'Brick', colors: tinted('#c2bfa5', '#800000') },
  desert: { name: 'Desert', colors: tinted('#d5ccbb', '#008080') },
  eggplant: { name: 'Eggplant', colors: tinted('#90b0a8', '#604878') },
  lilac: { name: 'Lilac', colors: tinted('#aea8d9', '#5a4e9c') },
  marine: { name: 'Marine', colors: tinted('#88c0b8', '#000080', '#4080c0') },
  plum: { name: 'Plum', colors: tinted('#a8a090', '#483058') },
  rainy: { name: 'Rainy Day', colors: tinted('#8399b1', '#4f657d') },
  rose: { name: 'Rose', colors: tinted('#cfafb7', '#9f6070') },
  slate: { name: 'Slate', colors: tinted('#8ca8b0', '#3c5c70') },
  spruce: { name: 'Spruce', colors: tinted('#a2c8a9', '#3a6a46') },
  storm: { name: 'Storm (VGA)', colors: tinted('#c0c0c0', '#800080') },
  teal: { name: 'Teal (VGA)', colors: tinted('#c0c0c0', '#008080') },
  wheat: { name: 'Wheat', colors: tinted('#d8d4a8', '#808000') },
  contrast: {
    name: 'High Contrast Black',
    colors: {
      face: '#000000', hi: '#ffffff', light: '#808080', shadow: '#808080', dark: '#ffffff', text: '#ffffff', win: '#000000', wtext: '#ffffff',
      sel: '#800080', seltext: '#ffffff', gray: '#00ff00', tip: '#000000', cap1: '#800080', cap2: '#800080', captext: '#ffffff',
      icap1: '#008000', icap2: '#008000', icaptext: '#ffffff',
    },
  },
};

export function schemeColors(id: string): SchemeColors {
  return (SCHEMES[id] ?? SCHEMES.standard).colors;
}

/** The dotted focus rectangle is XOR'd with white: on a selected item it shows the selection's inverse. */
export function xorWhite(c: string): string {
  return hexOf(parseInt(c.slice(1), 16) ^ 0xffffff);
}

/** The CSS variables of a scheme. */
export function schemeVars(c: SchemeColors): Record<string, string> {
  const v: Record<string, string> = {};
  for (const [k, val] of Object.entries(c)) v['--c-' + k] = val;
  v['--focus-on-sel'] = xorWhite(c.sel);
  return v;
}

/** Puts a scheme's colours on the document root (custom properties that reference them resolve there). */
export function applySchemeVars(id: string) {
  const root = document.documentElement;
  for (const [k, val] of Object.entries(schemeVars(schemeColors(id)))) root.style.setProperty(k, val);
}
