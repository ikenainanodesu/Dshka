/**
 * Observed outcome attribution — the loop closing itself.
 *
 * The property under test is not "does a counter move". It is that a learned
 * skill can reach `verified`, and therefore become loadable and reusable,
 * WITHOUT a model volunteering an outcome it almost never volunteers (measured:
 * 3 of 25 reviews in a real session carried `outcomes`).
 *
 * Just as important is the other half: the signals that are recorded but must
 * NOT score. A turn that merely RECEIVED an injected block tells us nothing
 * about whether the advice was right, so it must never move confidence — and a
 * turn that was cancelled must never be blamed on the record it loaded.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.mjs'
import { cleanup, createFakeHost, makeAgent, makeTempStoreRoot, playSkillGesture, playTurn, userMessage } from './harness.mjs'

const SKILL = {
  type: 'skill',
  title: 'Recover a flapping service',
  summary: 'Bring a service that keeps restarting back to a proven healthy state.',
  scope: 'project',
  confidence: 0.5,
  tags: ['service', 'healthcheck', 'restart'],
  body: {
    purpose: 'Recover a service that will not stay up',
    trigger: 'a service exits or restarts repeatedly',
    steps: ['check state', 'read the last 100 log lines', 'check port conflicts', 'restart', 'verify'],
    validation: ['the healthcheck reports healthy', 'a real business request succeeds'],
    pitfalls: ['a restart command exiting 0 is not proof the app works'],
  },
}

function boot(config = {}) {
  const root = makeTempStoreRoot('outcome')
  const { ctx, host } = createFakeHost()
  const logger = ctx.logger
  apply(ctx, { storeRoot: root, ...config })
  return { root, ctx, host, logger, runtime: host.provided.get('experienceLoop'), agent: makeAgent() }
}

/** Distil one skill and return its record plus the harness name it was given. */
async function learnSkill(host, agent, entry = SKILL) {
  const result = await host.runTool('experience_review', { experiences: [entry] }, { agent })
  const id = result.value.created[0].id
  const record = host.provided.get('experienceLoop').store.find(id)
  return { id, record, skillName: record.skillName }
}

/** A `skill` tool call for one learned skill, as the harness would log it. */
function skillCall(skillName, errorCode) {
  return {
    name: 'skill',
    arguments: JSON.stringify({ name: skillName }),
    ...(errorCode !== undefined ? { errorCode } : {}),
  }
}

test('an observed skill use in a completed turn scores and can promote the record', async () => {
  const { root, host, runtime, agent } = boot({ promoteSuccesses: 2 })
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    const { record, skillName } = await learnSkill(host, agent)
    assert.equal(record.status, 'candidate')
    assert.equal(record.useCount, 0)

    playTurn(host, { session: agent.session, turn: 1, toolCalls: [skillCall(skillName)] })
    assert.equal(record.useCount, 1, 'loading the skill is a use')
    assert.equal(record.successCount, 1)
    assert.equal(record.observedOutcomes.success, 1)
    assert.equal(record.lastOutcome.signal, 'observed:skill-used')
    assert.equal(record.status, 'candidate', 'one use is not yet enough')

    playTurn(host, { session: agent.session, turn: 2, toolCalls: [skillCall(skillName)] })
    assert.equal(record.successCount, 2)
    assert.equal(
      record.status,
      'verified',
      'two observed uses promote it — this is the promotion the plugin could not previously reach',
    )
    assert.ok(record.confidence > 0.5, 'confidence moved with the successes')
  } finally {
    cleanup(root)
  }
})

test('a promoted skill becomes loadable, which is the point of promoting it', async () => {
  const { root, host, agent } = boot({ promoteSuccesses: 2 })
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    const { record, skillName } = await learnSkill(host, agent)

    // Before: a candidate is not in the catalog, so the model cannot load it.
    const before = await host.listSkills({ cwd: agent.session.header.cwd })
    assert.equal(before.length, 0, 'a candidate is deliberately not in the catalog')

    playTurn(host, { session: agent.session, turn: 1, toolCalls: [skillCall(skillName)] })
    playTurn(host, { session: agent.session, turn: 2, toolCalls: [skillCall(skillName)] })
    assert.equal(record.status, 'verified')

    const after = await host.listSkills({ cwd: agent.session.header.cwd })
    assert.equal(after.length, 1, 'the verified skill is now advertised to the model')
    assert.equal(after[0].name, skillName)
  } finally {
    cleanup(root)
  }
})

test('a turn that ended in error counts against the skill it loaded', async () => {
  const { root, host, agent } = boot()
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    const { record, skillName } = await learnSkill(host, agent)
    const confidence = record.confidence

    playTurn(host, {
      session: agent.session,
      turn: 1,
      toolCalls: [skillCall(skillName)],
      endReason: 'error',
    })
    assert.equal(record.failureCount, 1)
    assert.equal(record.observedOutcomes.failure, 1)
    assert.equal(record.lastOutcome.signal, 'observed:skill-failed')
    assert.ok(record.confidence < confidence, 'a failed turn lowers confidence')
    assert.equal(record.status, 'candidate')
  } finally {
    cleanup(root)
  }
})

test('a cancelled or truncated turn blames nothing and credits nothing', async () => {
  for (const endReason of ['aborted', 'interrupted', 'blocked', 'max-tokens']) {
    const { root, host, agent } = boot()
    try {
      host.emit('agent/session-start', { agent, source: 'startup' })
      const { record, skillName } = await learnSkill(host, agent)
      const confidence = record.confidence

      playTurn(host, { session: agent.session, turn: 1, toolCalls: [skillCall(skillName)], endReason })
      assert.equal(record.useCount, 0, `${endReason} must not credit a use`)
      assert.equal(record.failureCount, 0, `${endReason} must not blame the record`)
      assert.equal(record.confidence, confidence)
      assert.equal(record.observedOutcomes, undefined)
    } finally {
      cleanup(root)
    }
  }
})

test('a skill that fails to load is reported, never credited', async () => {
  const { root, host, logger, runtime, agent } = boot()
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    const { record, skillName } = await learnSkill(host, agent)

    // The failure shape `dsh-tool-skill` produces for a name the catalog lacks.
    playTurn(host, {
      session: agent.session,
      turn: 1,
      toolCalls: [skillCall(skillName, 'UNKNOWN')],
    })
    assert.equal(record.useCount, 0, 'a skill that never loaded was never used')
    runtime.outcomes.flushCounters()
    assert.equal(runtime.store.readState().observedLoadFailures, 1)
    assert.match(logger.text(), /offered but could not be loaded/)
  } finally {
    cleanup(root)
  }
})

test('a skill the user invokes by name also counts as an observed use', async () => {
  const { root, host, agent } = boot()
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    const { record, skillName } = await learnSkill(host, agent)

    host.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 }, seq: 0, time: Date.now() })
    playSkillGesture(host, { session: agent.session, turn: 1, skillName })
    host.emit('session/event', agent.session, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
      seq: 0,
      time: Date.now(),
    })
    assert.equal(record.useCount, 1)
    assert.equal(record.successCount, 1)
    assert.equal(record.lastOutcome.signal, 'observed:skill-used')
  } finally {
    cleanup(root)
  }
})

test('surfacing a record is counted but never scored', async () => {
  const { root, host, runtime, agent } = boot()
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    const { record } = await learnSkill(host, agent)
    const confidence = record.confidence

    // Three turns that receive the injected block and complete cleanly. If
    // "the turn finished" were treated as success, this would promote the
    // record — and 41 of 43 closed turns in a measured session finished, so it
    // would promote essentially everything.
    for (const turn of [1, 3, 5]) {
      runtime.outcomes.noteInjection(String(agent.session.id), turn, [record.id])
      playTurn(host, { session: agent.session, turn })
    }
    assert.equal(record.surfacedCount, 3, 'surfacing is counted for the operator')
    assert.equal(record.useCount, 0)
    assert.equal(record.successCount, 0)
    assert.equal(record.confidence, confidence, 'exposure is not evidence of use')
    assert.equal(record.status, 'candidate')
    runtime.outcomes.flushCounters()
    assert.equal(runtime.store.readState().observedSurfaced, 3)
  } finally {
    cleanup(root)
  }
})

test('a turn is settled once, and only its own records are attributed', async () => {
  const { root, host, runtime, agent } = boot()
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    const { record } = await learnSkill(host, agent)
    const sessionId = String(agent.session.id)

    runtime.outcomes.noteInjection(sessionId, 1, [record.id, 'exp-does-not-exist'])
    playTurn(host, { session: agent.session, turn: 1 })
    // A replayed turn/end must not double count.
    host.emit('session/event', agent.session, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
      seq: 0,
      time: Date.now(),
    })
    assert.equal(record.surfacedCount, 1)

    // A foreign skill (the file provider's, not ours) attributes to nothing.
    playTurn(host, { session: agent.session, turn: 2, toolCalls: [skillCall('codex-deepseek-image')] })
    assert.equal(record.useCount, 0)
    assert.equal(record.surfacedCount, 1, 'turn 2 surfaced nothing')
  } finally {
    cleanup(root)
  }
})

test('observed attribution can be switched off without touching the rest', async () => {
  const { root, host, runtime, agent } = boot({ observeOutcomes: false })
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    const { record, skillName } = await learnSkill(host, agent)
    playTurn(host, { session: agent.session, turn: 1, toolCalls: [skillCall(skillName)] })
    playTurn(host, { session: agent.session, turn: 2, toolCalls: [skillCall(skillName)] })
    assert.equal(record.useCount, 0)
    assert.equal(record.status, 'candidate')
    assert.equal(runtime.config.observeOutcomes, false)
  } finally {
    cleanup(root)
  }
})

test('the injected block only calls a skill loadable when it actually is', async () => {
  const ask = 'The service keeps restarting, can you find out why and fix it?'

  // Default exposure: a brand new candidate is NOT in the catalog, so the block
  // must not claim the model can load it. A measured real session had this line
  // offering five learned skills that a `skill` call would have refused.
  const candidateRun = boot()
  try {
    const { host, agent } = candidateRun
    host.emit('agent/session-start', { agent, source: 'startup' })
    const { skillName } = await learnSkill(host, agent)
    const decision = await host.preStep({ agent, turn: 2, step: 1, messages: [userMessage(ask)] })
    const text = decision.messages.at(-1).content[0].text
    assert.ok(text.includes('<experience_loop_context>'), 'the record is still injected as advice')
    assert.ok(
      !/Matching learned skills are loadable/.test(text),
      'it must not promise a load the catalog will refuse',
    )
    assert.match(text, /cannot be loaded yet/)
    assert.ok(text.includes(skillName))
  } finally {
    cleanup(candidateRun.root)
  }

  const exposedRun = boot({ exposeSkills: 'all' })
  try {
    const { host, agent } = exposedRun
    host.emit('agent/session-start', { agent, source: 'startup' })
    const { skillName } = await learnSkill(host, agent)
    const decision = await host.preStep({ agent, turn: 2, step: 1, messages: [userMessage(ask)] })
    const text = decision.messages.at(-1).content[0].text
    assert.match(text, /Matching learned skills are loadable with the skill tool/)
    assert.ok(text.includes(skillName))
  } finally {
    cleanup(exposedRun.root)
  }
})

test('an explicitly named candidate loads even though the catalog hides it', async () => {
  const { root, host, agent } = boot()
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    const { record, skillName } = await learnSkill(host, agent)

    // The model's route goes through list(), which excludes it...
    const listed = await host.listSkills({ cwd: agent.session.header.cwd })
    assert.equal(listed.length, 0)

    // ...but the human's `/skill-name` gesture calls the provider directly, and
    // that is the only channel by which a candidate can be exercised at all.
    const loaded = await host.getSkill({ name: skillName, locator: { id: record.id } })
    assert.ok(loaded !== undefined, 'an explicitly named candidate is loadable')
    assert.match(loaded.content, /Status: \*\*candidate\*\*/, 'and it says what it is')

    // A deprecated record is neither listed nor loadable by name.
    record.status = 'deprecated'
    assert.equal(await host.getSkill({ name: skillName, locator: { id: record.id } }), undefined)
  } finally {
    cleanup(root)
  }
})
