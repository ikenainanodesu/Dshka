# dsh-add

**English** | [简体中文](README.zh.md)

<img src="assets/logo/logo-400.png" alt="dsh-add: chibi DeepSeek whale-chan holding one plugin cartridge" width="300">

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

**The project logo is `logo.png`** — low-saturation watercolour, white background keyed to transparent, edges faded. It is what the top of this README shows:

| File | Note |
|---|---|
| `logo.png` | master, 1024×1536, transparent |
| `logo-800/400/200.png` | scaled; 400 is the width the README uses |
| `logo-square-512/128.png` | square builds on transparency, for avatars and package listings |

Keying and fading exist so one file works on both GitHub themes: the flat white is keyed out, and the cut gets sub-pixel smoothing only — no global feather, so opacity inside the hair and shoes is never dragged down.

**This version rebuilds alpha from the original render; it does not tune the old mask further.** Two systematic errors in the earlier pipeline are fixed:

1. **White clothing was deleted as background.** The top of the headdress and the left side of the skirt were removed during basic keying, because white clothing and paper are the same neutral white (min channel 253-254, `|R−B| ≤ 1`) and colour cannot separate them. The diagnostic is to compare geometry against the original render: take the difference between "non-near-white figure pixels in the original" and "opaque pixels in the build". That measured about 14857 px of figure content lost, mostly the ahoge tip (3285 px) and the shoes (about 9150 px) — and it also shows why **checking only enclosed holes misses deletions that touch the outer background**.
2. **Do not decide by position and area.** The earlier attempt cleared candidates inside a positional window by size, and took the white lace at the waist with them. The fix is **manual clothing protection polygons plus individually reviewed background components**: `repair_alpha.py` carries six protection polygons (headdress, body and skirt, both legs) and 27 background component IDs checked one by one on zoomed crops; two candidates that were really waist ribbons are explicitly excluded.

Verification: the protected region (424461 px) has alpha minimum **255**; all 27 annotated gap centres have alpha **0**; and RGB is byte-identical to the original render (max difference **0**), proving only alpha changed.

**The fade must not be built with a distance transform.** Light regions inside the figure read as paper, so a distance transform measures distance to those interior holes and drags the figure toward translucent — 26.2% partial, against 4.0% for a coordinate ramp.

### Sources and scripts

- **Renders kept for provenance**: `source-watercolor-white.png` (this logo's source, flat white), `source-watercolor-paper.png` (textured paper version), `source-cel-shaded.png` and `source-icon-cel-shaded.png` (the original cel-shaded pair).
- `contract-watercolor-white.txt` / `contract-icon.txt`: the generation contracts each render came from.
- `repair_alpha.py`: **the script this logo was built with** — rebuilds alpha from the original render, with the protection polygons and the reviewed component list.
- `ref-q3.png`: the Q-version proportion-authority reference composed by `build_proportion_ref.py`.
- `headcount_proof.py`: head-count calibration. `finalize_logo.py`: scaling and size output.

- Generated through the OpenAI Codex subscription (this project's hard rule: Codex only for image generation; local models take no part).
- The character is the community fan interpretation "DeepSeek whale-chan", with identity anchors taken from the local `PERSONA.md`. **The character design and artwork belong to their original authors** (CC-BY-NC-SA 4.0): personal use is fine, **commercial use needs separate permission**.
- Head-to-body ratio measured with `headcount_proof.py`: skull-to-soles ≈ 1050 px over a ≈280 px head, i.e. **about 3.75 heads**. The bundled automatic detector reported 14.15 heads on this image, which is wrong; that reading is discarded and the number above comes from drawn calibration lines checked by eye.

## License

MIT
