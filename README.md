# Dshka

Working repository for a locally developed [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)
plugin, plus the operational notes that go with running it on this machine.

| Path | What it is |
|---|---|
| `dsh-experience-loop/` | The plugin. A bounded, auditable continual-learning loop for dsh: **execute → validate → review → distil → reuse → revise**. Zero `@deepseek-ai/*` imports, no runtime dependencies, plain JSON + Markdown store. See its [README](dsh-experience-loop/README.md). |
| `docs/` | Operational runbooks written after real incidents. Written in Chinese; paths refer to this workstation. |

## Quick start

```sh
cd dsh-experience-loop
node tools/run-tests.mjs      # full test suite
node tools/smoke.mjs          # end-to-end smoke through the real plugin entry
```

Requires Node `^22.19.0 || >=24`. No install step — nothing is fetched.

`DSH_TEST_TMP` overrides the scratch directory used by tests
(default: `<repo>/.tmp-test`, git-ignored).

## Layout

```
dsh-experience-loop/
  index.mjs          plugin entry: hooks, config, tool registration
  lib/               config · store · review · retrieve · rank · render · surface · skills · redact · validate · util
  test/              unit + scenario tests, plus an in-process harness that stands in for the host
  tools/             operator tooling: run tests, smoke, status, profile rows, session-log reading
docs/                restart/recovery runbook for the dsh profile that loads this plugin
```

## Secrets

Nothing in this repository is a live credential. The `sk-…`, `ghp_…` and
`password=…` strings under `test/` are deliberate fixtures for
`lib/redact.mjs` — they exist so the secret filter can be proven to remove
them. `.gitignore` keeps `.env*`, key material, credential stores, session
logs, the local plugin store and test scratch out of the tree.
