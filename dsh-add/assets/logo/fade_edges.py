"""Fade a watercolour render into its surroundings, for a README on any theme.

The problem this solves: GitHub renders READMEs on white or on near-black, and a
flat cream paper background looks like a pasted rectangle on the dark one. So the
paper has to go transparent -- but not the whole paper:

* Watercolour spatter and washes are *also* near-paper-light. Keying every light
  pixel would delete the artwork's texture along with the background.
* The background here is the region connected to the canvas edge. Spatter sits
  inside the figure, so a flood fill from the border keeps it.
* The figure's outer edge is then faded, so the picture bleeds into whatever
  colour the page uses instead of ending on a hard rectangle.

Usage:
    python fade_edges.py INPUT --out OUT.png [--tol 30] [--fade 0.09] [--checks DIR]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


def paper_mask(bgr: np.ndarray, tol: int) -> np.ndarray:
    """Background = paper-coloured pixels connected to the canvas border."""
    height, width = bgr.shape[:2]
    paper = np.median(
        np.stack([bgr[0, 0], bgr[0, -1], bgr[-1, 0], bgr[-1, -1]]).astype(np.float32), axis=0
    )
    candidate = np.abs(bgr.astype(np.float32) - paper).max(axis=2) <= tol

    # Flood from every border pixel; the paper tooth and the soft gradient stay
    # inside the tolerance, while spatter and washes stop the fill.
    mask = np.zeros((height + 2, width + 2), np.uint8)
    flags = 4 | cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE | (255 << 8)
    seeds = [(x, 0) for x in range(0, width, 4)] + [(x, height - 1) for x in range(0, width, 4)]
    seeds += [(0, y) for y in range(0, height, 4)] + [(width - 1, y) for y in range(0, height, 4)]
    for seed in seeds:
        if mask[seed[1] + 1, seed[0] + 1] != 0:
            continue
        cv2.floodFill(bgr, mask, seed, 0, (tol,) * 3, (tol,) * 3, flags)
    reached = mask[1:-1, 1:-1] > 1

    # A pixel only counts as paper when it is both paper-coloured and reached.
    return reached & candidate


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("--out", required=True)
    parser.add_argument("--tol", type=int, default=30, help="per-channel spread still counted as paper")
    parser.add_argument("--fade", type=float, default=0.09, help="outer fraction of the image that fades out")
    parser.add_argument("--checks", default=None, help="directory for light/dark composites")
    args = parser.parse_args()

    bgr = cv2.imread(args.image, cv2.IMREAD_COLOR)
    if bgr is None:
        raise SystemExit(f"could not read {args.image}")
    height, width = bgr.shape[:2]
    paper = paper_mask(bgr, args.tol)
    print(f"image          : {width}x{height}")
    print(f"paper pixels   : {int(paper.sum())} ({paper.mean()*100:.1f}%)")

    alpha = np.where(paper, 0.0, 1.0).astype(np.float32)

    # Soften the cut by a hair so the paper edge does not stair-step. A narrow
    # threshold: a wide one leaves a broad translucent halo around the figure.
    alpha = cv2.GaussianBlur(alpha, (0, 0), sigmaX=1.2)
    alpha[paper & (alpha < 0.15)] = 0.0

    # Fade outward from the frame so the artwork melts into the page instead of
    # sitting in a rectangle. This is a coordinate ramp, NOT a distance transform:
    # the artwork has light regions inside it (apron, skin) that read as paper, so
    # a distance transform measures distance to those interior holes and drags the
    # whole figure toward translucent (measured: 26% partial instead of ~8%).
    fade = max(args.fade, 0.0)
    if fade > 0:
        y = np.arange(height, dtype=np.float32)[:, None]
        x = np.arange(width, dtype=np.float32)[None, :]
        edge_y = max(height * fade, 1.0)
        edge_x = max(width * fade, 1.0)
        ramp_y = np.minimum(np.minimum(y, height - 1 - y) / edge_y, 1.0)
        ramp_x = np.minimum(np.minimum(x, width - 1 - x) / edge_x, 1.0)
        ramp = np.minimum(ramp_x, ramp_y)
        ramp = np.clip(ramp, 0.0, 1.0) ** 1.35
        alpha = np.minimum(alpha, ramp)

    rgba = np.dstack([cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), (alpha * 255).astype(np.uint8)])
    image = Image.fromarray(rgba, mode="RGBA")
    image.save(args.out)
    print(f"transparent    : {float((alpha <= 0.01).mean())*100:.1f}%")
    print(f"partial        : {float(((alpha > 0.01) & (alpha < 0.99)).mean())*100:.1f}%")
    print(f"opaque         : {float((alpha >= 0.99).mean())*100:.1f}%")
    print(f"-> {args.out}")

    if args.checks:
        checks = Path(args.checks)
        checks.mkdir(parents=True, exist_ok=True)
        for name, colour in (("light", (255, 255, 255)), ("dark", (13, 17, 23))):
            canvas = Image.new("RGB", image.size, colour)
            canvas.paste(image, (0, 0), image)
            canvas.save(checks / f"readme-{name}.png")
        print(f"checks -> {checks} (light = GitHub light theme, dark = GitHub dark theme)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
