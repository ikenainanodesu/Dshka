import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { ExperienceStore, makeRecord } from '../lib/store.mjs'
import { stampKeywords } from '../lib/rank.mjs'
import { cleanup, makeLogger, makeTempStoreRoot } from './harness.mjs'

const CONTEXT = {
  scope: 'global',
  projectKey: 'C-work-example-project',
  projectPath: 'C:\\work\\example-project',
  platform: 'win32',
  shell: 'pwsh',
  source: 'test',
}

function build(root) {
  const logger = makeLogger()
  const store = new ExperienceStore({ root, logger })
  store.setProject(CONTEXT.projectKey, CONTEXT.projectPath)
  return { store, logger }
}

function record(overrides) {
  const built = makeRecord(overrides, { ...CONTEXT, scope: overrides.scopeLevel ?? 'global' })
  return stampKeywords(built)
}

test('records survive a round trip through disk, in human-readable JSON', () => {
  const root = makeTempStoreRoot('store')
  try {
    const { store } = build(root)
    store.put(record({ id: 'exp_1', type: 'memory', title: 'Uses pnpm', summary: 'This repo uses pnpm, not npm.' }))
    store.put(
      record({
        id: 'exp_2',
        type: 'failure',
        title: 'docker restart proves nothing',
        summary: 'exit 0 from docker restart does not mean the app is healthy.',
        scopeLevel: 'project',
      }),
    )
    store.flush()

    const globalFile = join(root, 'global', 'experiences.json')
    assert.ok(existsSync(globalFile), 'global document must exist')
    const raw = JSON.parse(readFileSync(globalFile, 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.records.length, 1)
    assert.equal(raw.records[0].title, 'Uses pnpm')

    const projectFile = join(root, 'projects', CONTEXT.projectKey, 'experiences.json')
    assert.ok(existsSync(projectFile), 'project document must exist')

    const reloaded = build(root).store
    assert.equal(reloaded.all(CONTEXT.projectKey).length, 2)
    const failure = reloaded.find('exp_2')
    assert.equal(failure.scope.level, 'project')
    assert.match(failure.summary, /does not mean the app is healthy/)
  } finally {
    cleanup(root)
  }
})

test('global and project scopes stay separate', () => {
  const root = makeTempStoreRoot('store')
  try {
    const { store } = build(root)
    store.put(record({ id: 'g1', type: 'memory', title: 'global fact', summary: 'applies everywhere' }))
    store.put(record({ id: 'p1', type: 'memory', title: 'project fact', summary: 'only here', scopeLevel: 'project' }))
    store.flush()
    assert.deepEqual(
      store.all(CONTEXT.projectKey).map((entry) => entry.id).sort(),
      ['g1', 'p1'],
    )
    // A different project sees only the global record.
    const other = build(root).store
    assert.deepEqual(
      other.all('D-other-project').map((entry) => entry.id),
      ['g1'],
    )
  } finally {
    cleanup(root)
  }
})

test('forget-project deletes project records and leaves globals alone', () => {
  const root = makeTempStoreRoot('store')
  try {
    const { store } = build(root)
    store.put(record({ id: 'g1', type: 'memory', title: 'global', summary: 'keep me' }))
    store.put(record({ id: 'p1', type: 'memory', title: 'project', summary: 'drop me', scopeLevel: 'project' }))
    store.flush()
    const removed = store.forgetProject(CONTEXT.projectKey)
    assert.equal(removed, 1)
    store.flush()
    const reloaded = build(root).store
    assert.deepEqual(
      reloaded.all(CONTEXT.projectKey).map((entry) => entry.id),
      ['g1'],
    )
    assert.ok(!existsSync(join(root, 'projects', CONTEXT.projectKey, 'experiences.json')))
  } finally {
    cleanup(root)
  }
})

test('episodes are an append-only journal and are not records', () => {
  const root = makeTempStoreRoot('store')
  try {
    const { store } = build(root)
    store.appendEpisode({ id: 'ep_1', sessionId: 's1', turn: 1, ask: 'a', toolCallCount: 2, startedAt: '2026-01-01T00:00:00Z' })
    store.appendEpisode({ id: 'ep_2', sessionId: 's1', turn: 2, ask: 'b', toolCallCount: 5, startedAt: '2026-01-01T01:00:00Z' })
    assert.equal(store.recentEpisodes(10).length, 2)
    assert.equal(store.all(CONTEXT.projectKey).length, 0, 'episodes never become records by themselves')
    assert.equal(store.pendingEpisodes(10, 's1').length, 2)
    const linked = store.markEpisodesReviewed(['ep_1'], ['exp_x'])
    assert.equal(linked, 1)
    assert.equal(store.pendingEpisodes(10, 's1').length, 1)
    const reviewed = store.recentEpisodes(10).find((episode) => episode.id === 'ep_1')
    assert.deepEqual(reviewed.recordIds, ['exp_x'])
  } finally {
    cleanup(root)
  }
})

test('a hand-edited document is read back without dropping unknown fields', () => {
  const root = makeTempStoreRoot('store')
  try {
    const { store } = build(root)
    store.put(record({ id: 'exp_1', type: 'memory', title: 'Original', summary: 'original summary' }))
    store.flush()

    // Simulate a human editing the JSON: rename, add a custom note field.
    const file = join(root, 'global', 'experiences.json')
    const document = JSON.parse(readFileSync(file, 'utf8'))
    document.records[0].title = 'Hand edited title'
    document.records[0].status = 'verified'
    document.records.push({
      id: 'exp_hand',
      type: 'memory',
      title: 'Written by hand',
      summary: 'Added directly in the JSON file.',
      scope: { level: 'global' },
      customNote: 'preserved',
    })
    writeFileSync(file, JSON.stringify(document, null, 2))

    const reloaded = build(root).store
    assert.equal(reloaded.find('exp_1').title, 'Hand edited title')
    assert.equal(reloaded.find('exp_1').status, 'verified')
    const hand = reloaded.find('exp_hand')
    assert.equal(hand.title, 'Written by hand')
    assert.equal(hand.status, 'candidate')
  } finally {
    cleanup(root)
  }
})

test('a malformed document degrades to an empty view instead of throwing', () => {
  const root = makeTempStoreRoot('store')
  try {
    const { store, logger } = build(root)
    store.put(record({ id: 'exp_1', type: 'memory', title: 'x', summary: 'y' }))
    store.flush()
    writeFileSync(join(root, 'global', 'experiences.json'), '{ not json')
    const reloaded = build(root)
    assert.equal(reloaded.store.all(CONTEXT.projectKey).length, 0)
    assert.equal(reloaded.store.find('exp_1'), undefined)
    reloaded.store.loadScope('global', undefined)
    assert.ok(reloaded.logger.lines.some((line) => line.level === 'warn'))
    assert.ok(logger)
  } finally {
    cleanup(root)
  }
})

test('audit and digest are written beside the data', () => {
  const root = makeTempStoreRoot('store')
  try {
    const { store } = build(root)
    store.put(record({ id: 'exp_1', type: 'skill', title: 'Do the thing', summary: 'Step by step.' }))
    store.audit({ action: 'create', recordId: 'exp_1' })
    store.flush()
    assert.equal(store.recentAudit(5).length, 1)
    const digest = readFileSync(join(root, 'digest.md'), 'utf8')
    assert.match(digest, /Experience Loop digest/)
    assert.match(digest, /Do the thing/)
    assert.ok(existsSync(join(root, 'HOW-TO-EDIT.md')))
  } finally {
    cleanup(root)
  }
})
