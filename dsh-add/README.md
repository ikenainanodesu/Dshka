# dsh-add

**English** | [简体中文](README.zh.md)

<img src="assets/logo/logo-readme-v5-400.png" alt="dsh-add: chibi DeepSeek whale-chan holding one plugin cartridge" width="300">

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

**The project logo is the `logo-readme-v5*.png` set** — low-saturation watercolour, white background keyed to transparent, edges faded. It is what the top of this README shows:

| File | Note |
|---|---|
| `logo-readme-v5.png` | master, 1024×1536 |
| `logo-readme-v5-800/400/200.png` | scaled; 400 is the width the README uses |
| `logo-readme-v5-square-512/128.png` | square builds on transparency, for avatars and package listings |

The edge fade exists so one file works on both GitHub themes: the flat white is keyed out, then alpha ramps down across the outer 9% so the artwork dissolves into the page.

**How the paper between the hair strands was removed** (this logo was reworked more here than anywhere else). Flooding paper in from the canvas border only reaches the outside, so paper **enclosed by the strands** stays in the image. Colour cannot separate it either: the leftovers are neutral white (`R−B` between −1 and +1) and the face is a warm white (+6..+13), but the **apron, socks and headdress lace are neutral white too** (0..+1) and collide with the leftovers exactly.

Three filters in series, and the order matters: (1) neutral white (`min ≥ 228` and `|R−B| ≤ 6`) — drops the warm face and the blue-tinted watercolour edges; (2) flood the *whole* neutral set from the canvas border — **this must happen before any region limit**, or the hair strands cut the outer background off from the border and the entire outside is misread as enclosed; (3) only then a region window (`y 430..760`, `x < 330` or `x > 700`, clear of the fin and collar lace) plus a size window (40..3000 px, which discards apron-sized whites). Result: 21 blobs, 9030 px cleared; strand gaps clean, apron, lace and face intact.

**The fade must not be built with a distance transform.** Light regions inside the figure read as paper, so a distance transform measures distance to those interior holes and drags the figure toward translucent — 26.2% partial, against 3.9% for a coordinate ramp.

### Other versions (kept as alternatives)

- **`logo-watercolor-desat70.png`** — the previous watercolour (with its paper background), composition includes the background cartridges.
- `dsh-add-watercolor-*.png` — raw watercolour render output.
- `dsh-add-wc-white-*.png` — the raw render this logo came from (flat white background).
- `logo-nobg*.png` — transparent builds of the earlier cel-shaded version; the two blurred cartridges are welded to the figure and cannot be separated.
- `logo.png` — the original cel-shaded master.

Scripts: `contract-watercolor-white.txt` (this version's contract), `contract-watercolor.txt` (previous), `fade_edges.py` (keying + edge fade), `clear_hair_paper.py` (clears the enclosed paper inside the hair), `clear_inner_paper.py` (the earlier failed attempt, kept as a record), `remove_bg.py`, `headcount_proof.py`, `finalize_logo.py`.

- Generated through the OpenAI Codex subscription (this project's hard rule: Codex only for image generation; local models take no part).
- The character is the community fan interpretation "DeepSeek whale-chan", with identity anchors taken from the local `PERSONA.md`. **The character design and artwork belong to their original authors** (CC-BY-NC-SA 4.0): personal use is fine, **commercial use needs separate permission**.
- Head-to-body ratio measured with `headcount_proof.py`: skull-to-soles ≈ 1050 px over a ≈280 px head, i.e. **about 3.75 heads**. The bundled automatic detector reported 14.15 heads on this image, which is wrong; that reading is discarded and the number above comes from drawn calibration lines checked by eye.
- `ref-q3.png` is the proportion-authority reference composed by `build_proportion_ref.py` (left = design authority, right = a skeleton computed for the requested head count).

## License

MIT
