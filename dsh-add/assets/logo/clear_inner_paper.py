"""Clear the paper that survives *inside* the silhouette, e.g. between the legs.

fade_edges.py floods the paper from the canvas border, so it only reaches paper
connected to the outside. Paper enclosed by the figure -- the gap between the
legs, the gaps inside the hair -- is never visited and stays opaque, which reads
as leftover white background.

Colour alone cannot fix this on this artwork: the shadowed paper between the legs
is rgb(235,233,232) and the apron highlight is rgb(245,241,238). Their chroma is
the same (R-B +6 for both) and skin is +16, so neither hue nor saturation
separates them. Three things together do:

1. **Geometry** - paper inside the silhouette. The figure is closed
   morphologically to fill its own gaps; anything inside that solid shape but
   away from actual figure pixels is a candidate.
2. **Colour** - the leftover is not blank paper but its *shaded* form, 10-30 away
   from the corner colour, while the character's real whites sit at 4-8.
3. **Area** - the leftovers are large coherent regions (26k and 12.7k px here);
   the character's light touches are small and broken up.

Usage:
    python clear_inner_paper.py INPUT --out OUT.png [--mindist 13] [--minarea 400]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("--out", required=True)
    parser.add_argument("--paper-tol", type=int, default=12, help="distance from the corner colour that is blank paper")
    parser.add_argument("--mindist", type=int, default=13, help="shaded-paper distance floor")
    parser.add_argument("--maxdist", type=int, default=48, help="shaded-paper distance ceiling")
    parser.add_argument("--minarea", type=int, default=400, help="only clear blobs at least this large")
    parser.add_argument("--close", type=int, default=41, help="kernel that fills the silhouette's own gaps")
    parser.add_argument("--checks", default=None)
    args = parser.parse_args()

    rgba = cv2.imread(args.image, cv2.IMREAD_UNCHANGED)
    if rgba is None or rgba.shape[2] != 4:
        raise SystemExit(f"{args.image} is not RGBA")
    bgr = rgba[:, :, :3]
    alpha = rgba[:, :, 3]
    height, width = alpha.shape
    paper = np.median(np.stack([bgr[0, 0], bgr[0, -1], bgr[-1, 0], bgr[-1, -1]]).astype(np.float32), axis=0)
    distance = np.abs(bgr.astype(np.float32) - paper).max(axis=2)

    figure = (alpha > 40)
    # Fill the silhouette's own gaps so "inside" means inside the body outline.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (args.close, args.close))
    solid = cv2.morphologyEx(figure.astype(np.uint8), cv2.MORPH_CLOSE, kernel) > 0

    # Paper reachable from the canvas border: already transparent, ignore it.
    free = (alpha == 0).astype(np.uint8)
    reachable = np.zeros((height + 2, width + 2), np.uint8)
    cv2.floodFill(free, reachable, (0, 0), 2)
    outside = reachable[1:-1, 1:-1] > 0

    shaded = (distance >= args.mindist) & (distance <= args.maxdist)
    candidate = solid & shaded & (alpha > 0) & ~outside

    label, count = ndimage.label(candidate, structure=np.ones((3, 3)))
    sizes = ndimage.sum(candidate, label, range(1, count + 1))
    cleared = np.zeros_like(candidate)
    cleared_blobs = []
    for index, size in enumerate(sizes, start=1):
        if size < args.minarea:
            continue
        blob = label == index
        cleared |= blob
        ys, xs = np.where(blob)
        cleared_blobs.append((int(size), int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())))

    print(f"image        : {width}x{height}")
    print(f"shaded paper : {int(shaded.sum())} px;  candidates inside silhouette: {int(candidate.sum())} px in {count} blobs")
    print(f"cleared      : {int(cleared.sum())} px in {len(cleared_blobs)} blobs (>= {args.minarea} px)")
    for size, x1, y1, x2, y2 in sorted(cleared_blobs, reverse=True)[:8]:
        print(f"   {size:>6} px   x {x1}..{x2}  y {y1}..{y2}")

    out_alpha = alpha.copy()
    out_alpha[cleared] = 0
    out_alpha = cv2.GaussianBlur(out_alpha, (0, 0), sigmaX=1.0)
    out_alpha[cleared] = 0

    result = np.dstack([cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), out_alpha])
    Image.fromarray(result, mode="RGBA").save(args.out)
    print(f"-> {args.out}")

    if args.checks:
        checks = Path(args.checks)
        checks.mkdir(parents=True, exist_ok=True)
        image = Image.fromarray(result, mode="RGBA")
        for name, colour in (("light", (255, 255, 255)), ("dark", (13, 17, 23))):
            canvas = Image.new("RGB", image.size, colour)
            canvas.paste(image, (0, 0), image)
            canvas.save(checks / f"inner-{name}.png")
        print(f"checks -> {checks}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
