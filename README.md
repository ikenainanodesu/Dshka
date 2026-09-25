<p align="center">
  <a href="assets/logo/logo.png"><img src="assets/logo/logo-waist.png" alt="DSHKA mascot: waist-up portrait of DeepSeek whale-chan" width="420"></a>
</p>
<h1 align="center">DSHKA</h1>
<p align="center"><strong>Let each task leave a lesson worth reusing.</strong></p>
<p align="center">The <code>dsh-experience-loop</code> plugin for <a href="https://deepseek-harness.github.io/deepseek-harness/develop/basic/">DeepSeek Harness</a>.</p>
<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a><br>
  <a href="#what-it-does">Features</a> · <a href="#install">Install</a> · <a href="dsh-experience-loop/README.md">Configuration</a> · <a href="#development">Development</a>
</p>

---

**Execute → validate → review → distil → reuse → revise.**

DSHKA does one thing: turn reviewed task experience into local, inspectable records and retrieve relevant lessons for later work. **DSHKA is the project name; `dsh-experience-loop` is the plugin/package name.** It is not a plugin manager and does not replace DSH's installation commands.

## What it does

| Capability | Purpose |
|---|---|
| **Remember** | Keep stable facts about a user, environment or project. |
| **Reuse skills** | Make reviewed procedures available through the host's native skill catalog. |
| **Avoid known failures** | Record failed approaches, causes and recovery guidance. |
| **Check real outcomes** | Preserve evidence that a task worked, beyond a successful process exit. |

Records are scoped globally or by project, with `candidate`, `verified` and `deprecated` lifecycle states. Reviews can merge, supersede or flag conflicting lessons. Raw turn evidence is journalled separately; it does not automatically become a lesson.

## Install

Requires a compatible **DeepSeek Harness** installation and **Node.js `^22.19.0 || >=24`**. No runtime package dependencies.

Use DSH's own plugin command:

```sh
dsh plugin --profile web add github:ikenainanodesu/Dshka
```

Replace `web` with your profile name. The repository root declares a DSH bundle, so there is no separate installer and no npm publication prerequisite.

### From a local checkout

```sh
git clone https://github.com/ikenainanodesu/Dshka.git
cd Dshka
dsh plugin --profile web add .
```

If you already use a manual `insert` row for this plugin, back up the profile patch and remove that old row when switching to the bundle install; do not load the same plugin twice. Existing absolute source paths remain valid because the implementation directory has not moved.

### Verify & uninstall

Restart the target DSH profile, then confirm that `experience_query` and `experience_review` are available and that this command responds:

```text
/experience stats
```

A successful package-manager exit alone is not proof that the plugin loaded. To uninstall:

```sh
dsh plugin --profile web remove dsh-experience-loop
```

Stored experience is retained. Back it up before any intentional deletion.

## Use the loop

- **`experience_query`** — search and inspect lessons, conflicts, pending reviews and diagnostics.
- **`experience_review`** — distil durable lessons near task completion; refine existing records rather than repeatedly adding duplicates.
- **`/experience`** — human controls for inspection, pinning, verification, deprecation, export and deletion.

```text
/experience search <topic>
/experience pending
/experience conflicts
/experience help
```

### Bounded by design

Default retrieval limits: **4 records**, **1,800 characters**, a **1-turn cooldown** and **60 injections per session**. Subagent retrieval is off by default. Learned skills use the host's catalog; candidate descriptions are marked **`[candidate - unproven]`** and bodies load on demand.

[Configuration, lifecycle and diagnostics →](dsh-experience-loop/README.md)

## Boundaries

- This is **retrieval and record maintenance, not model training**. Reduced repeated work is a goal, not a proven result.
- Local storage is not an encrypted vault. Retrieved records enter the host's model context; secret redaction is best effort, not a guarantee.
- `verified` is a lifecycle label, not independent proof of correctness. Automatic outcome scoring is heuristic and can misattribute failures.
- Lessons remain advisory: they cannot override a current user request, sandbox or approval boundary.

## Development

```sh
# From the repository root
npm test
npm run smoke
```

The smoke demo uses a fake host, not a running DSH profile. No model or network calls are needed for these tests.

```text
Dshka/
├── package.json              # Installable dsh-experience-loop bundle
├── README.md / README.zh-CN.md
├── assets/logo/              # Existing mascot artwork, unchanged
├── dsh-experience-loop/      # Plugin implementation; stable legacy paths
│   ├── index.mjs             # Plugin entry
│   ├── cordis.patch.yml      # Bundle layer
│   ├── lib/                  # Retrieval, review and storage
│   ├── test/                 # Tests
│   └── tools/                # Diagnostics and smoke demo
└── docs/                     # Operational guidance
```

The nested package manifest is retained for existing local-directory installs; both entry points load **the same plugin**, not two products. New installs should use the repository root.

[Restart recovery guide (中文)](docs/DSH-restart-recovery.zh.md) · [Detailed plugin guide](dsh-experience-loop/README.md)

## License & artwork

Code: [MIT](LICENSE). The header portrait is cropped directly from the full-resolution master, without repainting or alpha changes. Click it to view the original; all existing variants are retained. Artwork has separate permissions and incomplete source attribution; the code license does not grant rights to it. See the [asset notes](assets/logo/README.md).
