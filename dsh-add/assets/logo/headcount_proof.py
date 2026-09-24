"""Head-count measurement with a drawn proof, calibrated by eye.

measure_heads.py's automatic chin detector fails on this character (it reported
14.15 heads on a figure that is plainly ~3.5). The honest route is the one
documented for landmark_proof.py: draw candidate lines, look at the picture,
keep the reading that survives inspection.

This script computes the figure bounding box, then draws candidate skull / chin
lines and a head grid. Read the overlay, and if a line is off, pass a correction.

Usage:
    python headcount_proof.py IMAGE --out OUT.png [--skull 150] [--chin 480]
"""

from __future__ import annotations

import argparse

import numpy as np
from PIL import Image, ImageDraw


def foreground_mask(image: Image.Image, tol: int = 20) -> np.ndarray:
    array = np.asarray(image.convert("RGB")).astype(np.int16)
    corners = np.stack([array[0, 0], array[0, -1], array[-1, 0], array[-1, -1]])
    background = np.median(corners, axis=0)
    return np.abs(array - background).sum(axis=2) > tol * 3


def widest_run(mask: np.ndarray) -> tuple[int, int]:
    """The figure's column span, as the widest contiguous filled run."""
    cols = mask.any(axis=0)
    best = (0, 0)
    start = None
    for index, filled in enumerate(cols):
        if filled and start is None:
            start = index
        elif not filled and start is not None:
            if index - start > best[1] - best[0]:
                best = (start, index - 1)
            start = None
    if start is not None and len(cols) - start > best[1] - best[0]:
        best = (start, len(cols) - 1)
    return best


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("--out", required=True)
    parser.add_argument("--skull", type=int, default=None, help="skull-top y in pixels")
    parser.add_argument("--chin", type=int, default=None, help="chin y in pixels")
    args = parser.parse_args()

    image = Image.open(args.image).convert("RGB")
    mask = foreground_mask(image)
    left, right = widest_run(mask)
    rows = np.where(mask[:, left : right + 1].any(axis=1))[0]
    top, bottom = int(rows[0]), int(rows[-1])
    height = bottom - top + 1

    print(f"figure: columns {left}..{right}, rows {top}..{bottom} (height {height}px)")

    # Candidates: the ahoge is the topmost blob; the skull is where the head's
    # width becomes substantial, and the chin where it pinches before shoulders.
    widths = np.array([mask[y, left : right + 1].sum() for y in range(top, bottom + 1)])
    arm = max(6, height // 100)
    smooth = np.convolve(widths, np.ones(arm) / arm, mode="same")
    peak = int(np.argmax(smooth))
    skull_guess = top + int(np.argmax(smooth > smooth[peak] * 0.45))
    chin_guess = top + peak if args.chin is None else args.chin
    skull = skull_guess if args.skull is None else args.skull

    head = chin_guess - skull
    heads = height / head if head > 0 else float("nan")
    print(f"skull line : y={skull}   (width there {widths[skull - top]}px)")
    print(f"chin line  : y={chin_guess}   (width there {widths[chin_guess - top]}px)")
    print(f"head height: {head}px")
    print(f"HEADS      : {heads:.2f}   [head = skull->chin, figure = bbox]")

    draw = ImageDraw.Draw(image)
    for y, colour, label in ((skull, (255, 0, 0), "SKULL"), (chin_guess, (0, 128, 255), "CHIN")):
        draw.line([(left, y), (right, y)], fill=colour, width=4)
        draw.text((left + 6, y - 26), label, fill=colour)

    # Head grid downward from the skull: shows how many head-units fit.
    step = head
    y = skull
    index = 0
    while y <= bottom:
        draw.line([(left, y), (right, y)], fill=(0, 200, 0), width=2)
        draw.text((right - 60, y + 4), str(index), fill=(0, 200, 0))
        y += step
        index += 1
    draw.line([(left, bottom), (right, bottom)], fill=(255, 0, 255), width=4)
    draw.text((left + 6, bottom - 26), "SOLES", fill=(255, 0, 255))

    image.save(args.out)
    print(f"overlay -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
