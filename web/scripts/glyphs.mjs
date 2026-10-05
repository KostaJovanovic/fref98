// Reads scripts/glyphs.txt the way build_font.py does: which code points the pixel font has. A glyph is keyed
// `= U+XXXX`, `= <one character>`, or `= <name>` from NAMED (keep this table in step with build_font.py's).
export const NAMED = {
  c_caron: 0x010d, s_caron: 0x0161, z_caron: 0x017e, c_acute: 0x0107, dcroat: 0x0111,
  Ccaron: 0x010c, Cacute: 0x0106, Scaron: 0x0160, Zcaron: 0x017d, Dcroat: 0x0110,
};

/** The code point of a glyph key, or null for a key build_font.py would reject. */
export function glyphKey(key) {
  if (key.startsWith('U+')) return parseInt(key.slice(2), 16);
  if (Object.prototype.hasOwnProperty.call(NAMED, key)) return NAMED[key];
  if ([...key].length === 1) return key.codePointAt(0);
  return null;
}

/** Every code point glyphs.txt defines (plus space, no-break space, newline and tab, which need no glyph). */
export function fontCodepoints(src) {
  const have = new Set([0x20, 0xa0, 0x0a, 0x09]);
  for (const l of src.split(/\r?\n/)) {
    if (!l.startsWith('= ')) continue;
    const cp = glyphKey(l.slice(2).trim());
    if (cp !== null) have.add(cp);
  }
  return have;
}
