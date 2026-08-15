"""The understory-foliage population, isolated and measured.

    python tools/foliage.py shots/s8a/down.png ref/photos/*.jpg

Written because the whole-frame numbers in `palette.py` cannot answer the
question that decides the grade's shadow lift. The brief says "no bright colours
anywhere"; the histogram target says fill the dark lobe. Those pull opposite ways
on exactly one population — the ferns — because they are the only large
chromatic thing in the frame and they sit in the midtones where a shadow lift
still has purchase. A lift that fixes the histogram by brightening the ferns has
traded a measured defect for an unmeasured one.

So this keys the population out and reports it on its own: green-dominant and
visibly chromatic, which in this scene is the ferns and the moss and nothing
else. Reference photographs are measured with the same key, so the comparison is
like for like rather than against a remembered impression of what wet understory
looks like.
"""
import sys
import numpy as np
from PIL import Image

print(f'  {"file":34s} {"%frame":>7s} {"medY":>6s} {"p90Y":>6s} {"medSat":>7s}')

for src in sys.argv[1:]:
    a = np.asarray(Image.open(src).convert('RGB'), dtype=np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a.max(axis=2), a.min(axis=2)
    sat = np.where(mx > 0.5, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    m = (g > r) & (g > b) & (sat > 0.18)
    name = '/'.join(src.replace('\\', '/').split('/')[-2:])
    if m.sum() < 500:
        print(f'  {name[:34]:34s}       —  no green-dominant population')
        continue
    y = (0.299 * r + 0.587 * g + 0.114 * b)[m]
    print(f'  {name[:34]:34s} {100 * m.mean():6.1f}% {np.median(y):6.1f} '
          f'{np.percentile(y, 90):6.1f} {np.median(sat[m]):7.3f}')
