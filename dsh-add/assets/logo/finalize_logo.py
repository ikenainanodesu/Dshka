"""Downscale the chosen logo into the sizes an icon actually needs.

Nearest-neighbour would wreck the line work, so this is a Lanczos resample with
a mild unsharp pass to keep the outlines from going soft at small sizes.

Usage:
    python finalize_logo.py SOURCE --out-dir DIR
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageFilter


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--sizes", default="512,256,128")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    source = Image.open(args.source).convert("RGB")
    print(f"source: {source.width}x{source.height}")

    for size in (int(value) for value in args.sizes.split(",")):
        resized = source.resize((size, size), Image.LANCZOS)
        # A small radius only: enough to restore edge contrast lost in the
        # resample, not enough to halo.
        resized = resized.filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=3))
        target = out_dir / f"logo-{size}.png"
        resized.save(target, optimize=True)
        print(f"  -> {target.name}  {target.stat().st_size // 1024} KB")

    canonical = out_dir / "logo.png"
    source.resize((512, 512), Image.LANCZOS).save(canonical, optimize=True)
    print(f"  -> {canonical.name}  {canonical.stat().st_size // 1024} KB  (canonical, 512px)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
