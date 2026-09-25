"""Build the README waist-up portrait by cropping the unchanged RGBA master.

Requires Pillow; no model, resampling, alpha repair, or repainting is involved.
Run from any directory: python assets/logo/crop_logo.py
Existing non-identical output is never overwritten: choose a new OUTPUT path.
"""
from pathlib import Path
from hashlib import sha256
import argparse
from PIL import Image

ROOT = Path(__file__).resolve().parent
# Full ahoge/headdress, side hair, hands and waistband; stop below the waist.
CROP = (96, 0, 864, 784)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'logo-waist.png')
    args = parser.parse_args()
    source = ROOT / 'logo.png'
    output = args.output.resolve()
    if output == source.resolve():
        raise ValueError('Refusing to overwrite the master')
    original_hash = sha256(source.read_bytes()).hexdigest()
    with Image.open(source) as image:
        if image.size != (1024, 1536) or image.mode != 'RGBA':
            raise ValueError('This crop is calibrated for the 1024x1536 RGBA master')
        portrait = image.crop(CROP)
        if output.exists():
            with Image.open(output) as previous:
                if previous.mode != portrait.mode or previous.size != portrait.size or previous.tobytes() != portrait.tobytes():
                    raise ValueError('Output exists and differs; use a new --output path for review')
        else:
            output.parent.mkdir(parents=True, exist_ok=True)
            portrait.save(output, optimize=True)
        with Image.open(output) as result:
            assert result.mode == 'RGBA'
            assert result.size == (768, 784)
            assert result.tobytes() == image.crop(CROP).tobytes(), 'RGBA pixels changed'
    assert sha256(source.read_bytes()).hexdigest() == original_hash, 'Master changed'
    print(f'PASS: {output.name}: 768x784 RGBA; crop={CROP}; exact source pixels; master unchanged')
    print(f'Master SHA256: {original_hash}')


if __name__ == '__main__':
    main()
