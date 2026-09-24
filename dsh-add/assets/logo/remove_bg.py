"""Cut the flat canvas background out of a render, keeping the figure intact.

Why not plain colour keying: on this image the apron is rgb(247,243,249) and the
skin highlight is close to it, only 3-5 units away from the background
rgb(248,248,232). A threshold on "distance to background" therefore eats holes
through the apron and the face. The background is only the region *connected to
the canvas edge*, so the cut is a flood fill from the border, not a colour test.

Alpha is continuous only in a narrow band along the cut edge, so anti-aliased
hair and frill edges fade out instead of getting a stair-stepped cut, while the
apron's near-background whites stay fully opaque.

Usage:
    python remove_bg.py INPUT --out OUT.png [--diff 34] [--band 6] [--check-dir DIR]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("--out", required=True)
    parser.add_argument("--diff", type=int, default=34, help="per-channel spread still counted as background")
    parser.add_argument("--band", type=float, default=6, help="edge band width in px for the alpha ramp")
    parser.add_argument("--check-dir", default=None)
    args = parser.parse_args()

    bgr = cv2.imread(args.image, cv2.IMREAD_COLOR)
    if bgr is None:
        raise SystemExit(f"could not read {args.image}")
    height, width = bgr.shape[:2]
    corner = np.median(
        np.stack([bgr[0, 0], bgr[0, -1], bgr[-1, 0], bgr[-1, -1]]).astype(np.float32), axis=0
    )

    # Flood fill from every border pixel so a background region pinched off in one
    # corner is still reached. FIXED_RANGE compares against the seed colour rather
    # than a running neighbour average, so the canvas gradient cannot walk inward.
    mask = np.zeros((height + 2, width + 2), np.uint8)
    flags = 4 | cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE | (255 << 8)
    border = [(x, 0) for x in range(0, width, 8)]
    border += [(x, height - 1) for x in range(0, width, 8)]
    border += [(0, y) for y in range(0, height, 8)]
    border += [(width - 1, y) for y in range(0, height, 8)]
    for seed in border:
        if mask[seed[1] + 1, seed[0] + 1] != 0:
            continue
        cv2.floodFill(bgr, mask, seed, 0, (args.diff,) * 3, (args.diff,) * 3, flags)
    # mask holds 255 where the fill reached, 1 on the unfilled boundary pixels
    # that stopped it, and 0 for seeds never tried -- so only 255 is background.
    # Treating the 1s as background swallows the whole figure.
    background = mask[1:-1, 1:-1] > 1

    # Alpha: opaque inside the figure, transparent outside, with a smooth ramp
    # only in a band straddling the cut edge. Interior near-background pixels (the
    # apron) are far from that edge, so they stay fully opaque.
    #
    # This uses erosion/dilation rather than a distance transform: the semantics
    # are visible in the call itself, whereas distanceTransform's zero-pixel
    # convention is easy to get backwards (it silentl returned 0 across the whole
    # figure here).
    fg = (~background).astype(np.uint8)
    band = max(args.band, 0.5)
    radius = int(round(band))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1))
    core = cv2.erode(fg, kernel)                      # deep inside: fully opaque
    grown = cv2.dilate(fg, kernel)                    # the hard edge plus its fringe
    outer = (grown > 0) & (fg == 0)                   # just outside the cut
    edge = (fg > 0) & (core == 0)                     # just inside the cut

    # A soft ramp across the cut: -1 at the outermost ring, 0 at the cut, +1 at core.
    ramp = np.zeros((height, width), np.float32)
    ramp[edge] = 1.0
    ramp[outer] = -1.0
    soft = cv2.GaussianBlur(ramp, (0, 0), sigmaX=max(band / 2.0, 0.6))
    alpha = np.zeros((height, width), np.float32)
    alpha[core > 0] = 1.0
    overlap = (edge | outer)
    alpha[overlap] = np.clip(0.5 + soft[overlap] * 0.5, 0.0, 1.0)
    alpha[fg == 0] = 0.0

    rgba = np.dstack([cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), (alpha * 255).astype(np.uint8)])
    image = Image.fromarray(rgba, mode="RGBA")
    image.save(args.out)

    print(f"image           : {width}x{height}")
    print(f"background      : {int(background.sum())} px ({background.mean()*100:.1f}%)")
    print(f"opaque coverage : {float((alpha > 0.99).mean())*100:.1f}%")
    print(f"feathered px    : {int(overlap.sum())}")
    print(f"alpha min/max   : {float(alpha.min()):.3f} / {float(alpha.max()):.3f}")
    print(f"-> {args.out}")

    if args.check_dir:
        check = Path(args.check_dir)
        check.mkdir(parents=True, exist_ok=True)
        for name, colour in (("dark", (22, 24, 30)), ("light", (252, 252, 252)), ("magenta", (255, 0, 255))):
            canvas = Image.new("RGB", image.size, colour)
            canvas.paste(image, (0, 0), image)
            target = check / f"edge-check-{name}.png"
            canvas.save(target)
        print(f"edge checks -> {check}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
