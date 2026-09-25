# dsh-experience-loop

**English** · [简体中文](README.zh-CN.md) · [DSHKA home](../README.md)

A bounded, auditable experience loop for [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/develop/basic/):
**execute → validate → review → distil → reuse → revise**.

The plugin stores reusable lessons locally, retrieves relevant summaries before a
step, and exposes learned skills through the harness skill catalog. Its goal is
less repeated investigation, not more stored text. Improvement must be evaluated;
the plugin does not guarantee better results.

```text
user task
   ├─ agent/pre-step → bounded retrieval, environment gates and keyword ranking
   ├─ session/event  → redacted per-turn evidence journal (not a lesson)
   └─ experience_review → create / merge / conflict / supersede / outcome
                             └─ Memory · Skill · Failure · Validation
                                  └─ eligible skills enter the harness catalog
```

## Design

| Decision | Reason |
|---|---|
| No `@deepseek-ai/*` runtime imports | Node builtins avoid host-package resolution problems with local symlink or file-path installs. Host API compatibility still depends on the installed harness version. |
| No exported `Config` schema | `lib/config.mjs` validates and clamps settings and warns about unknown keys without importing a schema package. |
| Plain JSON + Markdown storage | Records are inspectable and backup-friendly. Malformed scope files log a warning and load as an empty view; preserve the original before any write or recovery attempt. |
| Native `ctx.skills` provider | The host handles skill discovery, loading and catalog invalidation. |
| Bounded candidate visibility | Default `exposeSkills: all` makes candidates discoverable, with an explicit unproven marker and shorter descriptions; the catalog is capped. |
| Model-driven distillation | Raw events are evidence only. They do not automatically become lessons. |

## Install

DSHKA is this plugin's project name, not a separate installer. Use the official command:

```sh
dsh plugin --profile web add github:ikenainanodesu/Dshka
```

For a local checkout, run `dsh plugin --profile web add .` from the repository root.
The root package exports this directory's implementation and declares its bundle patch.
The nested package remains only for compatibility with existing local-directory installs.
Restart the target profile after installation and verify the tools as described below.

### Manual source loading (development only)

Do not combine a manual source row with a bundle install of this plugin. Back up and
remove an existing manual row when switching to the official bundle install.

`DSH_HOME` defaults to `$HOME/.dsh` when unset. Back up your profile patch before editing it. Append an `insert` entry to
`<DSH_HOME>/profiles/<profile>/cordis.patch.yml`, replacing the placeholder with
your checkout path:

```yaml
- insert:
    - id: experience-loop
      name: '<checkout>/dsh-experience-loop/index.mjs'
```

The harness patch loader anchors absolute paths and patch-relative `./` or `../`
paths in `insert[].name` as file URLs. No package publication is needed.
For a profile with `patchReload: live`, configuration changes can be picked up
without a restart. Check reload logs and the effective row; a failed reload may
leave the previous configuration active.

### Legacy local-directory install

The existing subdirectory still declares `dsh.bundle` for compatibility. It loads the
same plugin as the root package; new installations should use the root instead:

```sh
dsh plugin --profile web add <checkout>/dsh-experience-loop
```

### Verify loading and code activation

From the plugin directory, inspect locally:

```sh
node tools/validate-profile-row.mjs --profile web
node tools/read-session-log.mjs <session.jsonl.zstd> "Experience Loop"
```

Useful traces include `## Experience Loop` in a `system/message` event and
`experience_review` / `experience_query` in a `request/header` tool list.
The store directory appears after a write. These are supporting evidence, not
proof that the current process has loaded the newest code: unchanged prompt and
tool metadata can remain in older log events.

Call `experience_query` with `action: "stats"` in the current session to verify
the tool is callable. To verify a code change, use a safe probe that distinguishes
the changed behavior from the previous behavior. Do not create or supersede real
records just to test loading. A silent start, directory existence or exit code 0
alone does not establish success.

Configuration reload and module reload are separate mechanisms. Saving `.mjs`
files or enabling a watcher does not prove that an already-loaded module changed.
A controlled harness restart followed by a distinguishing probe is the reliable
baseline; module hot reload depends on host version and setup.

### Uninstall

Remove the local `insert` entry, or remove the packaged bundle:

```sh
dsh plugin --profile web remove dsh-experience-loop
```

Stored data is retained. Back it up and confirm the resolved `storeRoot` before
any intentional deletion.

## Configuration

The following patches an existing entry; for a new entry place `config` under
its `insert` row. All fields are optional.

```yaml
- id: experience-loop
  config:
    enabled: true              # false: register no tools, hooks or prompt section
    storeRoot: null            # default: <DSH_HOME>/experience-loop
    inject:
      enabled: true
      topK: 4                  # max records per injection (1..12)
      budgetChars: 1800        # bound for the injected block
      minScore: 0.32
      cooldownTurns: 1
      maxPerSession: 60
      subagents: false
    learn: true
    captureEpisodes: true
    episodeRetention: 400
    episodeAskChars: 400
    askContextChars: 1200
    exposeSkills: all          # all | verified | none
    maxExposedSkills: 40
    skillDescriptionChars: 300       # verified description
    candidateDescriptionChars: 160   # candidate description, marker included
    defaultScope: project
    recencyHalfLifeDays: 45
    weights: { relevance: 1.0, confidence: 0.6, environment: 0.5, recency: 0.25, reliability: 0.4 }
    promoteConfidence: 0.7
    promoteSuccesses: 2
    deprecateConfidence: 0.15
    autoDeprecate: true
    observeOutcomes: true
```

### Candidate visibility

By default, non-deprecated skills are eligible for the catalog. Verified skills
sort first, then confidence; `maxExposedSkills` defaults to **40** and can omit
skills of either status when the cap is reached. Candidate descriptions have a
**160-character** default budget including `[candidate - unproven]`; verified
descriptions default to **300 characters**. These are description limits, not a
guarantee about the total rendered host catalog size.

The model's `skill` tool resolves names through the catalog, so a hidden candidate
cannot be loaded through that route. `exposeSkills: verified` and `none` are
available for stricter discovery policies. The provider's direct `get` path can
serve explicitly named non-deprecated candidates under `verified`; `none` disables
that path as well. Deprecated skills are not offered.

### Short replies

Retrieval first tries the user's own words. Only if that finds nothing does it
retry with a referent: the canonical option selected from a posed question, or
the previous assistant message as a weaker fallback. There is no short-message
length threshold.

`user-questions/request` is observed and delegated with `next()`. The plugin does
not claim or answer the question. Matching tries positions (numbers, letters and
ordinals), exact labels, then unique fragments; ambiguous matches are refused.
The journal retains `ask` and, when available, resolved `askContext` after
redaction. Resolution itself requires no extra model call; any resulting
injection still consumes context within the configured budget.

## Record types and lifecycle

| Type | Purpose | Typical body fields |
|---|---|---|
| `memory` | Stable facts about a user, environment or project | `fact`, `details` |
| `skill` | Reusable procedure | `purpose`, `trigger`, `steps`, `validation`, `pitfalls`, `rollback` |
| `failure` | Failed approach and how to avoid it | `attempted`, `symptom`, `cause`, `avoidance` |
| `validation` | Evidence that an outcome actually works | `target`, `signals`, `negativeCase` |

Records carry a generated ID (for example, the synthetic `exp_example`), status,
scope, applicability, confidence, counters, provenance and timestamps. Project
keys derive from absolute paths and are **not anonymization**. Platform and shell
mismatches are hard retrieval gates; project/runtime mismatches reduce score.

New records start as candidates. Outcome updates can promote them using the
configured success/confidence thresholds; `/experience verify` is a human
override. Failures can lower confidence and trigger deprecation. Superseding a
record explicitly withdraws the old one. `verified` describes lifecycle state,
not independently proven correctness.

- Near-identical records merge at similarity ≥ 0.72, preserving the ID and
  incrementing the version.
- Partial overlap (0.4 ≤ similarity < 0.72) is surfaced as a conflict, not silently
  resolved.
- List merges preserve existing steps. An explicit `mergeInto` with
  `replaceLists: true` allows authoritative replacement of supplied list fields.

## Observed outcomes: a heuristic, not an efficacy test

With `observeOutcomes: true`, session events provide a second outcome source in
addition to model-reported `outcomes`:

| Signal | Treatment |
|---|---|
| Learned skill loaded; turn ends `completed` | Observed success; may promote |
| Learned skill loaded; turn ends `error` | Observed failure; may deprecate |
| Turn ends `aborted`, `interrupted`, `blocked` or `max-tokens` | No outcome score |
| Record only appears in a retrieval block | Surfacing counter only |
| Skill load fails | Load-failure reporting, not credited use |

Loading is not proof of following a procedure. A completed turn may contain a
wrong answer, and an error may be unrelated to the skill. These signals are
**heuristic attribution**, not evidence that the skill caused success or failure.
Inspect the task result and provenance; disable automatic observation if that
tradeoff is unsuitable. Observed labels such as `observed:skill-used` and
`observed:skill-failed` distinguish this path from explicit model reports.

## Storage and privacy

The default root is `<DSH_HOME>/experience-loop`.

| Path | Contents |
|---|---|
| `global/experiences.json` | Cross-project records |
| `projects/<key>/experiences.json` | Project-scoped records |
| `episodes.jsonl` | Per-turn evidence journal; never injected verbatim |
| `audit.jsonl` | Change and outcome audit trail |
| `state.json` | Aggregate counters |
| `digest.md` | Generated summary |
| `HOW-TO-EDIT.md` | Editing/removal instructions |

Snapshot files use temporary-file replacement; journals append entries. Back up
before manual maintenance, and stop the owning process before editing cached
records so a later flush cannot overwrite your edits.

The redactor in `lib/redact.mjs` is **best effort**, not a universal safety
boundary. It recognizes selected credential formats, private-key blocks,
authorization headers, cookies, connection credentials and contextual one-time
codes. Useful text can survive after recognized spans are replaced; a
credential-only review can be rejected. Unrecognized secrets, private project
names, paths and identifying text can remain.

Do not store credentials intentionally. Inspect exports, digests, journals,
profile output and logs manually before sharing, even in a private repository.
`/experience redact <text>` previews matching behavior; it does not certify safety.
Records are advisory evidence and cannot grant permissions or override current
instructions or sandbox policy.

## Human control and diagnostics

`/experience` commands are handled locally, not sent as model requests:

```text
list [type] [limit]     search <text>       show <id>       stats
metric                  conflicts           pending         deprecated
projects                audit [n]           digest          redact <text>
pin <id> | unpin <id>   verify <id>         candidate <id>
deprecate <id> [reason] delete <id>
export [path]           import <path>       forget-project [key]
on | off                help
```

The model's `experience_query` exposes the read surface:
`search|list|show|stats|conflicts|pending|deprecated|projects|metric|audit`.

`metric` compares first and later tool-call counts for request groups identified
by vocabulary similarity within a workspace. Short or truncated requests may be
excluded. It needs comparable repetitions and reports when there are none.
Lower tool-call counts alone do not establish improved quality, causal benefit,
or equal task difficulty; inspect outcomes and confounders rather than treating
this metric as proof of improvement.

## Development

Run from `dsh-experience-loop/`:

```sh
node tools/run-tests.mjs       # suite in one process
node --test test/              # alternative; requires child-process support
node tools/smoke.mjs           # offline demo using temporary data
node tools/check-retrieval.mjs --store <root> --cwd <dir> --ask '<text>'
node tools/check-retrieval.mjs --store <root> --from-session <session.jsonl.zstd>
node tools/read-session-log.mjs <log.jsonl.zstd> [needle]
node tools/validate-profile-row.mjs [--profile web] [--id experience-loop] [--file <candidate-patch>]
node tools/profile-row.mjs show|disable|enable|remove [--file <patch>] [--id experience-loop]
node tools/status.mjs [--limit <n>] [--session <id>]
```

- The single-process runner avoids child-process pipe restrictions in confined
  environments. Read the reported test summary rather than assuming a fixed count.
- Retrieval diagnostics run the real pipeline without a harness or model.
- Session-log readers handle concatenated zstd frames. Keyword hits in user or
  tool text do not establish prompt or tool registration.
- Profile validation uses installed harness parsers without booting a server;
  their availability and API compatibility depend on the local install.
  `dsh --dump-config` may write profile files and is not a read-only substitute.
- Status output combines store counters and historical logs. Its activation
  comparison can be inconclusive and does not replace a current-session probe.
- Diagnostic output can contain private data. Keep it local and sanitize excerpts.

For restart failures, see the [Chinese recovery runbook](../docs/DSH-restart-recovery.zh.md).

Tests cover the real plugin entry point with a fake host, ranking and repeat
metrics, review/merge/conflict lifecycle, storage round trips and provenance,
recognized redaction patterns, structured short replies, observed outcomes and
host-compatible tool schema shapes. Passing these tests is not a live-host
compatibility or universal secret-detection guarantee.

## Host integration and limitations

Hooks: `agent/session-start`, prepended `agent/pre-step`,
`user-questions/request`, `session/event`, `session/flush`, and unload cleanup via
`ctx.effect`. The plugin registers two tools, one command, a system-prompt section,
a skill provider and the `experienceLoop` service.

- Distillation needs `experience_review`; there is no background LLM consolidator.
- Keyword retrieval can miss relevant lessons with different wording.
- Deduplication can miss paraphrases; conflicts still need explicit resolution.
- Catalog and injection budgets limit visibility and context cost.
- Subagent retrieval is off by default.
- Local storage has no built-in cross-machine sync; review exports before moving them.
- Host APIs, profile layout and module reload behavior are version-dependent.
