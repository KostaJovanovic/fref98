"""Dev helper: crop a screenshot region and upscale it (nearest) to check pixel crispness.
usage: python scripts/zoom.py in.png out.png x y w h [scale]
Prints the number of distinct colours in the crop (antialiased text shows many in-between shades)."""
import sys
from PIL import Image

src, dst, x, y, w, h = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:7])
s = int(sys.argv[7]) if len(sys.argv) > 7 else 6
im = Image.open(src).convert('RGB').crop((x, y, x + w, y + h))
cols = im.getcolors(1 << 20) or []
cols.sort(reverse=True)
print('distinct colours:', len(cols))
print('top:', [('#%02x%02x%02x' % c[1], c[0]) for c in cols[:12]])
im.resize((w * s, h * s), Image.NEAREST).save(dst)
