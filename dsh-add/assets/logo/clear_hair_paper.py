"""Clear blank paper enclosed by hair strands -- and only by hair strands.

The first version of this keyed out near-white blobs inside a positional window.
That window also contained white lace (the skirt trim at the waist, the sleeve
frill), and since lace white and leftover paper white are the same neutral white
(min channel 253-254, |R-B| <= 1), the lace was keyed out too: a real regression,
visible as holes in the skirt.

Colour cannot separate them, and neither can "is it enclosed" -- both are. What
does separate them is what surrounds them:

* a leftover between strands is ringed by hair, which is dark (luma well under
  160) and blue;
* white lace is ringed by more white and by cloth, not by hair.

So a blob is only cleared when a high fraction of the opaque pixels around it are
hair-dark. Measured on this render, the genuine strand gaps sit at 85-100% hair
in the ring; the lace blob that was wrongly cleared sits at 10-40%.

Usage:
    python clear_hair_paper.py INPUT --out OUT.png [--ring 7] [--min-hair 0.6]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

# Window that contains the strand gaps, clear of the fin and collar lace.
HAIR_BAND = (400, 800, 340, 700)


def ring_hair_fraction(mask: np.ndarray, opaque: np.ndarray, rgb: np.ndarray, inner: int, outer: int) -> float:
    """Fraction of the opaque ring around a blob that is hair-dark and blue.

    `rgb` must be in RGB order. OpenCV hands back BGR, and getting this backwards
    silently returns 0% for every blob (the blue test becomes R-B, which is
    negative for blue pixels), which is exactly how the first version of this
    filter managed to clear nothing at all.
    """
    kernel_in = np.ones((inner, inner), np.uint8)
    kernel_out = np.ones((outer, outer), np.uint8)
    ring = (cv2.dilate(mask, kernel_out) > 0) & (cv2.erode(mask, kernel_in) == 0)
    ring &= opaque
    count = int(ring.sum())
    if count == 0:
        return 0.0
    pixels = rgb[ring].astype(np.int16)
    luma = pixels.mean(axis=1)
    blue = (pixels[:, 2] - pixels[:, 0]) > 25          # RGB order: channel 2 is blue
    return float(((luma < 160) & blue).mean())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("--out", required=True)
    parser.add_argument("--band", default=None, help="y1,y2,xleft,xright")
    parser.add_argument("--min-area", type=int, default=60)
    parser.add_argument("--max-area", type=int, default=3000)
    parser.add_argument("--tone", type=int, default=228)
    parser.add_argument("--chroma", type=int, default=6)
    parser.add_argument("--ring", type=int, default=7)
    parser.add_argument("--min-hair", type=float, default=0.6, help="required hair fraction in the ring")
    parser.add_argument("--checks", default=None)
    parser.add_argument("--report", action="store_true")
    args = parser.parse_args()

    rgba = cv2.imread(args.image, cv2.IMREAD_UNCHANGED)
    if rgba is None or rgba.shape[2] != 4:
        raise SystemExit(f"{args.image} is not RGBA")
    alpha = rgba[:, :, 3]
    # Work in RGB from here on: colour tests below read channel 2 as blue, and
    # OpenCV's native order would make every one of them wrong.
    rgb = cv2.cvtColor(rgba[:, :, :3], cv2.COLOR_BGR2RGB)
    height, width = alpha.shape
    opaque = alpha > 128

    neutral = (rgb.min(axis=2) >= args.tone) & (np.abs(rgb[:, :, 0].astype(np.int16) - rgb[:, :, 2]) <= args.chroma)
    free = neutral.astype(np.uint8)
    reach = np.zeros((height + 2, width + 2), np.uint8)
    cv2.floodFill(free, reach, (0, 0), 2)
    enclosed = neutral & ~(reach[1:-1, 1:-1] > 0)

    y1, y2, xl, xr = (int(v) for v in (args.band.split(",") if args.band else HAIR_BAND))
    ys = np.arange(height)[:, None]
    xs = np.arange(width)[None, :]
    window = (ys >= y1) & (ys < y2) & ((xs < xl) | (xs > xr))
    candidates = enclosed & window & opaque

    label, count = ndimage.label(candidates, structure=np.ones((3, 3)))
    sizes = ndimage.sum(candidates, label, range(1, count + 1)) if count else []
    cleared = np.zeros_like(candidates)
    kept, dropped = [], []
    for index, size in enumerate(sizes, start=1):
        if size < args.min_area or size > args.max_area:
            continue
        blob = (label == index).astype(np.uint8)
        fraction = ring_hair_fraction(blob, opaque, rgb, args.ring, args.ring * 3)
        yy, xx = np.where(blob > 0)
        entry = (int(size), int(xx.min()), int(yy.min()), int(xx.max()), int(yy.max()), fraction)
        if fraction >= args.min_hair:
            cleared |= blob > 0
            kept.append(entry)
        else:
            dropped.append(entry)

    print(f"image        : {width}x{height}")
    print(f"window       : y {y1}..{y2}, x < {xl} or x > {xr}   candidates {int(candidates.sum())} px / {count} blobs")
    print(f"cleared      : {int(cleared.sum())} px in {len(kept)} blobs (hair-ringed)")
    for size, x1, yy1, x2, yy2, frac in sorted(kept, reverse=True)[:12]:
        print(f"   keep {size:>5} px  x {x1}..{x2}  y {yy1}..{yy2}  hair in ring {frac*100:3.0f}%")
    print(f"dropped      : {len(dropped)} blobs kept opaque (not ringed by hair)")
    for size, x1, yy1, x2, yy2, frac in sorted(dropped, reverse=True)[:8]:
        print(f"   drop {size:>5} px  x {x1}..{x2}  y {yy1}..{yy2}  hair in ring {frac*100:3.0f}%")

    out_alpha = alpha.copy()
    out_alpha[cleared] = 0
    out_alpha = cv2.GaussianBlur(out_alpha, (0, 0), sigmaX=0.8)
    out_alpha[cleared] = 0

    result = np.dstack([rgb, out_alpha])
    Image.fromarray(result, mode="RGBA").save(args.out)
    print(f"-> {args.out}")

    if args.checks:
        checks = Path(args.checks)
        checks.mkdir(parents=True, exist_ok=True)
        image = Image.fromarray(result, mode="RGBA")
        for name, colour in (("light", (255, 255, 255)), ("dark", (13, 17, 23))):
            canvas = Image.new("RGB", image.size, colour)
            canvas.paste(image, (0, 0), image)
            canvas.save(checks / f"hair2-{name}.png")
        print(f"checks -> {checks}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
