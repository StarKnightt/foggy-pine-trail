"""Luma histogram of a band of a capture, in the three buckets the review uses.

    python tools/hist.py shots/s2h/42.png --top 0 --bot 0.6

The review's targets come from measured reference photographs of fogged conifer
forest: 7-13% of pixels above display luma 180 (pure air) and 32-69% between 70
and 150 (the low-contrast clutter that makes fog read as depth rather than as a
filter). A bimodal distribution -- everything piled at near-black wood and
near-white air -- is the diorama signature, and it is not visible by eye in a
frame whose whole subject sits in a narrow band, so it has to be counted.
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

top = float(flags.get('--top', 0.0))
bot = float(flags.get('--bot', 1.0))

for src in args:
    im = Image.open(src).convert('L')
    W, H = im.size
    im = im.crop((0, int(top * H), W, int(bot * H)))
    px = list(im.getdata())
    n = len(px)
    air = sum(1 for v in px if v > 180) / n
    mid = sum(1 for v in px if 70 <= v <= 150) / n
    dark = sum(1 for v in px if v < 70) / n
    s = sorted(px)
    print(f'{src} y {top:.2f}-{bot:.2f}  >180 {air*100:.1f}%  70-150 {mid*100:.1f}%'
          f'  <70 {dark*100:.1f}%   p1 {s[n//100]} med {s[n//2]} p99 {s[n*99//100]}')
