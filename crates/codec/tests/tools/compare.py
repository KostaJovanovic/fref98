"""Compare File Refragmenter's decoder with Pillow (libjpeg-turbo, islow + fancy upsampling).

usage: python compare.py <cli-exe> <jpeg> [<jpeg> ...]
Prints max/mean absolute difference per file. Truncated files are loaded with
ImageFile.LOAD_TRUNCATED_IMAGES like a forgiving viewer would.
"""
import subprocess
import sys
import tempfile
import os

import numpy as np
from PIL import Image, ImageFile

ImageFile.LOAD_TRUNCATED_IMAGES = True


def pillow_rgb(path):
    im = Image.open(path)
    im.load()
    return np.asarray(im.convert("RGB"), dtype=np.int16)


def ours_rgb(cli, path, personality="libjpeg"):
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "o.rgb")
        r = subprocess.run([cli, "decode", path, out, personality], capture_output=True, text=True)
        line = r.stdout.strip().split("\n")[0]
        if line.startswith("ERR"):
            return None, r.stderr
        w, h = map(int, line.split())
        a = np.fromfile(out, dtype=np.uint8).reshape(h, w, 3).astype(np.int16)
        return a, r.stderr


def main():
    cli = sys.argv[1]
    for p in sys.argv[2:]:
        try:
            ref = pillow_rgb(p)
        except Exception as e:  # noqa
            print(f"{os.path.basename(p)}: pillow failed: {e}")
            continue
        ours, ev = ours_rgb(cli, p)
        if ours is None:
            print(f"{os.path.basename(p)}: ours failed")
            continue
        if ours.shape != ref.shape:
            print(f"{os.path.basename(p)}: shape {ours.shape} vs {ref.shape}")
            continue
        d = np.abs(ours - ref)
        rows = np.where(d.max(axis=(1, 2)) > 0)[0]
        first = rows[0] if len(rows) else -1
        print(f"{os.path.basename(p)}: max {d.max()} mean {d.mean():.4f} exact {100.0 * (d == 0).mean():.3f}% first-diff-row {first}")


if __name__ == "__main__":
    main()
