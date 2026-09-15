/**
 * Diagnostic: "why did (or didn't) the plugin inject anything?"
 *
 * Runs the REAL retrieval pipeline against a REAL store, with no harness and no
 * model, and prints the decision plus the exact block that would be injected.
 * This is the tool to reach for when a session shows no
 * `<experience_loop_context>` and you need to know which stage dropped it.
 *
 *   node tools/check-retrieval.mjs --store <root> --cwd <dir> (--ask <text> | --ask-file <path>)
 *                                  [--platform win32] [--shell pwsh] [--top-k 4] [--budget 1800]
 *                                  [--config <json>]
 *
 * `--from-session <session.jsonl.zstd>` replays a REAL recorded turn: it pulls
 * the first admitted message batch out of a persisted session log and feeds it
 * to `planInjection` exactly as the hook would, which is the only way to test
 * the ask-extraction rules against genuine sources (`user` vs a subagent's
 * relayed `agent-message`) without booting dsh.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { resolveConfig } from '../lib/config.mjs'
import { ExperienceStore } from '../lib/store.mjs'
import { makeQuery, rankRecords, environmentFit } from '../lib/rank.mjs'
import { renderRetrievalBlock } from '../lib/render.mjs'
import { extractAsk, planInjection, RetrievalState } from '../lib/retrieve.mjs'
import { projectKeyOf, projectRootOf } from '../lib/util.mjs'

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Decode a concatenated-frame zstd session log into its JSON records. */
function readSessionLog(path) {
  const buffer = readFileSync(path)
  let cursor = 0
  let text = ''
  while ((cursor = buffer.indexOf(ZSTD_MAGIC, cursor)) !== -1) {
    try {
      text += zstdDecompressSync(buffer.subarray(cursor)).toString('utf8')
    } catch {
      /* false magic inside a compressed payload */
    }
    cursor += ZSTD_MAGIC.length
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

const storeRoot = argOf('store', resolve(process.env.DSH_HOME ?? '.dsh', 'experience-loop'))
const cwd = argOf('cwd', process.cwd())
const askFile = argOf('ask-file', undefined)
const fromSession = argOf('from-session', undefined)
const topK = Number.parseInt(argOf('top-k', '4'), 10)
const budget = Number.parseInt(argOf('budget', '1800'), 10)
const extraConfig = argOf('config', undefined)

let ask = askFile ? readFileSync(askFile, 'utf8') : argOf('ask', '')
let replay = null

if (fromSession) {
  const records = readSessionLog(fromSession)
  const header = records.find((record) => record.type === 'session')
  const sessionId = header?.id ?? 'replayed-session'
  const batch = records.filter((record) => record.type === 'user/message').slice(0, 2).map((record) => record.data)
  replay = { sessionId, batch, cwd: header?.cwd ?? cwd, origin: header?.origin }
  ask = extractAsk(batch)
}

if (ask.trim() === '') {
  console.error(
    'usage: node tools/check-retrieval.mjs --store <root> --cwd <dir> (--ask <text> | --ask-file <path> | --from-session <log>)',
  )
  process.exit(2)
}

const { config } = resolveConfig({
  storeRoot,
  inject: { topK, budgetChars: budget },
  ...(extraConfig ? JSON.parse(extraConfig) : {}),
})

const logger = { warn: (...args) => console.error('[warn]', ...args), info: () => {}, debug: () => {} }
const store = new ExperienceStore({ root: storeRoot, logger })
const effectiveCwd = replay?.cwd ?? cwd
const projectRoot = projectRootOf(effectiveCwd)
const projectKey = projectKeyOf(projectRoot)
store.setProject(projectKey, projectRoot)

const records = store.all(projectKey)
const env = {
  platform: argOf('platform', process.platform),
  shell: argOf('shell', process.platform === 'win32' ? 'pwsh' : 'bash'),
  project: projectRoot ? projectRoot.split(/[\\/]/).filter(Boolean).pop() : undefined,
  projectKey,
  projectPath: projectRoot,
}

console.log(`store          ${storeRoot}`)
console.log(`cwd            ${effectiveCwd}`)
console.log(`project root   ${projectRoot}`)
console.log(`project key    ${projectKey}`)
console.log(`platform/shell ${env.platform}/${env.shell}`)
if (replay) {
  console.log(`replayed from  ${fromSession}`)
  console.log(`session        ${replay.sessionId}  origin=${replay.origin ?? '(top level)'}`)
  console.log(`message batch  ${replay.batch.length} message(s), sources: ${replay.batch.map((m) => `${m.source?.kind}${m.source?.form ? `/${m.source.form}` : ''}`).join(', ')}`)
}
console.log(`ask            ${ask.trim().split('\n')[0].slice(0, 110)}${ask.trim().length > 110 ? '…' : ''}`)
console.log(`ask chars      ${ask.length}`)
console.log(`records visible ${records.length} (${records.filter((r) => r.scope.level === 'global').length} global, ${records.filter((r) => r.scope.level === 'project').length} project)`)
console.log()

const query = makeQuery({ text: ask, env, config })
console.log(`query tokens   ${query.tokens.size}`)
console.log()

// Every record, scored, including the ones that fail the floors — so a silent
// no-injection is explained rather than mysterious.
const scored = rankRecords(records, query, { limit: 100, minScore: 0, minOverlap: 0, minRelevance: 0 })
const ranked = records
  .map((record) => {
    const hit = scored.find((entry) => entry.record.id === record.id)
    const overlap = hit ? hit.overlap : 0
    const fit = environmentFit(record, { platform: env.platform, shell: env.shell, runtime: undefined, project: env.project })
    return {
      id: record.id,
      type: record.type,
      status: record.status,
      scope: record.scope.level,
      overlap,
      relevance: hit ? hit.relevance : 0,
      score: hit ? hit.score : 0,
      accepted: fit.accepted,
      reason: fit.accepted ? '' : fit.reason,
      title: record.title.slice(0, 60),
    }
  })
  .sort((a, b) => b.score - a.score)

console.log('id                        type       status     scope    ovlp  relev  score  ok')
for (const row of ranked) {
  console.log(
    `${row.id.padEnd(25)} ${row.type.padEnd(10)} ${row.status.padEnd(10)} ${row.scope.padEnd(8)} ${String(row.overlap).padStart(4)}  ${row.relevance.toFixed(3)}  ${row.score.toFixed(3)}  ${row.accepted ? 'yes' : `NO (${row.reason})`}`,
  )
}

const hits = rankRecords(records, query, {
  limit: config.injectTopK,
  minScore: config.injectMinScore,
  minOverlap: 2,
  minRelevance: 0.18,
})
console.log()
console.log(`selected for injection: ${hits.length} (topK ${config.injectTopK}, minScore ${config.injectMinScore})`)
const block = renderRetrievalBlock(hits, [], config.injectBudgetChars)
console.log()
console.log(block === '' ? 'WOULD NOT INJECT (nothing passed the floors)' : block)
console.log()
console.log(`block chars ${block.length} / budget ${config.injectBudgetChars}`)

// When replaying a real turn, run the whole decision — including every early
// return — so the printed reason is the hook's own reason, not a guess.
if (replay) {
  console.log()
  console.log('--- full planInjection decision (what the agent/pre-step hook returns) ---')
  const state = new RetrievalState({ ...config, injectSubagents: true })
  const session = { id: replay.sessionId, header: { cwd: replay.cwd, origin: replay.origin } }
  const decision = planInjection({
    store,
    session,
    turn: 1,
    messages: replay.batch,
    config: { ...config, injectSubagents: true },
    state,
    logger,
  })
  console.log(`reason      ${decision.reason}`)
  console.log(`hits        ${decision.hits.length}`)
  console.log(`block chars ${decision.text.length}`)
  if (decision.text !== '') {
    console.log()
    console.log(decision.text)
  }
}
