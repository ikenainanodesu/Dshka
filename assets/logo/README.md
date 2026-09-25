# DSHKA artwork

**English** · [简体中文](README.zh-CN.md) · [DSHKA home](../../README.md)

## README portrait

[logo-waist.png](logo-waist.png) is a **768 × 784 RGBA** waist-up crop of the original [logo.png](logo.png), displayed at **420 CSS pixels wide** in the README (shrinking to fit narrow screens). The larger portrait keeps the face, headdress, hands and waistband readable. Clicking it opens the full master.

Crop rectangle in the 1024 × 1536 source: **left 96, top 0, right 864, bottom 784**, with right/bottom exclusive. It is a direct pixel crop: no resampling, recolouring, repainting or alpha repair. The master and all pre-existing PNG variants remain unchanged.

To reproduce it with Python and Pillow:

```sh
python assets/logo/crop_logo.py
```

The [crop script](crop_logo.py) checks source size/mode, output dimensions, pixel equality and the unchanged source hash. It refuses to overwrite differing output; use `--output <new-file.png>` for a new variant. This is optional artwork maintenance, not a plugin runtime dependency.

## Preserved originals

| Asset | Dimensions | Use |
|---|---|---|
| [logo.png](logo.png) | 1024 × 1536 | Transparent full-body master |
| [logo-800.png](logo-800.png) | 800 × 1200 | Large portrait |
| [logo-400.png](logo-400.png) | 400 × 600 | Medium portrait |
| [logo-200.png](logo-200.png) | 200 × 300 | Small portrait |
| [logo-square-512.png](logo-square-512.png) | 512 × 512 | Square avatar |
| [logo-square-128.png](logo-square-128.png) | 128 × 128 | Small square avatar |

Do not run the old historical square-image helper against these files: it discarded transparency and could overwrite the master. Original pre-keying renders and identity references are not in this checkout, so this crop is reproducible but the original artwork-generation/alpha-repair process is not.

## Attribution & permissions

The existing artwork notice describes the community character **“DeepSeek whale-chan”**, credits the character design and artwork to their original authors, states **CC-BY-NC-SA 4.0** with separate permission needed for commercial use, and records generation via the OpenAI Codex subscription.

This historical notice is retained, **not independently verified**: the original author/source link is absent from this checkout. Confirm attribution and permissions before redistribution. The [code's MIT license](../../LICENSE) does **not** grant rights to the artwork.
