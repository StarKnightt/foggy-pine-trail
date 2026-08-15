"""Luma bands and chroma, on any image, in the units the review argues in.

    python tools/palette.py shots/s8a/42.png ref/photos/*.jpg
    python tools/palette.py shots/s8a/42.png --top 0.55 --bot 1.0   # near field only

`hist.py` already counts the three luma buckets. This adds the other half of
the argument and puts both in one line, because the two are only meaningful
together: the standing instruction for System 8 is a *muted* grade, and the
critic's warning is that the frame's chroma is already below the reference
band, so a report that moves the histogram without saying what happened to the
saturation cannot distinguish a graded frame from a bleached one.

Saturation is HSV's (max-min)/max, per pixel, which is the same definition
`Rig.probe` uses and therefore comparable with every number already in the
project's notes. The *median* is reported as well as the mean because the
distribution is strongly bimodal — a fog scene is a large achromatic field with
a small chromatic corner — and the mean of that is a number no pixel has.

Reference photographs are measured with exactly this script, so the targets are
not inherited figures: run it on `ref/photos/` to reproduce them.
"""
import sys
from PIL import Image
import numpy as np

flags = {sys.argv[i]: sys.argv[i + 1] for i in range(len(sys.argv) - 1)
         if sys.argv[i].startswith('--')}
skip = set()
for i, a in enumerate(sys.argv):
    if a.startswith('--'):
        skip |= {i, i + 1}
args = [a for i, a in enumerate(sys.argv) if i and i not in skip]

top = float(flags.get('--top', 0.0))
bot = float(flags.get('--bot', 1.0))

print(f'  {"file":38s} {">180":>6s} {"70-150":>7s} {"<70":>6s} '
      f'{"med":>4s} {"p1":>4s} {"p99":>4s} {"satMed":>7s} {"satMean":>8s} {"sat>0.15":>9s}')

rows = []
for src in args:
    im = Image.open(src).convert('RGB')
    W, H = im.size
    im = im.crop((0, int(top * H), W, int(bot * H)))
    a = np.asarray(im, dtype=np.float32)
    # ITU-R 601, matching hist.py's PIL 'L' conversion so the two agree.
    y = a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114
    mx = a.max(axis=2)
    mn = a.min(axis=2)
    sat = np.where(mx > 0.5, (mx - mn) / np.maximum(mx, 1e-6), 0.0)

    row = (
        src.replace('\\', '/').split('/')[-1],
        100 * float((y > 180).mean()),
        100 * float(((y >= 70) & (y <= 150)).mean()),
        100 * float((y < 70).mean()),
        float(np.median(y)),
        float(np.percentile(y, 1)),
        float(np.percentile(y, 99)),
        float(np.median(sat)),
        float(sat.mean()),
        100 * float((sat > 0.15).mean()),
    )
    rows.append(row)
    print(f'  {row[0][:38]:38s} {row[1]:5.1f}% {row[2]:6.1f}% {row[3]:5.1f}% '
          f'{row[4]:4.0f} {row[5]:4.0f} {row[6]:4.0f} {row[7]:7.3f} {row[8]:8.3f} {row[9]:8.1f}%')

if len(rows) > 1:
    cols = list(zip(*[r[1:] for r in rows]))
    lo = [min(c) for c in cols]
    hi = [max(c) for c in cols]
    print(f'  {"RANGE":38s} {lo[0]:5.1f}-{hi[0]:.1f}%  {lo[1]:.1f}-{hi[1]:.1f}%  '
          f'{lo[2]:.1f}-{hi[2]:.1f}%  med {lo[3]:.0f}-{hi[3]:.0f}  '
          f'satMed {lo[6]:.3f}-{hi[6]:.3f}  satMean {lo[7]:.3f}-{hi[7]:.3f}')
