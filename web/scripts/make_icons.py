"""Draws the PWA icons (original pixel art: Foldy's folder on a dithered blue tile) and writes them to
public/icons at 32, 180, 192 and 512 px with nearest-neighbour scaling. Requires Pillow."""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'public', 'icons')

ART = [
    '................................',
    '................................',
    '................................',
    '................................',
    '.....KKKKKKKK...................',
    '....KYYYYYYYYK..................',
    '....KYYYYYYYYKKKKKKKKKKKKKKKK...',
    '....KyyyyyyyyyyyyyyyyyyyyyyyK...',
    '....KyWWWWWWWWWWWWWWWWWWWWWyK...',
    '....KyWWWWWWWWWWWWWWWWWWWWWyK...',
    '...KKKKKKKKKKKKKKKKKKKKKKKKKKK..',
    '...KLLLLLLLLLLLLLLLLLLLLLLLLLK..',
    '...KLLLLLLLLLLLLLLLLLLLLLLLLLK..',
    '...KLLLLKKKKLLLLLLLLKKKKLLLLLK..',
    '...KLLLKWWWWKLLLLLLKWWWWKLLLLK..',
    '...KLLLKWWBBKLLLLLLKWWBBKLLLLK..',
    '...KLLLKWWBBKLLLLLLKWWBBKLLLLK..',
    '...KLLLKWWWWKLLLLLLKWWWWKLLLLK..',
    '...KLLLLKKKKLLLLLLLLKKKKLLLLLK..',
    '...KLLLLLLLLLLLLLLLLLLLLLLLLLK..',
    '...KLLLLLLLLLRRRRRRLLLLLLLLLLK..',
    '...KLLLLLLLLLLRRRRLLLLLLLLLLLK..',
    '...KYYYYYYYYYYYYYYYYYYYYYYYYYK..',
    '...KYYYYYYYYYYYYYYYYYYYYYYYYYK..',
    '...KyyyyyyyyyyyyyyyyyyyyyyyyyK..',
    '...KyyyyyyyyyyyyyyyyyyyyyyyyyK..',
    '...KKKKKKKKKKKKKKKKKKKKKKKKKKK..',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
]
PAL = {
    'K': (58, 42, 16), 'Y': (240, 188, 69), 'y': (208, 154, 42), 'L': (255, 224, 138), 'W': (255, 255, 255),
    'B': (17, 17, 17), 'R': (176, 64, 32),
}
BG0 = (61, 149, 255)
BG1 = (0, 84, 227)
BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]


def tile():
    im = Image.new('RGB', (32, 32))
    for y in range(32):
        t = y / 31
        for x in range(32):
            thr = (BAYER[y % 4][x % 4] + 0.5) / 16
            im.putpixel((x, y), BG1 if t > thr else BG0)
    for y, row in enumerate(ART):
        for x, ch in enumerate(row):
            if ch in PAL:
                im.putpixel((x, y), PAL[ch])
    return im


def main():
    os.makedirs(OUT, exist_ok=True)
    base = tile()
    for s in (32, 180, 192, 512):
        base.resize((s, s), Image.NEAREST).save(os.path.join(OUT, 'icon-%d.png' % s))
    print('icons written')


if __name__ == '__main__':
    main()
