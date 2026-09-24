# dsh-add

**English** | [简体中文](README.zh.md)

<img src="assets/logo/logo.png" alt="dsh-add: chibi DeepSeek whale-chan picking one plugin cartridge out of several identical ones" width="320">

Install a [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) plugin **by name**.

```sh
npx dsh-add dsh-engram
```

It resolves "the community plugin called this" into an installable spec and hands that spec to DSH's own `dsh plugin add`. It does **not** re-implement installation; it solves the *by name* part.

## Why

DSH already installs plugins — once you know the spec:

```sh
dsh plugin --profile web add github:CAI-MH/dsh-quality-review
```

The community registry ([awesome-dsh-plugin.com](https://awesome-dsh-plugin.com); **4279 entries** measured on 2026-09-24) is indexed by *name*, and names are **not unique**: that same day the registry contained **186 name collisions**, with `dsh-memory` alone naming **ten different plugins** (`@furongjun1999/dsh-memory`, `@max-null/dsh-memory`, `dsh-git-memory`, …) and `dsh-engram` naming two. Guessing a spec from a name is how you install the wrong plugin confidently.

`dsh-add` turns that step into a checkable decision:

| Step | What it does |
|---|---|
| Resolve | Exact match on display name, npm package, `owner/repo`, or `owner/name`; substring match as a fallback |
| Rank | Exact first, then measured downloads and stars |
| Disambiguate | The leader installs automatically only when it has ≥2× the runner-up's downloads; otherwise you get a candidate list — it never guesses |
| Install | Always `dsh plugin --profile <p> add <spec>`, with the spec taken from the registry author's own `install` field |
| Verify | Reads the profile manifest before and after and reports **what actually changed**, not just the exit code |

## Install

```sh
npx dsh-add <name>

# or
npm install -g dsh-add
```

Requires Node.js `>=22.19.0`. No runtime dependencies — Node builtins only.

## Usage

```sh
dsh-add dsh-engram                          # sole exact match: installs
dsh-add dsh-memory --owner FuRongJun-1999   # ten namesakes: disambiguate by author
dsh-add search engram                       # search the registry, by downloads
dsh-add info dsh-memory                     # show candidates and the command, install nothing
dsh-add list                                # plugins installed in every profile
dsh-add --spec ./my-plugin                  # a plugin still in development
```

| Option | Meaning |
|---|---|
| `--profile <name>` | Install into this profile (default: chosen, and the reason printed) |
| `--owner <owner>` | Disambiguate by author |
| `--spec <spec>` | Skip name resolution and install this spec (path / git / npm name) |
| `--dry-run` | Print the command without running it |
| `--allow-build` | When pnpm blocks a build script, add the `allowBuilds` key and retry |
| `--refresh` | Ignore the cache and refetch the registry |
| `--json` | Machine-readable output |

Output language follows `$DSH_ADD_LANG` or `$LANG`; Chinese when it contains `zh`, English otherwise.

## Which profile

First available wins, and the reason is printed:

1. `--profile`
2. `$DSH_PROFILE`
3. The only initialized profile
4. The only profile with plugins installed
5. `web`

Rule 4 precedes the name `web` on purpose: `web` is the DSH default, so favouring the name would send installs into a profile you may never boot.

## Did it actually take effect?

Exit code 0 is **not** success — `dsh plugin` returns 0 as soon as pnpm succeeds. `dsh-add` therefore diffs the profile's `package.json` and reports one of three outcomes:

- **Activated as a profile layer** (present in `dsh.profile.bundles`) — loads after a dsh restart
- **A plain dependency** (the package declares no `dsh.bundle`) — it will not become a profile layer
- **Dependencies unchanged** — treated as failure, with a non-zero exit code

Package names are not inferred from the spec alone: verification reads what is actually in the profile's `node_modules`, and uses the pre-install dependency set as a baseline so a package that was already there is never credited to this install.

## Known limitations

- **It depends on a third-party registry.** The name→spec mapping comes from `awesome-dsh-plugin.com`. When the site is unreachable only the local cache remains; with neither, the command fails and says why. The cache lives under `$DSH_HOME/cache/dsh-add` (override with `$DSH_ADD_CACHE`) and defaults to 12 hours.
- **Downloads are the confidence signal.** When the leader has less than 2× the runner-up's downloads — or neither has download data — nothing is installed automatically; it asks instead. Non-interactively it lists candidates and fails rather than guessing.
- **`search` is substring matching**, ranked by downloads, not semantic search.
- **`--allow-build` is explicit on purpose.** It lets a package run build scripts on your machine, so it never happens by default. Automatic retry also needs to read pnpm's output; a sandbox that forbids creating pipes cannot, and says so.
- **Non-bundle packages** install but do not become profile layers — the same behaviour as DSH itself.

## Measured results

| Scenario | Result |
|---|---|
| Local path via `--spec` | Installed, joined `bundles`, verification reported "activated as a profile layer" |
| A GitHub plugin by name (outside the sandbox) | Installed, joined `bundles` |
| Pipes forbidden by the sandbox | Fell back to inheriting the terminal; pnpm output fully visible |
| Blocked git build script | Reconstructed the wrapped `allowBuilds` key (copying it verbatim yields a truncated key) |
| Unit tests | `node test/resolve.test.mjs` — 18 passing |

Tests and online verification are different claims: the first four rows are real end-to-end `dsh plugin` runs; the last row is only unit tests.

## Logo and assets

`assets/logo/` holds the Q-version (chibi) mark: `logo.png` (512px, canonical) plus `logo-512/256/128.png`.

- Generated through the OpenAI Codex subscription (this project's hard rule: Codex only for image generation; local models take no part).
- The character is the community fan interpretation "DeepSeek whale-chan", with identity anchors taken from the local `PERSONA.md`. **The character design and artwork belong to their original authors** (CC-BY-NC-SA 4.0): personal use is fine, **commercial use needs separate permission**.
- Head-to-body ratio measured with `headcount_proof.py`: skull-to-soles ≈ 1050 px over a ≈280 px head, i.e. **about 3.75 heads**. The bundled automatic detector reported 14.15 heads on this image, which is wrong; that reading is discarded and the number above comes from drawn calibration lines checked by eye.
- `ref-q3.png` is the proportion-authority reference composed by `build_proportion_ref.py` (left = design authority, right = a skeleton computed for the requested head count); `contract-icon.txt` is the highest-priority constraint used for generation.

### Transparent version

`logo-nobg.png` (1254px) plus `logo-nobg-512/256/128.png` are the transparent-background versions, produced by `remove_bg.py`, which cuts the cream canvas and keeps what is on it.

The important part: **colour keying does not work here.** The apron is `rgb(247,243,249)`, only 3 units away from the background `rgb(248,248,232)`, and the skin is nearly as close — a "distance from the background colour" threshold eats holes through the apron and the face. The background is the region *connected to the canvas edge*, so the cut is a flood fill, not a colour test. Alpha ramps only within a few pixels of the cut (histogram: 54.45% fully transparent, 2.59% partial, 42.97% opaque).

The two blurred plugin cartridges **remain in the transparent version**. That is a measured result, not an oversight — they cannot be separated from the figure automatically:

| Attempt | Measured result |
|---|---|
| Connected components | cartridges and figure share the largest component (their blurred edges meet) |
| Saturation test | cartridges S≈23, but the apron is S≈3 and the canvas S≈22 — no separation |
| Alpha test | the cartridges are painted low-contrast, not semi-transparent: alpha 255, same as the figure |
| Morphological erosion, 20/30px | still a single component after eroding — the waist join is wide, not a thin bridge |
| Row-by-row run splitting | only 385 of 770 rows on the left have a gap; on the right, 589 rows have **no** gap at all |

Cutting along rows anyway would slice off hair, so it was not done. A figure-only version needs a fresh generation without the cartridges in the composition.

### Watercolour version (low saturation)

`logo-watercolor*.png` is the low-saturation watercolour take, in three strengths:

| File | Colour kept | Note |
|---|---|---|
| `logo-watercolor.png` | 100% | the model's watercolour render as generated |
| `logo-watercolor-desat70.png` | 70% | **recommended**: clearly desaturated while the watercolour's warm/cool layering and blue identity survive |
| `logo-watercolor-desat50.png` | 50% | greyer and flatter; use with care |

Each strength ships as square 512/256/128 (scaled to fit and centred on the paper, never cropped or distorted).

- The regeneration contract forbade any background blocks, sparkles or particles — only the character and the one cartridge in her hands — so **this version's background is clean**, which sidesteps the "cartridges welded to the figure" problem the earlier version hit.
- Desaturation preserves luma: `out = gray + (c − gray) × k`, not a direct cut of HSV saturation (which drags brightness down and looks muddy).
- The bleeding, paper tooth and spatter are **painted**, not filterable: a desaturation filter only removes colour and cannot create watercolour texture, which is why this version was regenerated rather than processed.
- The square versions carry the paper background, so **they show as a cream square on dark backgrounds**. A transparent build needs a separate keying pass, and the watercolour bleeding means keying will cost some of the effect.

## License

MIT
