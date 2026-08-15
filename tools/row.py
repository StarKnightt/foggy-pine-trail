"""Lateral variation along one scanline, ignoring anything that is not air.

    python tools/row.py shots/s2h/94.png --y 0.30 --floor 170

The review's charge against the fog was "ten code values of variation across an
entire scanline of clear air", and it cannot be answered from a whole-frame
histogram: a frame full of stems has plenty of spread and none of it is in the
air. Restricting to pixels above a floor keeps only the air, and the spread of
what is left is the number in dispute.
"""
import sys
from PIL import Image

flags = {sys.argv[i]: sys.argv[i + 1] for i in range(len(sys.argv) - 1)
         if sys.argv[i].startswith('--')}
skip = set()
for i, a in enumerate(sys.argv):
    if a.startswith('--'):
        skip |= {i, i + 1}
args = [a for i, a in enumerate(sys.argv) if i and i not in skip]

yf = float(flags.get('--y', 0.30))
floor = int(flags.get('--floor', 170))
band = int(flags.get('--band', 6))

for src in args:
    im = Image.open(src).convert('L')
    W, H = im.size
    y0 = int(yf * H)
    vals = []
    for x in range(W):
        col = [im.getpixel((x, y)) for y in range(max(0, y0 - band), min(H, y0 + band))]
        v = sum(col) / len(col)
        if v >= floor:
            vals.append(v)
    if not vals:
        print(f'{src} y={yf}: no air above {floor}')
        continue
    vals.sort()
    mean = sum(vals) / len(vals)
    sd = (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5
    print(f'{src} y={yf} air px {len(vals)}/{W}  min {vals[0]:.0f} max {vals[-1]:.0f}'
          f'  range {vals[-1] - vals[0]:.0f}  sd {sd:.2f}')
