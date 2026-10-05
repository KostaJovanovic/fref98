"""Builds web/src/assets/fonts/refrag-pixel.ttf and refrag-pixel-bold.ttf from scripts/glyphs.txt.

Every outline sits exactly on a pixel grid (100 font units per pixel, 13 px em), so at font-size 13px
(or any whole multiple) the text has no partial-coverage edges: no antialiasing.
Requires: fontTools (pip install fonttools). The generated .ttf files are committed, so a normal
`npm run build` does not need Python.
"""
import os
import sys
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'src', 'assets', 'fonts')
PX = 100          # font units per pixel
ASC = 10          # pixels above baseline (2 accent rows + 8 cap rows)
DESC = 3          # pixels below baseline
EM = (ASC + DESC) * PX

NAMED = {
    'c_caron': 0x010D, 's_caron': 0x0161, 'z_caron': 0x017E, 'c_acute': 0x0107, 'dcroat': 0x0111,
    'Ccaron': 0x010C, 'Cacute': 0x0106, 'Scaron': 0x0160, 'Zcaron': 0x017D, 'Dcroat': 0x0110,
}


def parse(path):
    glyphs = {}
    cur = None
    rows = []

    def flush():
        if cur is not None:
            glyphs[cur] = rows[:]

    with open(path, encoding='utf-8') as f:
        for raw in f:
            line = raw.rstrip('\n').rstrip('\r')
            if line.startswith('#') and cur is None:
                continue
            if line.startswith('= '):
                flush()
                key = line[2:].strip()
                if key.startswith('U+'):
                    cp = int(key[2:], 16)
                elif key in NAMED:
                    cp = NAMED[key]
                elif len(key) == 1:
                    cp = ord(key)
                else:
                    raise SystemExit('bad glyph key ' + key)
                cur = cp
                rows = []
                continue
            if cur is None:
                continue
            s = line.strip()
            if not s:
                continue
            rows.append(s)
    flush()
    return glyphs


def to_bitmap(rows):
    """Returns (top_offset, bitmap rows) where top_offset is number of accent rows (0..2)."""
    accents = [r[1:] for r in rows if r.startswith('^')]
    body = [r for r in rows if not r.startswith('^')]
    allrows = accents + body
    w = max(len(r) for r in allrows) if allrows else 0
    bm = [[1 if (i < len(r) and r[i] == '#') else 0 for i in range(w)] for r in allrows]
    return len(accents), bm, w


def embolden(bm, w):
    out = []
    for r in bm:
        nr = [0] * (w + 1)
        for i, v in enumerate(r):
            if v:
                nr[i] = 1
                nr[i + 1] = 1
        out.append(nr)
    return out, (w + 1 if w > 0 else 0)


def draw(bm, top_off, pen):
    # Merge pixels into maximal horizontal runs, then stack identical runs vertically.
    rects = []  # (x0, x1, y0, y1) in pixel units, y measured in rows from top of glyph art
    open_runs = {}
    for y, r in enumerate(bm + [[]]):
        runs = []
        x = 0
        while x < len(r):
            if r[x]:
                x0 = x
                while x < len(r) and r[x]:
                    x += 1
                runs.append((x0, x))
            else:
                x += 1
        new_open = {}
        for run in runs:
            if run in open_runs:
                new_open[run] = open_runs.pop(run)
            else:
                new_open[run] = y
        for run, y0 in open_runs.items():
            rects.append((run[0], run[1], y0, y))
        open_runs = new_open
    for (x0, x1, y0, y1) in rects:
        # art row 0 = cap top = 8 px above baseline; accent rows go above that.
        top = (8 + top_off - y0) * PX
        bot = (8 + top_off - y1) * PX
        l, rr = x0 * PX, x1 * PX
        pen.moveTo((l, bot))
        pen.lineTo((l, top))
        pen.lineTo((rr, top))
        pen.lineTo((rr, bot))
        pen.closePath()


def build(glyphs, bold, path, family):
    order = ['.notdef']
    cmap = {}
    widths = {}
    outlines = {}
    bitmaps = {}
    # .notdef: hollow box
    pen = TTGlyphPen(None)
    box = [[1, 1, 1, 1], [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1], [1, 1, 1, 1]]
    draw(box, 0, pen)
    outlines['.notdef'] = pen.glyph()
    widths['.notdef'] = 5 * PX
    for cp in sorted(glyphs):
        name = 'uni%04X' % cp
        top, bm, w = to_bitmap(glyphs[cp])
        if bold and cp != 0x20:
            bm, w = embolden(bm, w)
        pen = TTGlyphPen(None)
        draw(bm, top, pen)
        outlines[name] = pen.glyph()
        adv = w + 1
        if cp == 0x20:
            adv = 3 if not bold else 4
        widths[name] = adv * PX
        bitmaps[name] = (top, bm, w, adv)
        order.append(name)
        cmap[cp] = name
    # non-breaking space = space
    cmap[0xA0] = cmap[0x20]
    fb = FontBuilder(EM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(outlines)
    fb.setupHorizontalMetrics({n: (widths[n], 0) for n in order})
    fb.setupHorizontalHeader(ascent=ASC * PX, descent=-DESC * PX, lineGap=0)
    style = 'Bold' if bold else 'Regular'
    fb.setupNameTable({
        'familyName': family,
        'styleName': style,
        'uniqueFontIdentifier': family + ' ' + style,
        'fullName': family + ' ' + style,
        'psName': family.replace(' ', '') + '-' + style,
        'version': 'Version 1.000',
        'copyright': 'File Refragmenter contributors. Dedicated to the public domain (CC0 1.0).',
        'licenseDescription': 'CC0 1.0 Universal',
    })
    fb.setupOS2(
        version=4,
        sTypoAscender=ASC * PX, sTypoDescender=-DESC * PX, sTypoLineGap=0,
        usWinAscent=ASC * PX, usWinDescent=DESC * PX,
        sxHeight=6 * PX, sCapHeight=8 * PX,
        fsSelection=(0x20 if bold else 0x40) | 0x80,  # bold/regular + USE_TYPO_METRICS
        usWeightClass=700 if bold else 400,
        achVendID='RFRG',  # (the committed .ttf files still say JPGT, the old name, until they are rebuilt)
    )
    fb.setupPost()
    fb.setupHead(unitsPerEm=EM)
    # gasp: grid-fit only, no greyscale at every size -> DirectWrite/Skia render the glyphs bi-level (aliased).
    from fontTools.ttLib import newTable
    gasp = newTable('gasp')
    gasp.version = 1
    gasp.gaspRange = {0xFFFF: 0x0001}
    fb.font['gasp'] = gasp
    fb.font['head'].macStyle = 1 if bold else 0
    if STRIKES:
        add_bitmap_strikes(fb.font, bitmaps, STRIKES)
    fb.save(path)


# Embedded bitmap strikes (EBLC/EBDT). Tested: browsers' font sanitiser (OTS) drops them from web fonts, so
# they are off. The web app instead thresholds text alpha with an SVG filter and snaps every `.tx` run to whole device pixels (src/ui/dom.ts
# ensureCrispFilter and initTextSnap).
STRIKES = []


def add_bitmap_strikes(font, bitmaps, sizes):
    import io
    out = io.StringIO()
    out.write('<?xml version="1.0" encoding="UTF-8"?>\n<ttFont sfntVersion="\\x00\\x01\\x00\\x00" ttLibVersion="4.0">\n')
    names = [n for n in font.getGlyphOrder() if n in bitmaps]
    out.write('<EBDT>\n<header version="2.0"/>\n')
    for si, ppem in enumerate(sizes):
        n = ppem // 13
        out.write('<strikedata index="%d">\n' % si)
        for name in names:
            top, bm, w, adv = bitmaps[name]
            h = len(bm)
            if w == 0 or h == 0:
                bm, w, h, bearing_y = [[0]], 1, 1, 1
            else:
                bearing_y = 8 + top
            out.write('<ebdt_bitmap_format_1 name="%s">\n<SmallGlyphMetrics>\n' % name)
            out.write('<height value="%d"/>\n<width value="%d"/>\n<BearingX value="0"/>\n<BearingY value="%d"/>\n<Advance value="%d"/>\n'
                      % (h * n, w * n, bearing_y * n, adv * n))
            out.write('</SmallGlyphMetrics>\n<bitwiseimagedata bitDepth="1" width="%d" height="%d">\n' % (w * n, h * n))
            for row in bm:
                s = ''.join(('@' if v else '.') * n for v in row) + '.' * ((w - len(row)) * n)
                for _ in range(n):
                    out.write('<row value="%s"/>\n' % s)
            out.write('</bitwiseimagedata>\n</ebdt_bitmap_format_1>\n')
        out.write('</strikedata>\n')
    out.write('</EBDT>\n')
    out.write('<EBLC>\n<header version="2.0"/>\n')
    for si, ppem in enumerate(sizes):
        n = ppem // 13
        out.write('<strike index="%d">\n<bitmapSizeTable>\n' % si)
        for d in ('hori', 'vert'):
            out.write('<sbitLineMetrics direction="%s">\n' % d)
            vals = dict(ascender=ASC * n, descender=-DESC * n, widthMax=min(255, 9 * n), caretSlopeNumerator=0,
                        caretSlopeDenominator=0, caretOffset=0, minOriginSB=0, minAdvanceSB=0,
                        maxBeforeBL=ASC * n, minAfterBL=-DESC * n, pad1=0, pad2=0)
            for k, v in vals.items():
                out.write('<%s value="%d"/>\n' % (k, v))
            out.write('</sbitLineMetrics>\n')
        out.write('<colorRef value="0"/>\n<startGlyphIndex value="1"/>\n<endGlyphIndex value="%d"/>\n'
                  '<ppemX value="%d"/>\n<ppemY value="%d"/>\n<bitDepth value="1"/>\n<flags value="1"/>\n'
                  % (len(names), ppem, ppem))
        out.write('</bitmapSizeTable>\n')
        out.write('<eblc_index_sub_table_1 imageFormat="1" firstGlyphIndex="1" lastGlyphIndex="%d">\n' % len(names))
        for name in names:
            out.write('<glyphLoc name="%s"/>\n' % name)
        out.write('</eblc_index_sub_table_1>\n</strike>\n')
    out.write('</EBLC>\n</ttFont>\n')
    out.seek(0)
    font.importXML(out)


def main():
    glyphs = parse(os.path.join(HERE, 'glyphs.txt'))
    os.makedirs(OUT, exist_ok=True)
    build(glyphs, False, os.path.join(OUT, 'refrag-pixel.ttf'), 'Refragmenter Pixel')
    build(glyphs, True, os.path.join(OUT, 'refrag-pixel-bold.ttf'), 'Refragmenter Pixel')
    # Glyph data for the canvas text renderer (hex view, contact sheets, sprites).
    lines = ['// GENERATED by scripts/build_font.py from scripts/glyphs.txt. Do not edit.',
             '// codepoint -> [accentRows, width, ...rows as bitmasks (bit 0 = leftmost pixel)]',
             'export const GLYPHS: Record<number, number[]> = {']
    for cp in sorted(glyphs):
        top, bm, w = to_bitmap(glyphs[cp])
        rows = [sum((1 << i) for i, v in enumerate(r) if v) for r in bm]
        lines.append('  %d: [%d, %d, %s],' % (cp, top, w, ', '.join(str(r) for r in rows)))
    lines.append('};')
    with open(os.path.join(HERE, '..', 'src', 'ui', 'glyphdata.gen.ts'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')
    print('built %d glyphs' % len(glyphs))


if __name__ == '__main__':
    sys.exit(main())
