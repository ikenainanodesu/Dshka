"""Clear the blank paper left inside the hair, where the strands enclose it.

fade_edges.py floods paper in from the canvas border, so paper enclosed by the
figure is never reached. On this render the leftovers sit between the hair
strands hanging beside the head, below the fins.

Why the obvious tests fail here (all measured on this image):
* Distance to the corner colour: the leftovers are blank paper, R-B -1..+1, while
  the face is a warm white at R-B +6..+13 - so chroma does separate the face, but
  the apron, socks and headdress lace are neutral too (R-B 0..+1) and DO collide
  with the leftovers.
* Geometry alone (inside the closed silhouette): catches the face and the apron.
* Area alone: the apron is the largest near-white blob in the image.

What does work is three filters together, ordered so each removes a specific
false positive:
1. neutral white (min channel >= 238 and |R-B| <= 2) - drops the warm face and
   the blue-tinted watercolour edges;
2. not reachable from the canvas border **through neutral white only** - the
   flood fill must see the whole neutral set before any region limit is applied,
   otherwise the strands cut the outer background off from the border and the
   entire outside is misread as enclosed;
3. a region window that excludes the fin and collar lace (y 430..760, x < 330 or
   x > 700) and a size window (100..3000 px), leaving the small strand gaps and
   discarding the apron-sized whites.

Usage:
    python clear_hair_paper.py INPUT --out OUT.png [--checks DIR] [--min-area 100]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

# Region that holds the hair gaps on the 1024x1536 render, clear of both lacings.
HAIR_BAND = (430, 760, 330, 700)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("--out", required=True)
    parser.add_argument("--band", default=None, help="y1,y2,xleft,xright (overrides the default window)")
    parser.add_argument("--min-area", type=int, default=100)
    parser.add_argument("--max-area", type=int, default=3000)
    parser.add_argument("--tone", type=int, default=238, help="min channel for 'blank paper'")
    parser.add_argument("--chroma", type=int, default=2, help="max |R-B| for 'blank paper'")
    parser.add_argument("--checks", default=None)
    args = parser.parse_args()

    rgba = cv2.imread(args.image, cv2.IMREAD_UNCHANGED)
    if rgba is None or rgba.shape[2] != 4:
        raise SystemExit(f"{args.image} is not RGBA")
    rgb = rgba[:, :, :3].astype(np.int16)
    alpha = rgba[:, :, 3]
    height, width = alpha.shape

    neutral = (rgb.min(axis=2) >= args.tone) & (np.abs(rgb[:, :, 0] - rgb[:, :, 2]) <= args.chroma)
    # Flood the whole neutral set from the border BEFORE any region limit.
    free = neutral.astype(np.uint8)
    reach = np.zeros((height + 2, width + 2), np.uint8)
    cv2.floodFill(free, reach, (0, 0), 2)
    enclosed = neutral & ~(reach[1:-1, 1:-1] > 0)

    y1, y2, xl, xr = (int(v) for v in (args.band.split(",") if args.band else HAIR_BAND))
    ys = np.arange(height)[:, None]
    xs = np.arange(width)[None, :]
    window = (ys >= y1) & (ys < y2) & ((xs < xl) | (xs > xr))
    candidates = enclosed & window & (alpha > 0)

    label, count = ndimage.label(candidates, structure=np.ones((3, 3)))
    sizes = ndimage.sum(candidates, label, range(1, count + 1)) if count else []
    cleared = np.zeros_like(candidates)
    kept = []
    for index, size in enumerate(sizes, start=1):
        if size < args.min_area or size > args.max_area:
            continue
        cleared |= label == index
        ys_, xs_ = np.where(label == index)
        kept.append((int(size), int(xs_.min()), int(ys_.min()), int(xs_.max()), int(ys_.max())))

    print(f"image            : {width}x{height}")
    print(f"neutral white    : {neutral.mean()*100:.1f}%   enclosed by figure: {int(enclosed.sum())} px")
    print(f"window           : y {y1}..{y2}, x < {xl} or x > {xr}   candidates {int(candidates.sum())} px in {count} blobs")
    print(f"cleared          : {int(cleared.sum())} px in {len(kept)} blobs")
    for size, x1, yy1, x2, yy2 in sorted(kept, reverse=True)[:8]:
        print(f"   {size:>5} px  x {x1}..{x2}  y {yy1}..{yy2}")

    out_alpha = alpha.copy()
    out_alpha[cleared] = 0
    out_alpha = cv2.GaussianBlur(out_alpha, (0, 0), sigmaX=0.8)
    out_alpha[cleared] = 0

    result = np.dstack([rgb.astype(np.uint8)[:, :, ::-1], out_alpha])
    Image.fromarray(result, mode="RGBA").save(args.out)
    print(f"-> {args.out}")

    if args.checks:
        checks = Path(args.checks)
        checks.mkdir(parents=True, exist_ok=True)
        image = Image.fromarray(result, mode="RGBA")
        for name, colour in (("light", (255, 255, 255)), ("dark", (13, 17, 23))):
            canvas = Image.new("RGB", image.size, colour)
            canvas.paste(image, (0, 0), image)
            canvas.save(checks / f"hair-{name}.png")
        print(f"checks -> {checks}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
