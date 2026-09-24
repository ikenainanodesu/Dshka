# DSHKA

**English** | [简体中文](README.zh-CN.md)

A local experience-loop plugin for [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/develop/basic/). It turns reviewed lessons into reusable, inspectable records rather than treating every tool call as knowledge.

**Execute → validate → review → distil → reuse → revise.**

The aim is to reduce repeated investigation and avoid known failures. Improved efficiency is a goal, **not a proven result**. This is retrieval and record maintenance, not model training.

## What it stores

| Record | Purpose |
|---|---|
| **Memory** (`memory`) | Stable facts about a user, environment or project. |
| **Skill** (`skill`) | Reusable procedures, prerequisites, checks and recovery steps. |
| **Failure** (`failure`) | Failed approaches, causes and how to avoid repeating them. |
| **Validation** (`validation`) | Observable evidence that a task actually worked—not merely a successful process exit. |

Records live in global or project scopes, with `candidate`, `verified` or `deprecated` status. Reviews support merging, superseding and surfacing conflicts; a separate episode journal records turn evidence without becoming a lesson automatically.

## Bounded reuse

- Retrieval uses keyword relevance, environment compatibility, confidence, recency and reliability. Platform/shell mismatches are filtered when those facts are known.
- Default injection limits: **4 records**, **1,800 characters** for the whole block, a **1-turn cooldown**, and **60 injections per session**. Subagent retrieval is off by default.
- Retrieval first tries the request itself; if nothing matches, it can use a selected option or the preceding assistant reply as context.
- Learned skills use the host's normal skill catalog and load bodies on demand. By default, both candidates and verified skills are eligible; deprecated skills are excluded.
- Candidate descriptions carry **`[candidate - unproven]`**, with a default **160-character description budget including the marker**. The default catalog cap is **40 skills**, prioritizing verified records, then confidence. This is separate from the retrieval-block budget; catalog entries still cost context.

Use `exposeSkills: verified` or `none` for stricter catalog visibility. Hidden or capped-out candidates may not be reachable through the model's normal skill lookup.

## Install in a DSH profile

Requires an existing compatible DeepSeek Harness installation and **Node.js `^22.19.0 || >=24`**, as declared in the plugin's `package.json`. The plugin uses Node built-ins and has no runtime package dependencies; it does not require a dependency-install step.

1. Clone the repository into `<checkout>`.
2. Back up the profile patch at `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (`DSH_HOME` defaults to `$HOME/.dsh`). Append this row, replacing the example with the **absolute path** to your checkout:

   ```yaml
   - insert:
       - id: experience-loop
         name: 'C:\work\Dshka\dsh-experience-loop\index.mjs'
         config:
           exposeSkills: all
           maxExposedSkills: 40
           candidateDescriptionChars: 160
           observeOutcomes: true
   ```

   On Unix-like systems, use an absolute path such as `/path/to/Dshka/dsh-experience-loop/index.mjs`. Do not leave `<checkout>` or other placeholders in the actual patch.
3. Reload or restart the profile according to your host configuration. Do not assume saving plugin source reloads the running module; restart DSH to activate source changes reliably.
4. In a new turn, check that `experience_query` and `experience_review` are available and `/experience stats` responds. After a review write, inspect the store. An error-free startup alone does not establish that the plugin is active.

To uninstall, remove the inserted row and reload/restart the profile. Stored data remains until you explicitly remove it.

## Review and inspect

- **`experience_query`**: search, list and inspect records; view stats, conflicts, pending reviews, audit entries and repeat-task metrics.
- **`experience_review`**: distil durable lessons once near task completion. Use `mergeInto` to refine existing records and `outcomes` to report evidence of success or failure. Do not store credentials, raw transcripts or guesses.
- **`/experience`**: human controls for inspection, pinning, verification, deprecation, deletion, export and import.

```text
/experience search <topic>
/experience show <record-id>
/experience pending
/experience conflicts
/experience audit
/experience metric
/experience help
```

### Automatic scoring is a heuristic

With `observeOutcomes: true` (the default), the current implementation attributes the end of a turn to learned skills loaded during that turn:

| Signal | Current treatment |
|---|---|
| Skill loaded + turn `completed` | Success; may promote a record. |
| Skill loaded + turn `error` | Failure; may lower confidence or deprecate a record. |
| Turn ends `aborted`, `interrupted`, `blocked` or `max-tokens` | No success/failure score. |
| Record merely appeared in retrieval | Surface counter only; no success/failure score. |

**Loading a skill and completing a turn does not prove the skill helped or that the result was correct. Infrastructure failures may be misattributed to skills.** `verified` is a lifecycle label, not a quality guarantee. Prefer task-specific checks and explicit evidence.

Set **`observeOutcomes: false`** to disable automatic outcome scoring. This also disables the **surface ledger**, not just success/failure attribution; explicit review outcomes remain available.

## Test locally

From the repository root:

```sh
cd dsh-experience-loop
node tools/run-tests.mjs
node tools/smoke.mjs
```

The test runner imports the suite in one process, avoiding per-file child-process spawning. The smoke demo exercises the real plugin entry with a **fake host**, without a model or network. Neither substitutes for checking integration in a running DSH profile. `DSH_TEST_TMP` can override the test scratch directory.

## Privacy boundaries

- The default store is `$DSH_HOME/experience-loop`, or `$HOME/.dsh/experience-loop` when `DSH_HOME` is unset. `storeRoot` overrides it. Records, episode evidence, audit data and generated Markdown are local files—not an encrypted vault.
- The plugin makes no model calls itself, but retrieved records and skill bodies enter the host's model context and may be sent to its configured provider.
- Pattern-based secret redaction reduces accidental exposure; it is **not a guarantee of anonymization or complete credential removal**. Paths, project names, request text and metadata can still be sensitive. Inspect stores and exports before sharing; do not submit real secrets to redaction demos.
- Keep stores, session logs, exports, credentials and local profile configuration outside version control. An ignore rule does not remove already-tracked files or Git history.
- Experience is advisory data. It grants no authority, overrides no current user request, and bypasses no sandbox or approval boundary.

## Limitations

Keyword retrieval can miss paraphrases. Duplicate records and unresolved conflicts need maintenance. Distillation depends on the agent calling the review tool; there is no background model consolidator or cross-machine sync. Catalog visibility adds context cost even when a skill is not loaded.

`/experience metric` compares recorded tool-call counts for comparable repeated requests. It needs sufficient repeat data and is an observational diagnostic—not a controlled benchmark, proof of causation, or evidence of improved answer quality.

## Repository map

- [`dsh-experience-loop/`](dsh-experience-loop/): plugin entry, source, tests and operator tools.
- [`dsh-experience-loop/README.md`](dsh-experience-loop/README.md): detailed configuration and implementation guide.
- [`docs/`](docs/): operational guidance.
