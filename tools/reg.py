"""Median luma and chroma of named rectangles in a capture.

    python tools/reg.py shots/s2h/78.png 0.10,0.55,0.06,0.20 0.60,0.80,0.20,0.10

Each rectangle is left,top,width,height as fractions of the frame. Reports the
median display luma, the median HLS saturation, and the mean r-b, which is the
one number that separates a warm boot-worn tread from the cold vegetation
either side of it -- the reference photographs run +37 on the tread and +73 to
+80 on the plants, and a scene that measures zero has no path cue in it at all.

Medians rather than means throughout: every rectangle in this scene contains
some fraction of bright air, and a mean over a fern crown against 193 fog is a
statement about the gaps.
"""
import colorsys
import sys
from PIL import Image

flags = {sys.argv[i]: sys.argv[i + 1] for i in range(len(sys.argv) - 1)
         if sys.argv[i].startswith('--')}
skip = set()
for i, a in enumerate(sys.argv):
    if a.startswith('--'):
        skip |= {i, i + 1}
args = [a for i, a in enumerate(sys.argv) if i and i not in skip]

src = args[0]
rects = args[1:] or ['0,0,1,1']

im = Image.open(src).convert('RGB')
W, H = im.size
print(f'{src} {W}x{H}')
for spec in rects:
    l, t, w, h = (float(v) for v in spec.split(','))
    box = im.crop((int(l * W), int(t * H), int((l + w) * W), int((t + h) * H)))
    px = list(box.getdata())
    lum = sorted(0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in px)
    sat = sorted(colorsys.rgb_to_hls(r / 255, g / 255, b / 255)[2] for r, g, b in px)
    rb = sum(r - b for r, g, b in px) / len(px)
    hot = sum(1 for s in sat if s > 0.15) / len(sat)
    n = len(px)
    print(f'  {spec:<28} lum med {lum[n // 2]:5.1f}  p10 {lum[n // 10]:5.1f}'
          f'  p90 {lum[n * 9 // 10]:5.1f}   sat med {sat[n // 2]:.3f}'
          f'  >0.15 {hot * 100:4.1f}%   r-b {rb:+.1f}')
