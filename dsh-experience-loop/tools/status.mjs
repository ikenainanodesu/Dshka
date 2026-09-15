/**
 * One command that answers "is the Experience Loop plugin actually loaded and
 * working in the RUNNING dsh?"
 *
 *   node tools/status.mjs [--store <root>] [--sessions <dir>] [--session <id>] [--limit <n>]
 *
 * It reads only durable artefacts, so it works whether or not you can see the
 * dsh terminal, and it never needs dsh to be reachable:
 *
 *   1. the plugin's own counters and record counts from the store;
 *   2. the newest session log(s): is the prompt section in the latest
 *      `system/message`? are the plugin tools in the latest `request/header`?
 *   3. every `<experience_loop_context>` block the plugin actually injected;
 *   4. an ACTIVATION CHECK for the relevance fix — for the most recent
 *      injection it recomputes both the old and the new relevance formula. If
 *      the old formula would have scored the record below its 0.14 floor and
 *      the new one did not, the running process is executing the fixed code.
 *      This is the only way to tell "the fix is live" from "the fix is on disk"
 *      without restarting anything.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { jaccard, tokenize } from '../lib/util.mjs'
import { keywordsFor, overlapCount } from '../lib/rank.mjs'

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.cwd(), '.dsh')
const storeRoot = argOf('store', join(dshHome, 'experience-loop'))
const sessionsRoot = argOf('sessions', join(dshHome, 'sessions'))
const onlySession = argOf('session', undefined)
const limit = Number.parseInt(argOf('limit', '3'), 10)

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** The session log is a CONCATENATION of independent zstd frames; a single pass
 *  silently returns only the first (the header), so decode frame by frame. */
function decodeSessionLog(path) {
  const buffer = readFileSync(path)
  let cursor = 0
  let text = ''
  let frames = 0
  while ((cursor = buffer.indexOf(ZSTD_MAGIC, cursor)) !== -1) {
    try {
      text += zstdDecompressSync(buffer.subarray(cursor)).toString('utf8')
      frames += 1
    } catch {
      /* a compressed payload can contain the magic bytes by coincidence */
    }
    cursor += ZSTD_MAGIC.length
  }
  const records = text
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
  return { records, frames }
}

function findSessionLogs() {
  if (!existsSync(sessionsRoot)) return []
  const found = []
  for (const dir of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const cwdDir = join(sessionsRoot, dir.name)
    let entries
    try {
      entries = readdirSync(cwdDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sessionDir of entries) {
      if (!sessionDir.isDirectory()) continue
      if (onlySession && !sessionDir.name.includes(onlySession)) continue
      const full = join(cwdDir, sessionDir.name)
      for (const file of readdirSync(full)) {
        if (!file.endsWith('.jsonl.zstd') && !file.endsWith('.jsonl.zst')) continue
        const path = join(full, file)
        try {
          found.push({ path, sessionId: sessionDir.name, workspace: dir.name, mtime: statSync(path).mtimeMs })
        } catch {
          /* racing a writer */
        }
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')

// ── 1. store ────────────────────────────────────────────────────────────────
console.log('='.repeat(78))
console.log('STORE')
console.log('='.repeat(78))
console.log(`root  ${storeRoot}`)
if (!existsSync(storeRoot)) {
  console.log('(absent — the plugin has never written anything)')
} else {
  const read = (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return undefined
    }
  }
  const records = []
  const globalDoc = read(join(storeRoot, 'global', 'experiences.json'))
  if (globalDoc?.records) records.push(...globalDoc.records)
  const projectsDir = join(storeRoot, 'projects')
  if (existsSync(projectsDir)) {
    for (const project of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      const doc = read(join(projectsDir, project.name, 'experiences.json'))
      if (doc?.records) records.push(...doc.records)
    }
  }
  const count = (key) => records.reduce((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] ?? 0) + 1 }), {})
  const perProject = records
    .filter((r) => r.scope?.level === 'project')
    .reduce((acc, r) => ({ ...acc, [r.scope.project ?? '?']: (acc[r.scope.project ?? '?'] ?? 0) + 1 }), {})
  // NOTE: this counts EVERY scope on disk, whereas the plugin's own
  // `experience_query {action:"stats"}` is scoped to the calling project — so
  // the two numbers legitimately differ. Both are printed for that reason.
  console.log(`records ${records.length}  (ALL scopes on disk; the plugin's own stats is project-scoped)`)
  console.log(`  by status ${JSON.stringify(count('status'))}   by type ${JSON.stringify(count('type'))}`)
  console.log(`  by project ${JSON.stringify(perProject)}`)
  const state = read(join(storeRoot, 'state.json'))
  if (state) {
    console.log(
      `counters injections=${state.injections} (${state.injectionChars} chars)  reviews=${state.reviews}  created=${state.recordsCreated}  merged=${state.recordsMerged}`,
    )
    console.log(`         episodes=${state.episodes}  outcomes=${state.outcomesSuccess}ok/${state.outcomesFailure}failed`)
  }
}

// ── 2/3/4. session logs ─────────────────────────────────────────────────────
const logs = findSessionLogs().slice(0, Number.isFinite(limit) ? limit : 3)
if (logs.length === 0) {
  console.log('\nno session logs found under', sessionsRoot)
  process.exit(0)
}

// Record lookup for the activation check.
const allRecords = []
try {
  const g = JSON.parse(readFileSync(join(storeRoot, 'global', 'experiences.json'), 'utf8'))
  if (g?.records) allRecords.push(...g.records)
  const pdir = join(storeRoot, 'projects')
  if (existsSync(pdir)) {
    for (const project of readdirSync(pdir, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      const doc = JSON.parse(readFileSync(join(pdir, project.name, 'experiences.json'), 'utf8'))
      if (doc?.records) allRecords.push(...doc.records)
    }
  }
} catch {
  /* the activation check degrades to "not verifiable" */
}

for (const log of logs) {
  const { records, frames } = decodeSessionLog(log.path)
  console.log(`\n${'='.repeat(78)}`)
  console.log(`SESSION ${log.sessionId}`)
  console.log('='.repeat(78))
  console.log(`${log.path}`)
  console.log(`${frames} zstd frame(s), ${records.length} record(s), last write ${new Date(log.mtime).toISOString()}`)

  const header = records.find((r) => r.type === 'session')
  console.log(`cwd ${header?.cwd ?? '(unknown)'}   origin ${header?.origin ?? '(top level)'}`)

  const system = records.filter((r) => r.type === 'system/message')
  const lastSystem = system[system.length - 1]
  if (lastSystem) {
    const text = JSON.stringify(lastSystem.data.message?.content ?? '')
    console.log(
      `prompt section   ${text.includes('## Experience Loop') ? 'PRESENT' : 'ABSENT'}  (last system/message seq ${lastSystem.seq})`,
    )
  } else {
    console.log('prompt section   ABSENT  (no system/message yet)')
  }

  const headers = records.filter((r) => r.type === 'request/header')
  const lastHeader = headers[headers.length - 1]
  if (lastHeader) {
    const names = (lastHeader.data.header?.tools ?? []).map((t) => t.name)
    const pluginTools = names.filter((n) => n.startsWith('experience'))
    console.log(
      `plugin tools     ${pluginTools.length > 0 ? pluginTools.join(', ') : 'ABSENT'}  (of ${names.length} in the last request/header)`,
    )
  } else {
    console.log('plugin tools     ABSENT  (no request/header yet)')
  }

  const injected = records.filter((r) => r.type === 'user/message' && r.data?.source?.plugin === 'experience-loop')
  console.log(`injections       ${injected.length}`)
  for (const message of injected) {
    const text = textOf(message.data.content)
    console.log(`\n  --- seq ${message.seq} · ${new Date(message.time).toISOString()} · ${text.length} chars ---`)
    for (const line of text.split('\n')) console.log(`  | ${line}`)
  }

  // 4. Activation check for the relevance fix.
  const lastInjection = injected[injected.length - 1]
  if (!lastInjection) continue
  const injectedText = textOf(lastInjection.data.content)
  // The ask that drove it: the last human prompt at or before the injection.
  const asks = records.filter(
    (r) => r.type === 'user/message' && r.seq <= lastInjection.seq && r.data?.source?.kind === 'user',
  )
  const ask = textOf(asks[asks.length - 1]?.data?.content)
  if (ask === '') continue
  const query = tokenize(ask)
  console.log(`\n  ACTIVATION CHECK (relevance fix)`)
  console.log(`  ask ${ask.length} chars -> ${query.size} query tokens`)
  let anyDiscriminating = false
  for (const record of allRecords) {
    if (!injectedText.includes(record.title)) continue
    const tokens = keywordsFor(record)
    const overlap = overlapCount(query, tokens)
    const jac = jaccard(query, tokens)
    const oldRelevance = 0.75 * (overlap / query.size) + 0.25 * jac
    const newRelevance = 0.65 * (overlap / (overlap + 3)) + 0.35 * jac
    const oldPasses = oldRelevance >= 0.14
    const discriminating = !oldPasses && newRelevance >= 0.18
    if (discriminating) anyDiscriminating = true
    console.log(
      `  · "${record.title.slice(0, 52)}" overlap ${overlap}  old ${oldRelevance.toFixed(3)} ${oldPasses ? '(passes)' : '(FILTERED)'}  new ${newRelevance.toFixed(3)}`,
    )
  }
  console.log(
    anyDiscriminating
      ? '  => at least one record could ONLY have been selected by the fixed code: the running process is executing the fix.'
      : '  => inconclusive: the old formula would also have selected these records, so this observation does not prove the fix is live.',
  )
}
