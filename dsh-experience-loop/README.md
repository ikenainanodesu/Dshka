# dsh-experience-loop

A bounded, auditable continual-learning loop for [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/develop/basic/):
**execute → validate → review → distil → reuse → revise**.

The goal is not to store more text. The goal is that the *second* time the same
kind of problem appears, the agent needs fewer searches, fewer inferences and
fewer failed attempts — and that you can see, edit and delete everything it
learned.

```
user task
   │
   ├─ agent/pre-step ─────────────► retrieve top-K relevant experience (hard budget)
   │                                 · environment gate: platform / shell / project
   │                                 · keyword coverage + confidence + recency + reliability
   │
   ├─ tools execute ──────────────► session/event ─► one redacted episode line per turn
   │                                                    (EVIDENCE, never an Experience)
   │
   └─ experience_review (once) ───► dedupe / conflict / merge / supersede / deprecate
                                     └─► Memory · Skill · Failure · Validation
                                           └─► verified Skills become harness skills
```

---

## Why it is built the way it is

| Decision | Reason |
|---|---|
| **Zero `@deepseek-ai/*` imports** | A locally developed plugin is installed as a symlink, and Node resolves a symlinked ESM module to its *real* path — so the host packages hoisted under the profile's `node_modules` become unreachable. Staying on Node builtins means the plugin works under every install shape (symlink, copy, `file://` row, npm). The two host helpers that would be convenient are trivially replaceable, and both replacement contracts were verified against the real host: `createUserMessage` only mints `{id: <uuid>, role: 'user', …}`; `defineTool` only compiles an author schema into raw JSON Schema, which is exactly what `ToolSchema.parameters` takes. |
| **No exported `Config` schema** | A schema would require `@deepseek-ai/schemastery`. `lib/config.mjs` validates and clamps every field itself and reports unknown keys as warnings, so a typo in a patch row is visible in the log instead of silently ignored. |
| **Plain JSON + Markdown store, not `ctx.storageDomain`** | A schema-validated domain refuses to open on *one* malformed record, and hand-editing a record is an explicit requirement. Plain files are transparent, migratable and backup-friendly, and a bad file degrades to an empty view of that scope instead of locking the store out. The plugin adds no dependency at all. |
| **Skills reuse `ctx.skills`** | Rather than growing a private skill loader, learned skills are exposed through a runtime `SkillProvider`, so discovery, cataloguing, invalidation and the `skill` tool all stay the host's business. |
| **Only *verified* skills are advertised** | The harness skill catalog costs `skills × description length` on **every** request. A brand-new candidate must not sit in every prompt before anything has validated it. |
| **Review is model-driven, capture is deterministic** | Raw tool calls must never become Experience by themselves — that is how an experience base fills with noise. Turn evidence is written to a journal; only a distilled `experience_review` payload becomes a record. |

---

## Install

### Local development (what this checkout uses)

1. Append one row to the profile patch — `%DSH_HOME%\profiles\<profile>\cordis.patch.yml`:

   ```yaml
   - insert:
       - id: experience-loop
         name: '<path-to-this-checkout>\dsh-experience-loop\index.mjs'
   ```

   dsh's patch loader rewrites an absolute path (or a patch-relative `./`/`../`
   path) in `insert[].name` into a `file://` URL at parse time
   (`dsh-app-boot` → `anchorInsertedPluginNames`), so no `pnpm install`, no
   registry and no publish are involved.

2. If the profile sets `patchReload: live` (the `web` profile does), the row is
   picked up **without restarting dsh**. Boot errors are contained: a failed
   reload logs and keeps the last good tree running.

### Packaged install

The package declares `dsh.bundle`, so it is also a normal bundle layer:

```sh
dsh plugin --profile web add D:\path\to\dsh-experience-loop
```

### Verify it really loaded

```sh
node tools/read-session-log.mjs "%DSH_HOME%\sessions\--<cwd>--\<session-id>\session.v3.jsonl.zstd" "experience"
```

A loaded plugin leaves durable traces. Check all three:

1. the latest `system/message` event contains `## Experience Loop`;
2. the latest `request/header` event's `tools` array contains
   `experience_review` and `experience_query`;
3. `<storeRoot>` appears on disk after the first write.

It has **not** loaded if you only see "no error". `exit code 0`, a silent start,
or a clean `--dump-config` prove nothing.

### Uninstall

Remove the `insert` row (or `dsh plugin --profile web remove dsh-experience-loop`).
Your data in `<storeRoot>` is untouched. To erase everything the plugin knows,
delete `<storeRoot>`.

> **Two reload mechanisms — only one of them works without a restart (measured).**
> A `config:` edit on the row **does** reach the running plugin: the entry is
> re-created and `apply()` re-runs with the new config object, in *both*
> directions — a live config value was observed following the row `25 → 7 → 25`
> inside a single process, with no restart and no code reload. A comment-only
> patch edit is a no-op for the same reason; a real value must change.
>
> An edit to the plugin's own `.mjs` does **not** take effect. The base `hmr` row
> ships `disabled: true` and the launcher mounts hmr with `root: []`, so no module
> file is watched. **Measured negative:** setting `hmr` to `disabled: false` with
> `root: ['<path-to-this-checkout>/dsh-experience-loop']` and then rewriting *every*
> module in place (including `index.mjs`) produced **no reload** — a probe that
> only the newer code can satisfy still failed, so the original module was still
> loaded. Do not assume that enabling module reload, or saving a file, activates a
> change.
>
> **A `dsh` restart is the reliable way to activate a code change.** If you want
> live iteration, mount the plugin as a bundle layer and enable module reload
> *before* its first load, rather than retrofitting it onto a running instance.

---

## Configuration

On the `experience-loop` row of your profile patch. Every field is optional.

```yaml
- id: experience-loop
  config:
    enabled: true              # false = mount nothing at all (no tools, hooks, prompt section)
    storeRoot: null            # default: %DSH_HOME%/experience-loop
    inject:
      enabled: true            # retrieval before a step
      topK: 4                  # max records per injection (1..12)
      budgetChars: 1800        # HARD character bound for the whole injected block
      minScore: 0.32           # 0..1
      cooldownTurns: 1         # suppress re-injection for N consecutive turns
      maxPerSession: 60        # hard cap on injections per session
      subagents: false         # skip retrieval for subagent sessions (default: skip)
    learn: true                # allow experience_review to write
    captureEpisodes: true      # write the per-turn evidence journal
    episodeRetention: 400
    episodeAskChars: 400
    askContextChars: 1200      # how much of the previous assistant turn may serve as referent
    exposeSkills: verified     # verified | all | none
    maxExposedSkills: 25
    skillDescriptionChars: 300
    defaultScope: project      # scope when a review entry omits one
    recencyHalfLifeDays: 45
    weights: { relevance: 1.0, confidence: 0.6, environment: 0.5, recency: 0.25, reliability: 0.4 }
    promoteConfidence: 0.7     # candidate -> verified
    promoteSuccesses: 2
    deprecateConfidence: 0.15
    autoDeprecate: true
```

---

## Short replies: no threshold, an explicit referent instead

A user answering a multiple-choice question may reply with a single character
(`C`), and a short confirmation (`好`, `用 B`) is just as real. Such a reply is a
**complete request whose meaning lives in what it answers**, so the plugin never
treats it as noise — and it does **not** decide by shape. A character or token
count is an arbitrary constant that both misses real replies and discards real
short requests. Retrieval is **two-pass**, and the decision is made by outcome:

```
pass 1  the request in the user's own words
        └─ found something → done. Nothing else is even computed, so a long
           prompt is never diluted by context.
pass 2  only if pass 1 found nothing, retry with the REFERENT attached:
        · the canonical OPTION the reply selected, when the agent posed a
          choice — the candidate set is known, so this is a lookup
        · the preceding assistant turn, as the weaker fallback
```

The referent comes from the harness itself. `ctx.userQuestions` dispatches the
**`user-questions/request`** waterfall carrying `questions[].options[].label`,
and `ask_user_question` returns the answer with `selected: string[]` (canonical
labels) or `custom` (free text). The plugin subscribes, **observes, and delegates
with `next()`** — it never claims, answers, or delays a question. Matching then
follows a deterministic ladder, in `lib/slate.mjs`:

```
bare number · letter (A/B/C) · ordinal (1st, first, 第三, 3번, 세번째)
  → exact label, ignoring enumerations and decorations like (recommended)
    → unique distinctive fragment
      0 matches → nothing (fall back to the conversation)
      ≥2 matches → FAIL CLOSED, never a guess
```

The pattern is the one NousResearch/hermes-agent uses for its native `clarify`
prompts ([issue #96954](https://github.com/NousResearch/hermes-agent/issues/96954)):
deterministic, no model call, ambiguous input refused rather than guessed, and
the **canonical option text** returned rather than the user's abbreviation.
The letter tier is an addition that fits this harness, where the Web UI labels
choices `A / B / C`.

Cost: **zero extra model tokens** — nothing new is sent, and the option set is
already in the transcript as the `ask_user_question` call's arguments. The only
effect is that a turn which today is skipped may now inject, bounded by the same
`injectTopK` / `injectBudgetChars` / `injectMaxPerSession` caps.

The journal keeps the user's exact words in `ask` **and** the resolved form in
`askContext`, so a one-letter answer stays identifiable as a task later — even
after compaction has hidden the question itself.

Skipping short requests outright — the first implementation — disabled retrieval
for exactly the turns where a stored lesson would matter most.

---

## The four kinds of Experience

| Type | Answers | Key body fields |
|---|---|---|
| `memory` | *What do I already know about this user, machine or project?* | `fact`, `details` |
| `skill` | *How should this class of problem be handled?* | `purpose`, `trigger`, `preconditions`, `environment`, `steps`, `validation`, `failureHandling`, `pitfalls`, `rollback`, `examples` |
| `failure` | *What did I try that failed, and why?* | `attempted`, `symptom`, `cause`, `avoidance` |
| `validation` | *How do I prove the task is actually done?* | `target`, `signals`, `negativeCase` |

`exit code 0` is **not** task success, and the `validation` type is where that
rule becomes concrete: process → service → API → business function.

### Record shape

```jsonc
{
  "id": "exp_example_record",
  "type": "skill",
  "status": "candidate",              // candidate | verified | deprecated
  "scope": { "level": "project", "project": "C-work-example-project", "projectPath": "C:\\work\\example-project" },
  "title": "Docker service recovery",
  "summary": "Recover a Docker service that will not stay up, then prove it is healthy.",
  "body": { "steps": ["…"], "validation": ["…"] },
  "applies": { "platform": "win32", "shell": "pwsh", "runtime": "docker-desktop", "tags": ["docker"] },
  "confidence": 0.56, "successCount": 2, "failureCount": 0, "useCount": 2,
  "pinned": false, "version": 2,
  "supersedes": null, "supersededBy": null, "conflictsWith": [],
  "evidence": [{ "kind": "review", "sessionId": "…", "at": "…", "note": "…" }],
  "source": "agent", "redactions": ["openai-style-key"],
  "skillName": "exp-docker-service-recovery",
  "createdAt": "…", "updatedAt": "…", "lastUsedAt": "…"
}
```

**Every record knows when it applies.** `applies.platform` and `applies.shell`
are *hard gates* — a Windows-only procedure is never offered on Linux — while a
project or runtime mismatch is a score penalty, not a gate.

---

## Storage layout

`storeRoot` defaults to `%DSH_HOME%\experience-loop`.

| Path | Contents |
|---|---|
| `global/experiences.json` | Experience valid across projects |
| `projects/<key>/experiences.json` | Experience for one project root (key = sanitized absolute path) |
| `episodes.jsonl` | Append-only evidence journal, one line per finished turn — never injected verbatim |
| `audit.jsonl` | Append-only trail of every create / merge / conflict / supersede / outcome / pin / status / deprecate / delete |
| `state.json` | Counters used by `stats` and `metric` |
| `digest.md` | Generated human-readable summary |
| `HOW-TO-EDIT.md` | Generated editing/removal instructions |

All writes are atomic (temp file + rename). A malformed document degrades to an
empty view of that scope and logs a warning; it never throws into the harness.

---

## Observability and human control

`/experience <subcommand>` (a human command — it never reaches the model):

```
list [type] [limit]     search <text>       show <id>       stats
metric                  conflicts           pending         deprecated
projects                audit [n]           digest          redact <text>
pin <id> | unpin <id>   verify <id>         candidate <id>
deprecate <id> [reason] delete <id>
export [path]           import <path>       forget-project [key]
on | off                help
```

The `experience_query` tool exposes the same read surface to the model
(`search|list|show|stats|conflicts|pending|deprecated|projects|metric|audit`).

`/experience stats` reports totals, per-type and per-status counts, counters,
outstanding conflicts and the number of unreviewed turns. `/experience redact
<text>` shows exactly what the secret filter would store — useful for verifying
the safety guarantee by inspection rather than by trust.

---

## Safety

- **Every** byte that could become a long-lived record passes through
  `lib/redact.mjs`: the review payload, the episode journal, and imports.
- Recognised: private-key blocks, AWS / GitHub / Slack / OpenAI-style / Anthropic
  keys, JWTs, `Authorization` headers, cookies, credential assignments
  (`password=…`, `api_key: …`), `*_TOKEN=…` environment exports, connection
  strings with inline credentials, and one-time codes in their own context.
- **Redact, then judge**: a credential inside an otherwise useful lesson is
  replaced with `«redacted:<rule>»` and the lesson survives; a payload that is
  *nothing but* credentials is rejected outright.
- Records carry no authority. Experience is advisory context, never an
  instruction, and the current user request always wins. Nothing here can grant
  a permission, pre-approve a tool call, or bypass the sandbox or approval
  policy.

---

## Lifecycle

```
create → candidate ──(2 successes, or confidence ≥ 0.7, or /experience verify)──► verified
              │                                                                     │
              │◄───────────────────── success on a deprecated record ───────────────┤
              ▼                                                                     ▼
          deprecated ◄──(explicit supersede / /experience deprecate / auto: ≥2 failures at conf ≤ 0.15)
```

- A near-identical restatement (similarity ≥ 0.72) **merges into the existing
  record** — same id, `version + 1`. It never creates a v2 copy.
- A partially overlapping neighbour (0.4 ≤ similarity < 0.72) is recorded as a
  **conflict**: both records survive, both are linked, the new one is held at
  `candidate`, and the audit entry stores old / new / reason / environment
  difference / decision. Nothing is silently overwritten.
- List fields merge without losing steps: a longer list is a superset, so its
  **order is adopted** (that is how "check DNS first" moves a step to the front);
  a shorter list only appends unless the review sets `replaceLists: true`.

---

## Measuring whether it works

`/experience metric` — or `experience_query {action:"metric"}` — compares the
**first** run of a task signature with the runs that followed it, using the real
per-turn tool-call counts recorded in `episodes.jsonl`:

```
Repeated task groups: 3
First run average tool calls: 14.33
Later runs average tool calls: 6
Reduction: 58.1%
```

Other observable counters in `/experience stats`: injections and injected
characters, reviews, records created/merged/rejected, success and failure
outcome reports, conflicts seen, sensitive spans redacted.

> This metric becomes meaningful only after the same kind of task has actually
> been performed more than once in the same environment. Until then it says so.

---

## Development

```sh
node tools/run-tests.mjs       # 44 tests, all in ONE process
node --test test/              # same suite, one child per file (needs process spawn)
node tools/smoke.mjs           # offline end-to-end demo; prints every artefact
node tools/check-retrieval.mjs --store <root> --cwd <dir> --ask '<text>'
node tools/check-retrieval.mjs --store <root> --from-session <session.jsonl.zstd>
node tools/read-session-log.mjs <log.jsonl.zstd> [needle]
node tools/validate-profile-row.mjs [--profile web] [--id experience-loop] [--file <candidate patch>]
node tools/profile-row.mjs show|disable|enable|remove [--id experience-loop]
node tools/status.mjs [--limit n] [--session <id>]
```

**If a `dsh` restart fails, read [`../docs/DSH-restart-recovery.zh.md`](../docs/DSH-restart-recovery.zh.md)** —
a recovery runbook (rollback ladder, log capture, an evidence-report template, and the
failure-mode table) written so another agent can take over.

- `tools/run-tests.mjs` exists because `node --test test/` spawns a child per file
  with piped stdio, which a confined sandbox denies (`spawn EPERM`).
- `tools/check-retrieval.mjs` answers "why didn't it inject anything?" by running
  the real pipeline against a real store and printing every record's overlap,
  relevance and score, which floor dropped it, and the exact block that would be
  injected. It needs no harness and no model.
- `tools/read-session-log.mjs` decodes the zstd-framed session log. It locates
  each frame by its magic number, because a single decompression pass over the
  file silently returns only the session header.
- `tools/validate-profile-row.mjs` validates a patch row with the **harness's own**
  parser (`loadProfileDirectory` + `composeEntries`) without booting anything. It
  is the sandbox-safe equivalent of `dsh --dump-config`, which fails with EPERM
  because it rewrites `cordis.yml` inside the profile directory. It reports the
  effective row, whether an absolute `insert[].name` was anchored to a `file://`
  URL, and whether that target exists.
- `--from-session` replays a **real** recorded turn through `planInjection`, which
  is how the ask-extraction rules get tested against genuine message sources
  (`user` vs a subagent's relayed `agent-message`) without booting dsh.
- `tools/status.mjs` answers "is the plugin loaded and working in the RUNNING dsh?"
  in one command: store counters, per-session prompt-section / tool presence, every
  injected block, and an **activation check** that recomputes both the old and the
  new relevance formula for the most recent injection. If no record could only have
  been selected by the fixed code it reports *inconclusive*, rather than pretending.

### Test coverage

| File | Covers |
|---|---|
| `test/loop.test.mjs` | Scenarios **A–F** through the real plugin entry point: first solve → distil; second time → bounded, idempotent retrieval; stale skill → refine in place; wrong environment → never offered; secrets → never stored; wrong experience → list / show / pin / verify / deprecate / export / import / delete |
| `test/review.test.mjs` | create, dedupe-merge, conflict, supersede, outcome lifecycle, credential rejection, evidence linking |
| `test/rank.test.mjs` | environment gate, scoring order, **long-request relevance regression**, reliability smoothing, similarity, repeat metric |
| `test/redact.test.mjs` | every credential rule, and the "useful lesson mentioning a credential survives" case |
| `test/store.test.mjs` | round trip, scope separation, forget-project, journal append-only, hand-edited files, malformed files, audit + digest |
| `test/schema.test.mjs` | tool schemas stay inside the host-supported JSON Schema subset the registry asserts |

---

## Hooks used

| Hook | Purpose |
|---|---|
| `agent/session-start` | Learn the project context; register per-session cleanup |
| `agent/pre-step` (`{prepend:true}` waterfall) | Retrieval. Prepended so `next()` yields the final claimed batch from every other contributor; appends exactly one `recall`-form plugin message |
| `user-questions/request` (waterfall) | Observe a question the agent posed — its option labels and the answer — then delegate with `next()`. Pure observation: never claims, answers, or delays a question. This is what gives a one-letter reply an exact referent |
| `session/event` | Deterministic evidence capture into `episodes.jsonl` |
| `session/flush` | Durability |
| `ctx.effect` | Flush on unload; dispose the skill provider |

Registrations: `ctx.tools.register` ×2, `ctx.commands.register` ×1,
`ctx.systemPrompt.section` at order 3000 (after first-party tool guidance,
before the tools SDK), `ctx.skills.registerProvider` ×1, `ctx.provide('experienceLoop')`.

---

## Known limitations

- **The write path is model-driven.** If the model never calls
  `experience_review`, nothing is distilled; the episode journal still records
  the evidence and `/experience pending` shows it. There is no background
  consolidator (deliberately: no LLM calls inside the plugin, no recursion).
- **Keyword scoring, not embeddings.** Accurate for the vocabulary-overlap case
  this system targets, and free; it will miss a relevant record that shares no
  vocabulary with the request. Relevance is a *saturating function of the
  overlap count* plus Jaccard precision — deliberately not query coverage, which
  would score a long, detailed task prompt lower than a one-line one (a bug
  caught in live testing).
- **A conflict is surfaced, not resolved.** Resolution is a human decision or an
  explicit `supersedes`.
- **No cross-machine sync.** Data is local files; use `/experience export` +
  `import` to move it.
- **Subagent retrieval is off by default**, so a delegated agent does not reuse
  what the parent learned unless `inject.subagents` is enabled.
- **Editing the plugin's `.mjs` requires a dsh restart** (module reload is a
  separate opt-in in this harness).
- **`metric` needs real repetition.** It reports honestly that it has nothing to
  compare until a task signature has occurred twice.
