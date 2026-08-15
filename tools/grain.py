"""How much grain is actually in the delivered frame, and where.

    python tools/grain.py shots/s8a/42.png shots/s8base/42.png

Grain is the one term in System 8 that a screenshot cannot settle: at the
amplitude it is supposed to have it is invisible at presentation size and
unmissable at 4x, and both of those are true of a term that is far too strong
and of one that has been quantised away entirely. So it is measured.

The instrument is a high-pass: subtract a 3x3 box mean and take the standard
deviation of what is left, which is the pixel-to-pixel excursion and nothing
else. Scene detail does not survive it in a flat field, so the number in the
*flattest* window in the frame is the grain and very little besides.

Three windows, because the model has three different amplitudes and reporting
one of them would hide the other two:

  flat/bright   the fog, which is two thirds of the frame, is a large flat
                bright field, and grain there is the most visible and least
                welcome. Found by search rather than by hand: the 48x48 window
                with the lowest high-pass energy above code value 120.
  flat/dark     the same search below code value 55, which is where a phone's
                read noise actually lives and where the amplitude is supposed
                to be several times higher.
  whole frame   for scale.

A frozen pair — the same camera rendered twice — is the other half of the
question, and `fogdiff.mjs --b post=nograin` answers it: a grain that measures
0.0 there is one that was rounded away before it reached the file, which is a
failure this project's reference notes record having shipped.
"""
import sys
import numpy as np
from PIL import Image
from numpy.lib.stride_tricks import sliding_window_view

WIN = 48


def highpass(y):
    box = sliding_window_view(y, (3, 3)).mean(axis=(2, 3))
    return y[1:-1, 1:-1] - box


for src in sys.argv[1:]:
    a = np.asarray(Image.open(src).convert('RGB'), dtype=np.float32)
    y = a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114
    hp = highpass(y)
    H, W = hp.shape

    def flattest(lo, hi):
        best, at = None, None
        for j in range(0, H - WIN, 24):
            for i in range(0, W - WIN, 24):
                tile = y[j + 1:j + 1 + WIN, i + 1:i + 1 + WIN]
                m = tile.mean()
                if m < lo or m > hi:
                    continue
                r = float(hp[j:j + WIN, i:i + WIN].std())
                if best is None or r < best:
                    best, at = r, (i, j, m)
        return best, at

    bright, ba = flattest(120, 250)
    dark, da = flattest(0, 55)
    name = src.replace('\\', '/').split('/')[-1]
    parent = src.replace('\\', '/').split('/')[-2]
    print(f'  {parent}/{name}')
    for tag, r, at in (('bright', bright, ba), ('dark  ', dark, da)):
        if r is None:
            print(f'    {tag}  no window in band')
        else:
            print(f'    {tag}  hp RMS {r:5.3f} CV   at {at[0]:4d},{at[1]:4d}  mean {at[2]:5.1f}')
    print(f'    frame   hp RMS {hp.std():5.3f} CV')
