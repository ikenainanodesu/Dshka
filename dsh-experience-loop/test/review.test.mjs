import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig } from '../lib/config.mjs'
import { ExperienceStore } from '../lib/store.mjs'
import { applyReview } from '../lib/review.mjs'
import { CONFLICT_SIMILARITY, MERGE_SIMILARITY, similarity } from '../lib/rank.mjs'
import { cleanup, makeLogger, makeTempStoreRoot } from './harness.mjs'

function setup(root, overrides = {}) {
  const { config } = resolveConfig({ storeRoot: root, ...overrides })
  const logger = makeLogger()
  const store = new ExperienceStore({ root, logger })
  const context = {
    sessionId: 'session-x',
    turn: 1,
    projectKey: 'C-work-example-project',
    projectPath: 'C:\\work\\example-project',
    platform: 'win32',
    shell: 'pwsh',
    source: 'agent',
    episodeIds: [],
  }
  store.setProject(context.projectKey, context.projectPath)
  return { config, store, logger, context }
}

const SKILL = {
  type: 'skill',
  title: 'Docker service recovery',
  summary: 'Recover a Docker service that will not stay up and prove it is healthy.',
  scope: 'project',
  confidence: 0.5,
  tags: ['docker', 'healthcheck'],
  body: {
    purpose: 'Recover a docker service that will not stay running',
    trigger: 'a container exits or restarts repeatedly',
    steps: ['check container state', 'read recent logs', 'check host port conflicts', 'restart the service'],
    validation: ['healthcheck reports healthy', 'the API returns the expected payload'],
    pitfalls: ['docker restart exits 0 but the app can still be broken'],
  },
}

test('create: a review writes a candidate record with a usable id and keywords', () => {
  const root = makeTempStoreRoot('review')
  try {
    const { store, config, logger, context } = setup(root)
    const report = applyReview({
      store,
      payload: { experiences: [SKILL] },
      context,
      config,
      logger,
    })
    assert.equal(report.created.length, 1)
    const record = store.find(report.created[0].id)
    assert.equal(record.status, 'candidate')
    assert.equal(record.scope.level, 'project')
    assert.ok(record.keywords.length > 5, 'keywords are stamped for cheap scoring')
    assert.match(record.skillName, /^exp-docker-service-recovery/)
    assert.equal(store.recentAudit(5)[0].action, 'create')
  } finally {
    cleanup(root)
  }
})

test('dedupe: a near-identical restatement merges instead of creating a copy', () => {
  const root = makeTempStoreRoot('review')
  try {
    const { store, config, logger, context } = setup(root)
    const first = applyReview({ store, payload: { experiences: [SKILL] }, context, config, logger })
    const id = first.created[0].id

    const restated = {
      ...SKILL,
      body: {
        ...SKILL.body,
        steps: [...SKILL.body.steps, 'check DNS resolution first'],
        pitfalls: [...SKILL.body.pitfalls, 'a healthy container can still serve 500s'],
      },
    }
    const second = applyReview({ store, payload: { experiences: [restated] }, context, config, logger })

    assert.equal(second.created.length, 0, 'no duplicate id was minted')
    assert.equal(second.merged.length, 1)
    assert.equal(second.merged[0].id, id, 'the SAME record was refined, not forked')
    const record = store.find(id)
    assert.equal(record.version, 2)
    assert.equal(record.body.steps.length, 5)
    assert.ok(record.body.steps.includes('check DNS resolution first'))
    assert.equal(store.all(context.projectKey).length, 1)
  } finally {
    cleanup(root)
  }
})

test('conflict: contradictory neighbours are both kept, linked, and never silently overwritten', () => {
  const root = makeTempStoreRoot('review')
  try {
    const { store, config, logger, context } = setup(root)

    const a = {
      type: 'memory',
      title: 'Docker port conflict recovery find owner',
      summary: 'Find the process that owns the port and stop it, then restart the service.',
      scope: 'global',
    }
    const b = {
      type: 'memory',
      title: 'Docker port conflict recovery find owner',
      summary:
        'Find the process that owns the port, then rebuild the image, redeploy the compose stack and change the exposed port.',
      scope: 'global',
    }
    // Pin the band this test depends on: too similar would merge, too
    // dissimilar would simply create.
    const band = similarity(a, b)
    assert.ok(
      band >= CONFLICT_SIMILARITY && band < MERGE_SIMILARITY,
      `fixture similarity ${band.toFixed(3)} must sit inside the conflict band [${CONFLICT_SIMILARITY}, ${MERGE_SIMILARITY})`,
    )

    const first = applyReview({ store, payload: { experiences: [a] }, context, config, logger })
    const second = applyReview({ store, payload: { experiences: [b] }, context, config, logger })

    assert.equal(second.conflicts.length, 1)
    const oldRecord = store.find(first.created[0].id)
    const newRecord = store.find(second.created[0].id)
    assert.equal(store.all(context.projectKey).length, 2, 'both survive')
    assert.deepEqual(newRecord.conflictsWith, [oldRecord.id])
    assert.ok(oldRecord.conflictsWith.includes(newRecord.id))
    const audit = store.recentAudit(10).find((entry) => entry.action === 'conflict')
    assert.ok(audit, 'the conflict is recorded with old/new/reason/environment/decision')
    assert.ok(audit.oldRecord && audit.newRecord && audit.reason && audit.environmentDifference && audit.decision)
  } finally {
    cleanup(root)
  }
})

test('supersede: an explicit replacement retires the old record instead of deleting it', () => {
  const root = makeTempStoreRoot('review')
  try {
    const { store, config, logger, context } = setup(root)
    const first = applyReview({ store, payload: { experiences: [SKILL] }, context, config, logger })
    const oldId = first.created[0].id

    const replacement = {
      ...SKILL,
      title: 'Docker service recovery without compose',
      summary: 'Recover a Docker service that is not managed by compose.',
      supersedes: oldId,
      supersedeReason: 'the compose path was removed from this machine',
    }
    const second = applyReview({ store, payload: { experiences: [replacement] }, context, config, logger })

    assert.equal(second.superseded.length, 1)
    const old = store.find(oldId)
    assert.equal(old.status, 'deprecated')
    assert.match(old.deprecatedReason, /superseded by/)
    const fresh = store.find(second.created[0].id)
    assert.equal(fresh.supersedes, oldId)
    assert.equal(store.recentAudit(5).find((entry) => entry.action === 'supersede').reason, 'the compose path was removed from this machine')
  } finally {
    cleanup(root)
  }
})

test('lifecycle: outcomes promote candidate -> verified and failures deprecate', () => {
  const root = makeTempStoreRoot('review')
  try {
    const { store, config, logger, context } = setup(root)
    const first = applyReview({ store, payload: { experiences: [SKILL] }, context, config, logger })
    const id = first.created[0].id
    assert.equal(store.find(id).status, 'candidate')

    applyReview({
      store,
      payload: { experiences: [], outcomes: [{ id, outcome: 'success' }, { id, outcome: 'success' }] },
      context,
      config,
      logger,
    })
    const promoted = store.find(id)
    assert.equal(promoted.status, 'verified')
    assert.equal(promoted.successCount, 2)
    assert.equal(promoted.useCount, 2)

    applyReview({
      store,
      payload: { experiences: [], outcomes: [{ id, outcome: 'failure' }, { id, outcome: 'failure' }, { id, outcome: 'failure' }] },
      context,
      config,
      logger,
    })
    const demoted = store.find(id)
    assert.equal(demoted.status, 'deprecated')
    assert.match(demoted.deprecatedReason, /auto:/)
  } finally {
    cleanup(root)
  }
})

test('a payload that is nothing but credentials is rejected, a mixed one is redacted', () => {
  const root = makeTempStoreRoot('review')
  try {
    const { store, config, logger, context } = setup(root)
    const report = applyReview({
      store,
      payload: {
        experiences: [
          { type: 'memory', title: 'sk-abcdefghijklmnopqrstuvwxyz012345', summary: 'password=hunter2secret' },
          {
            type: 'failure',
            title: 'Exporting the key in the wrong shell breaks the deploy',
            summary: 'Setting DEEPSEEK_API_KEY=sk-abcdefghijklmnopqrstuv in the interactive shell shadowed the repo .env.',
            body: { attempted: 'export DEEPSEEK_API_KEY=sk-abcdefghijklmnopqrstuv', cause: 'shell env shadowed .env' },
          },
        ],
      },
      context,
      config,
      logger,
    })
    assert.equal(report.rejected.length, 1)
    assert.equal(report.created.length, 1)
    assert.ok(report.redactions >= 1)
    const stored = store.find(report.created[0].id)
    const serialized = JSON.stringify(stored)
    assert.ok(!serialized.includes('sk-abcdefghijklmnopqrstuv'), 'no raw key reached the store')
    assert.ok(serialized.includes('«redacted:'))
  } finally {
    cleanup(root)
  }
})

test('review links the session evidence it was distilled from', () => {
  const root = makeTempStoreRoot('review')
  try {
    const { store, config, logger, context } = setup(root)
    store.appendEpisode({ id: 'ep_1', sessionId: context.sessionId, turn: 1, ask: 'x', toolCallCount: 3, startedAt: '2026-01-01T00:00:00Z' })
    applyReview({
      store,
      payload: { experiences: [SKILL] },
      context: { ...context, episodeIds: ['ep_1'] },
      config,
      logger,
    })
    const episode = store.recentEpisodes(5)[0]
    assert.ok(episode.reviewedAt, 'the episode is marked reviewed')
    assert.equal(episode.recordIds.length, 1)
  } finally {
    cleanup(root)
  }
})

test('international titles still get a valid kebab-case skill name', () => {
  const root = makeTempStoreRoot('review')
  try {
    const { store, config, logger, context } = setup(root)
    const report = applyReview({
      store,
      payload: {
        experiences: [
          {
            type: 'skill',
            title: 'Docker 服务无法启动的排查流程',
            summary: '按顺序检查容器状态、日志、端口占用与依赖服务。',
            scope: 'global',
            body: { purpose: '排查 docker 服务启动失败', steps: ['检查容器状态', '查看日志'] },
          },
        ],
      },
      context,
      config,
      logger,
    })
    const record = store.find(report.created[0].id)
    assert.match(record.skillName, /^exp-(x[0-9a-f]{10}|[a-z0-9-]+)$/)
    assert.ok(!/[^a-z0-9-]/.test(record.skillName))
  } finally {
    cleanup(root)
  }
})
