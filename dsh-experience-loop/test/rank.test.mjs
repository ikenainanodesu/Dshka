import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig } from '../lib/config.mjs'
import {
  computeRepeatMetric,
  environmentFit,
  makeQuery,
  rankRecords,
  reliability,
  similarity,
  taskSignature,
} from '../lib/rank.mjs'
import { keywordRecord } from './helpers.mjs'

const { config } = resolveConfig({ storeRoot: 'X:\\unused' })

function query(text, env = { platform: 'win32', shell: 'pwsh' }) {
  return makeQuery({ text, env: { platform: 'win32', shell: 'pwsh', ...env }, config })
}

test('a Windows-only skill is never offered in a Linux environment', () => {
  const record = keywordRecord({
    type: 'skill',
    title: 'Reset the Print Spooler on Windows',
    summary: 'Stop the spooler service, clear the queue, restart it.',
    applies: { platform: 'win32', shell: 'pwsh' },
  })
  const onWindows = environmentFit(record, { platform: 'win32', shell: 'pwsh' })
  assert.equal(onWindows.accepted, true)
  const onLinux = environmentFit(record, { platform: 'linux', shell: 'bash' })
  assert.equal(onLinux.accepted, false)
  assert.match(onLinux.reason, /platform/)

  const hits = rankRecords([record], query('the printer spooler is stuck', { platform: 'linux', shell: 'bash' }), {
    minScore: 0,
  })
  assert.equal(hits.length, 0)
})

test('a shell mismatch is also a hard gate', () => {
  const record = keywordRecord({
    type: 'validation',
    title: 'Prove a Windows service restarted',
    summary: 'Query the service state with Get-Service before reporting success.',
    applies: { shell: 'pwsh' },
  })
  assert.equal(environmentFit(record, { platform: 'win32', shell: 'pwsh' }).accepted, true)
  assert.equal(environmentFit(record, { platform: 'linux', shell: 'bash' }).accepted, false)
})

test('a project mismatch is a penalty, not a gate', () => {
  const record = keywordRecord({
    type: 'memory',
    title: 'This project runs pnpm dev on port 3080',
    summary: 'The dev server listens on 3080.',
    applies: { project: 'other-project' },
  })
  const fit = environmentFit(record, { platform: 'win32', shell: 'pwsh', project: 'example-project' })
  assert.equal(fit.accepted, true)
  assert.ok(fit.factor < 1)
})

test('relevance ranks a matching record above an unrelated one', () => {
  const relevant = keywordRecord({
    type: 'skill',
    title: 'Docker service recovery',
    summary: 'Check container state, read logs, check port conflicts, then restart and verify the healthcheck.',
  })
  const irrelevant = keywordRecord({
    type: 'skill',
    title: 'Aseprite sprite export',
    summary: 'Export frames to png with the aseprite CLI.',
  })
  const hits = rankRecords([irrelevant, relevant], query('docker container keeps restarting'), {
    minScore: 0,
    minRelevance: 0,
    minOverlap: 0,
  })
  assert.equal(hits.length, 2)
  assert.equal(hits[0].record.title, 'Docker service recovery')
  assert.ok(hits[0].relevance > hits[1].relevance)

  // With the production floors (>= 2 shared tokens, relevance >= 0.18) the
  // unrelated record is dropped entirely.
  const floored = rankRecords([irrelevant, relevant], query('docker container keeps restarting'), { minScore: 0 })
  assert.deepEqual(
    floored.map((hit) => hit.record.title),
    ['Docker service recovery'],
  )
})

test('suppressed recall: the same query never returns a deprecated record', () => {
  const record = keywordRecord({
    type: 'skill',
    title: 'Deprecated docker trick',
    summary: 'docker restart app',
  })
  record.status = 'deprecated'
  assert.equal(rankRecords([record], query('docker restart app'), { minScore: 0 }).length, 0)
})

test('a long, detailed request still retrieves a matching record', () => {
  // Regression: relevance was once plain query coverage, so a multi-paragraph
  // task prompt (large token set) pushed every record below the floor. That was
  // caught live — a subagent given a long instruction received nothing.
  const record = keywordRecord({
    type: 'skill',
    title: 'Load and verify a local DSH plugin without publishing',
    summary:
      'Get an unpublished plugin running inside a live dsh profile and prove it is really loaded, without pnpm, a registry, or a restart.',
    applies: { platform: 'win32', shell: 'pwsh' },
    body: {
      purpose: 'Run a locally developed DSH plugin inside the running harness',
      trigger: 'a plugin lives in a source checkout and must be exercised in the live Web GUI or CLI',
      steps: ['append an insert row to the profile cordis.patch.yml', 'let the live patch watcher re-apply the file'],
      validation: ['system/message in the session log contains the plugin prompt section'],
    },
  })
  const longRequest = [
    'You are running inside DeepSeek Harness (DSH) on Windows.',
    'A plugin named dsh-experience-loop is loaded and registers the tools experience_review and experience_query.',
    'Your only job is to report exactly what is in your own context.',
    'Read your system prompt and every injected context block you were given.',
    'Look for a block delimited by experience_loop_context.',
    'Then call experience_query with action stats and paste its raw result text verbatim.',
    'Do not summarize. Do not explain. Do not edit files.',
    'Report whether the plugin prompt section is visible in your own context.',
  ].join(' ')
  const shortRequest = 'the dsh plugin did not load'
  const env = { platform: 'win32', shell: 'pwsh' }

  const longHits = rankRecords([record], makeQuery({ text: longRequest, env, config }), { minScore: 0 })
  const shortHits = rankRecords([record], makeQuery({ text: shortRequest, env, config }), { minScore: 0 })
  assert.equal(longHits.length, 1, 'a long request must still match')
  assert.equal(shortHits.length, 1)
  assert.ok(longHits[0].relevance > 0.2, `long-request relevance was ${longHits[0].relevance.toFixed(3)}`)

  // …while a record sharing only one incidental word is still rejected.
  const incidental = keywordRecord({
    type: 'skill',
    title: 'Aseprite sprite export',
    summary: 'Export frames to png with the aseprite CLI, then verify the sheet dimensions.',
  })
  assert.equal(
    rankRecords([incidental], makeQuery({ text: longRequest, env, config }), { minScore: 0 }).length,
    0,
  )
})

test('reliability is smoothed so an unused record is not treated as perfect', () => {
  assert.equal(reliability({ successCount: 0, failureCount: 0 }), 0.5)
  assert.ok(reliability({ successCount: 5, failureCount: 0 }) > reliability({ successCount: 0, failureCount: 0 }))
  assert.ok(reliability({ successCount: 0, failureCount: 5 }) < 0.5)
})

test('similarity separates a restatement from a different procedure', () => {
  const a = { title: 'Docker service recovery', summary: 'Check container state then restart the container.' }
  const b = { title: 'Docker container recovery', summary: 'Check the container state, then restart it.' }
  const c = { title: 'Postgres backup restore', summary: 'Restore a dump into a scratch database.' }
  assert.ok(similarity(a, b) > similarity(a, c))
})

test('the repeat metric compares first runs with later runs of the same signature', () => {
  const episodes = [
    { ask: 'fix the docker health check failure', toolCallCount: 12, startedAt: '2026-01-01T00:00:00Z' },
    { ask: 'fix the docker health check failure again', toolCallCount: 11, startedAt: '2026-01-02T00:00:00Z' },
    { ask: 'fix the docker health check issue', toolCallCount: 4, startedAt: '2026-01-03T00:00:00Z' },
    { ask: 'unrelated task about images', toolCallCount: 9, startedAt: '2026-01-04T00:00:00Z' },
  ]
  const metric = computeRepeatMetric(episodes)
  assert.equal(metric.repeatedTaskGroups, 1)
  assert.equal(metric.firstRunAverageToolCalls, 12)
  assert.ok(metric.laterRunAverageToolCalls < 12)
  assert.ok(metric.reductionPercent > 0)
})

test('task signature is stable across restatements', () => {
  const a = taskSignature({ ask: 'fix the docker health check failure' })
  const b = taskSignature({ ask: 'the docker health check failure again' })
  assert.ok(a.split('+').some((token) => b.split('+').includes(token)))
})

test('an empty store yields no hits and no crash', () => {
  assert.deepEqual(rankRecords([], query('anything'), { minScore: 0 }), [])
})
