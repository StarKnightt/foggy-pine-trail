"""Crop, magnify and brighten a capture so it can actually be judged.

    python tools/mag.py shots/s4c/close.png 0.55 0.45 0.25 --gain 2.4 --out /tmp/a.png

The four positional numbers after the file are the crop rectangle as fractions
of the frame: left, top, width (height follows from the frame's aspect).

This exists because a 6am fog scene delivers its whole subject between display
values 20 and 90, and judging a near-black fern against a near-black floor from
a downscaled 1600x900 thumbnail is judging the downscaler. Every finding in
this system that turned out to be wrong was made from an unbrightened frame.

The gain is applied in *display* space and is deliberately a plain multiply
rather than a curve: the point is to see the relationships that are already
there, and a curve would change them.
"""
import sys
from PIL import Image, ImageEnhance

args = [a for a in sys.argv[1:] if not a.startswith('--')]
flags = {sys.argv[i]: sys.argv[i + 1] for i in range(len(sys.argv) - 1)
         if sys.argv[i].startswith('--')}

src = args[0]
l, t, w = (float(x) for x in args[1:4]) if len(args) >= 4 else (0.0, 0.0, 1.0)
gain = float(flags.get('--gain', 2.2))
out = flags.get('--out', 'shots/_mag.png')
scale = float(flags.get('--scale', 2.0))

im = Image.open(src).convert('RGB')
W, H = im.size
h = w * (H / W)
box = (int(l * W), int(t * H), int((l + w) * W), int(min(1.0, t + h) * H))
im = im.crop(box)
im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
im = ImageEnhance.Brightness(im).enhance(gain)
im.save(out)
print(f'{src} {box} -> {out} {im.size} gain={gain}')
