"""Choose the grade's tone curve against the frame's own histogram, before
writing any GLSL.

    python tools/curve.py shots/s8base/42.png --sweep
    python tools/curve.py shots/s8base/*.png --gain 1.3 --lift 0.8 --knee 0.09

The three terms on the tone side of the grade -- a pre-AgX exposure gain, a
post-AgX shadow lift and a black point -- are all monotone functions of a
single scalar, so their combined effect on the luma histogram can be computed
exactly from a 256-bin histogram of the ungraded frame. Sweeping them here
costs milliseconds. Sweeping them by editing a shader, waiting for the dev
server and re-capturing costs about ninety seconds a step, which is the
difference between choosing a curve and settling for the first one that looked
all right.

What this cannot do is chroma -- it works on luma alone -- and that is fine,
because the curve is deliberately applied to luminance with the channels
carried in proportion, which leaves HSV saturation exactly invariant. The
saturation column in palette.py is the check that it really did.

The AgX here is three's, on the neutral axis only. All four of its matrices
have unit row sums, so a neutral input is neutral throughout and only the log
encode and the sigmoid matter. The chroma restore in fog.ts is a saturation
about the luma of the log-encoded value, so it is the identity on that axis and
does not enter.
"""
import sys
import numpy as np
from PIL import Image

flags = {sys.argv[i]: sys.argv[i + 1] for i in range(len(sys.argv) - 1)
         if sys.argv[i].startswith('--')}
skip = set()
for i, a in enumerate(sys.argv):
    if a.startswith('--') and a != '--sweep':
        skip |= {i, i + 1}
    elif a == '--sweep':
        skip.add(i)
files = [a for i, a in enumerate(sys.argv) if i and i not in skip]

GAIN = float(flags.get('--gain', 1.0))
LIFT = float(flags.get('--lift', 0.0))
KNEE = float(flags.get('--knee', 0.06))
BLACK = float(flags.get('--black', 0.0))
SWEEP = '--sweep' in sys.argv


def sigmoid(x):
    x2 = x * x
    x4 = x2 * x2
    return (15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
            - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232)


def agx(v, e):
    c = np.maximum(v * e, 1e-10)
    c = (np.log2(c) + 12.47393) / 16.5
    c = np.clip(c, 0.0, 1.0)
    return np.power(np.maximum(sigmoid(c), 0.0), 2.2)


def lin2s(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.maximum(c, 0), 1 / 2.4) - 0.055)


def cv_of(v, e):
    return 255 * lin2s(np.minimum(agx(v, e), 1.0))


# The scene radiance behind each code value at unit gain. AgX is monotone in
# radiance, so a bisection on the whole 0..255 vector at once is exact.
_lo = np.full(256, 1e-7)
_hi = np.full(256, 1e4)
_t = np.arange(256, dtype=np.float64)
for _ in range(90):
    _m = np.sqrt(_lo * _hi)
    below = cv_of(_m, 1.0) < _t
    _lo = np.where(below, _m, _lo)
    _hi = np.where(below, _hi, _m)
RADIANCE = np.sqrt(_lo * _hi)


def tone_lut(gain, lift, knee, black):
    """The whole tone chain as a 256-entry code value -> code value table."""
    y = agx(RADIANCE, gain)
    y = np.maximum(y - black, 0.0) / max(1e-6, 1.0 - black)
    y = y * (1.0 + lift * np.exp(-y / max(1e-4, knee)))
    return np.clip(np.round(255 * lin2s(np.minimum(y, 1.0))), 0, 255).astype(int)


def hist_of(path):
    a = np.asarray(Image.open(path).convert('RGB'), dtype=np.float32)
    y = a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114
    h, _ = np.histogram(np.clip(np.round(y), 0, 255), bins=256, range=(0, 256))
    return h / h.sum()


def stats(h, lut):
    out = np.zeros(256)
    np.add.at(out, lut, h)
    cum = np.cumsum(out)
    q = lambda p: int(np.searchsorted(cum, p))
    return (100 * out[181:].sum(), 100 * out[70:151].sum(), 100 * out[:70].sum(),
            q(0.01), q(0.5), q(0.99))


hists = [(f.replace('\\', '/').split('/')[-1], hist_of(f)) for f in files]

SETS = [
    (1.00, 0.00, 0.100, 0.0),
    (1.00, 1.05, 0.100, 0.0),
    (1.00, 0.60, 0.035, 0.0),
    (1.00, 0.85, 0.035, 0.0),
    (1.00, 1.20, 0.035, 0.0),
    (1.00, 0.85, 0.055, 0.0),
    (1.00, 0.60, 0.055, 0.0),
    (1.00, 0.45, 0.090, 0.0),
] if SWEEP else [(GAIN, LIFT, KNEE, BLACK)]

print('\n  reference band: >180 7-13%,  70-150 32-69%')
print('  r2 cypress (closest analogue): >180 9.0%  70-150 40.4%  <70 29.3%  '
      'p1 5  med 106  p99 230\n')

for g, li, k, b in SETS:
    lut = tone_lut(g, li, k, b)
    print(f'  gain {g:4.2f}  lift {li:3.1f}  knee {k:4.2f}  black {b:5.3f}')
    for name, h in hists:
        a, m, d, p1, med, p99 = stats(h, lut)
        print(f'    {name[:14]:14s} >180 {a:5.1f}%  70-150 {m:5.1f}%  <70 {d:5.1f}%  '
              f'p1 {p1:3d}  med {med:3d}  p99 {p99:3d}')
print('')
