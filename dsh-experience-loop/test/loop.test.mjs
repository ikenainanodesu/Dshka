/**
 * End-to-end tests of the loop, driven through the plugin's real entry point
 * and a fake host. These are the scenarios the task names:
 *
 *   A first time solving a problem -> experience is distilled
 *   B second time              -> the skill is retrieved and reused
 *   C stale skill              -> refined in place, not forked
 *   D wrong environment        -> never offered
 *   E secrets                  -> never reach long-term storage
 *   F wrong experience         -> the human can view, edit, disable, delete it
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.mjs'
import { validateValue } from '../lib/validate.mjs'
import { SCHEMAS } from '../lib/surface.mjs'
import { cleanup, createFakeHost, makeAgent, makeTempStoreRoot, playTurn, userMessage } from './harness.mjs'

const DOCKER_SKILL = {
  type: 'skill',
  title: 'Docker service recovery',
  summary: 'Recover a Docker service that will not stay up, then prove it is healthy.',
  scope: 'project',
  confidence: 0.5,
  tags: ['docker', 'healthcheck', 'service'],
  body: {
    purpose: 'Recover a docker service that will not stay running',
    trigger: 'a container exits or restarts repeatedly',
    preconditions: ['the docker CLI is available', 'the compose file is known'],
    steps: [
      'check container state',
      'read the last 100 log lines',
      'check host port conflicts',
      'check dependency services',
      'restart the service',
    ],
    validation: [
      'docker healthcheck reports healthy',
      'the API returns the expected payload',
      'a real business request succeeds',
    ],
    failureHandling: ['if the port is taken, identify the owning process before retrying'],
    pitfalls: ['docker restart exits 0 while the app is still broken'],
    rollback: ['docker compose down && docker compose up -d'],
  },
}

/** Boot the plugin into a fake host with an isolated store. */
function boot(config = {}) {
  const root = makeTempStoreRoot('loop')
  const { ctx, host } = createFakeHost()
  apply(ctx, { storeRoot: root, ...config })
  const runtime = host.provided.get('experienceLoop')
  return { root, ctx, host, runtime, agent: makeAgent() }
}

const ASK = 'The docker service on this box keeps restarting, can you find out why and fix it?'

test('A: first time — nothing is injected, the turn is journalled, and a review distils a skill', async () => {
  const { root, host, runtime, agent } = boot()
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })

    assert.deepEqual(
      host.tools.size ? [...host.tools.keys()].sort() : [],
      ['experience_query', 'experience_review'],
    )
    assert.ok(host.commands.has('experience'))
    assert.equal(host.promptSections.length, 1)
    assert.ok(host.promptSections[0].text.includes('experience_review'))
    assert.ok(host.skillProvider, 'a skill provider is registered with the harness')

    // Turn 1: empty store, so nothing is injected even though the ask matches.
    const decision = await host.preStep({ agent, turn: 1, step: 1, messages: [userMessage(ASK)] })
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 1, 'an empty store injects nothing')

    // Explore, fail once, recover, verify. Every call is journalled.
    playTurn(host, {
      session: agent.session,
      turn: 1,
      ask: ASK,
      toolCalls: [
        { name: 'pwsh', arguments: '{"command":"docker ps -a"}' },
        { name: 'pwsh', arguments: '{"command":"docker restart app"}' },
        { name: 'pwsh', arguments: '{"command":"Invoke-WebRequest http://127.0.0.1:3080/health"}' },
      ],
      failures: 1,
      assistantText: 'Restarted the container and verified the health endpoint returns 200.',
    })

    const episodes = runtime.store.recentEpisodes(5)
    assert.equal(episodes.length, 1)
    assert.equal(episodes[0].toolCallCount, 3)
    assert.equal(episodes[0].failedTools.length, 1)
    assert.equal(episodes[0].recovered, true)
    assert.equal(episodes[0].verificationCount, 1)
    assert.equal(episodes[0].reviewedAt, null)
    // `user/message` carries no `turn`, so this specifically guards the recorder
    // routing the request to the open turn instead of a phantom turn 0.
    assert.equal(episodes[0].turn, 1)
    assert.equal(episodes[0].ask, ASK)

    // Distil.
    const reviewed = await host.runTool('experience_review', { experiences: [DOCKER_SKILL] }, { agent })
    assert.equal(reviewed.value.created.length, 1)
    assert.match(reviewed.text, /Created/)
    assert.equal(reviewed.value.rejected.length, 0)

    const record = runtime.store.find(reviewed.value.created[0].id)
    assert.equal(record.status, 'candidate')
    assert.match(record.skillName, /^exp-docker-service-recovery$/)
    assert.ok(runtime.store.recentEpisodes(5)[0].reviewedAt, 'the evidence episode was linked and closed')

    // A candidate IS advertised now, marked as unproven and given less room
    // than a verified skill's line. Hiding it would make promotion unreachable:
    // `dsh-tool-skill` only loads names the catalog contains, so a hidden
    // candidate can never be exercised and never earn its evidence.
    const advertised = await host.listSkills({ cwd: agent.session.header.cwd })
    assert.equal(advertised.length, 1)
    assert.match(advertised[0].description, /^\[candidate - unproven\] /)
    assert.ok(
      advertised[0].description.length <= 160,
      `a candidate's line stays inside candidateDescriptionChars (got ${advertised[0].description.length})`,
    )

    // Two successful uses promote it.
    await host.runTool(
      'experience_review',
      { experiences: [], outcomes: [{ id: record.id, outcome: 'success' }, { id: record.id, outcome: 'success' }] },
      { agent },
    )
    const promoted = runtime.store.find(record.id)
    assert.equal(promoted.status, 'verified')
    assert.ok(host.skillControl.invalidated > 0, 'the skill catalog was invalidated')

    const candidates = await host.listSkills({ cwd: agent.session.header.cwd })
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].name, promoted.skillName)
    assert.doesNotMatch(candidates[0].description, /\[candidate/, 'the marker is gone once it is proven')
    assert.ok(candidates[0].description.length <= 300)

    const loaded = await host.getSkill(candidates[0])
    assert.ok(loaded.content.includes('## Steps'))
    assert.ok(loaded.content.includes('## Validation — how to prove it worked'))
    assert.ok(loaded.content.includes('## Known pitfalls'))
    assert.ok(loaded.content.includes('## Rollback'))
  } finally {
    cleanup(root)
  }
})

test('B: second time — the skill is retrieved into context and the injection is bounded and idempotent', async () => {
  const { root, host, runtime, agent } = boot({ injectBudgetChars: 900 })
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    const created = await host.runTool(
      'experience_review',
      {
        experiences: [
          DOCKER_SKILL,
          {
            type: 'failure',
            title: 'docker restart is not proof of health',
            summary: 'exit code 0 from docker restart only means the command ran; the app can still be broken.',
            scope: 'global',
            body: { attempted: 'docker restart app', symptom: 'exit 0 but the API still returned 502', cause: 'the app crashed after restart', avoidance: 'always follow a restart with a health and API check' },
          },
        ],
      },
      { agent },
    )
    assert.equal(created.value.created.length, 2)

    const decision = await host.preStep({ agent, turn: 2, step: 1, messages: [userMessage(ASK)] })
    assert.equal(decision.messages.length, 2, 'exactly one context message is appended')
    const injected = decision.messages[1]
    assert.equal(injected.role, 'user')
    assert.equal(injected.source.kind, 'plugin')
    assert.equal(injected.source.plugin, 'experience-loop')
    assert.equal(injected.source.form, 'recall')
    assert.match(injected.content[0].text, /<experience_loop_context>/)
    assert.match(injected.content[0].text, /Docker service recovery/)
    assert.ok(injected.content[0].text.length <= 900, `budget respected (got ${injected.content[0].text.length})`)

    // The same turn is never injected twice.
    const again = await host.preStep({ agent, turn: 2, step: 1, messages: [userMessage(ASK)] })
    assert.equal(again.messages.length, 1)

    // Consecutive turns are inside the cooldown; a much later turn is not.
    const nextTurn = await host.preStep({ agent, turn: 3, step: 1, messages: [userMessage(ASK)] })
    assert.equal(nextTurn.messages.length, 1, 'cooldown suppresses a consecutive re-injection')
    const later = await host.preStep({ agent, turn: 8, step: 1, messages: [userMessage(ASK)] })
    assert.equal(later.messages.length, 2)
    assert.ok(runtime.store.readState().injections >= 2)
  } finally {
    cleanup(root)
  }
})

test('C: a stale skill is refined in place, and an explicit replacement retires it', async () => {
  const { root, host, runtime, agent } = boot()
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    const first = await host.runTool('experience_review', { experiences: [DOCKER_SKILL] }, { agent })
    const id = first.value.created[0].id

    // A later task discovers the order was wrong: check DNS earlier.
    const refined = await host.runTool(
      'experience_review',
      {
        experiences: [
          {
            ...DOCKER_SKILL,
            mergeInto: id,
            body: {
              ...DOCKER_SKILL.body,
              steps: ['check docker DNS resolution first', ...DOCKER_SKILL.body.steps],
              pitfalls: [...DOCKER_SKILL.body.pitfalls, 'the embedded DNS resolver fails before the app starts'],
            },
          },
        ],
      },
      { agent },
    )
    assert.equal(refined.value.merged.length, 1)
    assert.equal(refined.value.merged[0].id, id)
    assert.equal(refined.value.created.length, 0, 'no v2 duplicate was created')
    const record = runtime.store.find(id)
    assert.equal(record.version, 2)
    assert.equal(record.body.steps[0], 'check docker DNS resolution first')
    assert.equal(runtime.store.all(runtime.store.lastProjectKey).length, 1)

    // A replacement that genuinely supersedes it.
    const replaced = await host.runTool(
      'experience_review',
      {
        experiences: [
          {
            ...DOCKER_SKILL,
            title: 'Docker service recovery on the compose-less host',
            supersedes: id,
            supersedeReason: 'compose was removed from this machine',
          },
        ],
      },
      { agent },
    )
    assert.equal(replaced.value.superseded.length, 1)
    assert.equal(runtime.store.find(id).status, 'deprecated')
    assert.equal(runtime.store.find(replaced.value.created[0].id).supersedes, id)
  } finally {
    cleanup(root)
  }
})

test('D: an experience from another environment is never offered', async () => {
  const { root, host, runtime, agent } = boot()
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    await host.runTool(
      'experience_review',
      {
        experiences: [
          {
            type: 'skill',
            title: 'Linux systemd service recovery',
            summary: 'Recover a failing systemd unit and prove it is active.',
            scope: 'global',
            applies: { platform: 'linux', shell: 'bash' },
            body: { purpose: 'Recover a systemd unit', trigger: 'a unit is in a failed state', steps: ['systemctl status', 'journalctl -xe'] },
          },
          {
            type: 'skill',
            title: 'Windows service recovery',
            summary: 'Recover a failing Windows service and prove it is running.',
            scope: 'global',
            applies: { platform: 'win32', shell: 'pwsh' },
            body: { purpose: 'Recover a Windows service', trigger: 'a service stops unexpectedly', steps: ['Get-Service', 'Restart-Service'] },
          },
        ],
      },
      { agent },
    )
    const decision = await host.preStep({
      agent,
      turn: 1,
      step: 1,
      messages: [userMessage('the service keeps stopping on this machine, please recover it')],
    })
    assert.equal(decision.messages.length, 2)
    const text = decision.messages[1].content[0].text
    assert.match(text, /Windows service recovery/)
    assert.ok(!text.includes('Linux systemd'), 'the Linux skill must not be offered on win32')

    // Subagent sessions are skipped by default so the parent's context is not paid for twice.
    const sub = makeAgent({ sessionId: 'session-sub', origin: 'subagent' })
    const subDecision = await host.preStep({
      agent: sub,
      turn: 1,
      step: 1,
      messages: [userMessage('the service keeps stopping on this machine, please recover it')],
    })
    assert.equal(subDecision.messages.length, 1)
    assert.ok(runtime.store.readState().injections >= 1)
  } finally {
    cleanup(root)
  }
})

test('E: no credential reaches long-term storage', async () => {
  const { root, host, runtime, agent } = boot()
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    playTurn(host, {
      session: agent.session,
      turn: 1,
      ask: 'deploy with the token sk-abcdefghijklmnopqrstuvwxyz012345 and password=hunter2secret',
      toolCalls: [{ name: 'pwsh', arguments: '{"command":"echo $env:API_TOKEN=abcdef1234567890"}' }],
    })

    const result = await host.runTool(
      'experience_review',
      {
        experiences: [
          { type: 'memory', title: 'API key is sk-abcdefghijklmnopqrstuvwxyz012345', summary: 'password=hunter2secret' },
          {
            type: 'failure',
            title: 'Exporting a key in the interactive shell shadows the repo .env',
            summary: 'Setting DEEPSEEK_API_KEY=sk-abcdefghijklmnopqrstuv in the shell hid the repo .env value from the process.',
            body: { attempted: 'export DEEPSEEK_API_KEY=sk-abcdefghijklmnopqrstuv', avoidance: 'load the repo .env instead of exporting keys' },
          },
        ],
      },
      { agent },
    )
    assert.equal(result.value.rejected.length, 1)
    assert.equal(result.value.created.length, 1)
    assert.ok(result.value.redactions >= 1)

    // The whole store directory must be free of the raw secrets.
    const files = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else files.push(full)
      }
    }
    walk(root)
    assert.ok(files.length >= 3)
    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      assert.ok(!content.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), `${file} leaked a token`)
      assert.ok(!content.includes('hunter2secret'), `${file} leaked a password`)
      assert.ok(!content.includes('abcdef1234567890'), `${file} leaked an env secret`)
    }

    const redactReport = await host.runCommand('experience', 'redact sk-abcdefghijklmnopqrstuvwxyz012345', agent)
    assert.match(redactReport.text, /«redacted:/)
    assert.equal(redactReport.kind, 'success')
  } finally {
    cleanup(root)
  }
})

test('F: a human can list, inspect, pin, verify, deprecate, export/import and delete', async () => {
  const { root, host, runtime, agent } = boot()
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    // Write a deliberately WRONG record to prove it can be found and removed.
    const created = await host.runTool(
      'experience_review',
      {
        experiences: [
          {
            type: 'memory',
            title: 'This project deploys with npm',
            summary: 'Run npm ci and npm run deploy.',
            scope: 'project',
          },
        ],
      },
      { agent },
    )
    const id = created.value.created[0].id
    runtime.store.flush()

    assert.match((await host.runCommand('experience', 'list', agent)).text, new RegExp(id))
    assert.match((await host.runCommand('experience', `show ${id}`, agent)).text, /This project deploys with npm/)
    assert.match((await host.runCommand('experience', 'search npm', agent)).text, /npm/)
    assert.match((await host.runCommand('experience', 'stats', agent)).text, /Records: 1/)
    assert.match((await host.runCommand('experience', 'pending', agent)).text, /unreviewed|No unreviewed/)
    assert.match((await host.runCommand('experience', 'metric', agent)).text, /repeated|Repeated|Not enough/)
    assert.match((await host.runCommand('experience', 'conflicts', agent)).text, /No unresolved conflicting|unresolved conflict/)
    assert.match((await host.runCommand('experience', 'help', agent)).text, /\/experience — inspect/)

    // Pin.
    await host.runCommand('experience', `pin ${id}`, agent)
    assert.equal(runtime.store.find(id).pinned, true)
    await host.runCommand('experience', `unpin ${id}`, agent)
    assert.equal(runtime.store.find(id).pinned, false)

    // Correct the record: a human knows better.
    await host.runCommand('experience', `verify ${id}`, agent)
    assert.equal(runtime.store.find(id).status, 'verified')

    // Export / import round trip.
    const exportPath = join(root, 'export.json')
    assert.match((await host.runCommand('experience', `export ${exportPath}`, agent)).text, /Exported 1 record/)
    const bundle = JSON.parse(readFileSync(exportPath, 'utf8'))
    assert.equal(bundle.records.length, 1)
    assert.match((await host.runCommand('experience', `import ${exportPath}`, agent)).text, /skipped: duplicates|Imported 0/)

    // Disable it without deleting anything.
    await host.runCommand('experience', 'off', agent)
    assert.equal(runtime.enabled, false)
    const blocked = await host.runTool('experience_review', { experiences: [DOCKER_SKILL] }, { agent })
    assert.equal(blocked.value.created.length, 0)
    assert.match(blocked.text, /disabled/i)
    await host.runCommand('experience', 'on', agent)
    assert.equal(runtime.enabled, true)

    // Deprecate, then delete.
    assert.match((await host.runCommand('experience', `deprecate ${id} wrong package manager`, agent)).text, /Deprecated/)
    assert.equal(runtime.store.find(id).status, 'deprecated')
    assert.equal(runtime.store.find(id).deprecatedReason, 'wrong package manager')
    assert.match((await host.runCommand('experience', `delete ${id}`, agent)).text, /Deleted/)
    assert.equal(runtime.store.find(id), undefined)
    assert.equal(runtime.store.all(runtime.store.lastProjectKey).length, 0)

    const auditActions = runtime.store.recentAudit(20).map((entry) => entry.action)
    for (const action of ['create', 'pin', 'unpin', 'status', 'deprecate', 'delete', 'export']) {
      assert.ok(auditActions.includes(action), `audit must record ${action}`)
    }
  } finally {
    cleanup(root)
  }
})

test('a review run DURING a turn still links that turn as its evidence', async () => {
  // Regression: the episode for a turn is written at turn end, but a review
  // almost always runs inside the turn it reviews — so linking only at review
  // time silently produced evidence-less records.
  const { root, host, runtime, agent } = boot()
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    const session = agent.session
    host.emit('session/event', session, { type: 'turn/start', data: { turn: 4 }, seq: 0, time: Date.now() })
    host.emit('session/event', session, {
      type: 'user/message',
      data: userMessage(ASK),
      seq: 0,
      time: Date.now(),
    })
    host.emit('session/event', session, {
      type: 'tool/call',
      data: { turn: 4, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"docker ps"}' },
      seq: 0,
      time: Date.now(),
    })
    host.emit('session/event', session, {
      type: 'tool/result',
      data: { turn: 4, step: 1, message: { content: [{ type: 'tool_result', callId: 'c1', isError: false }], source: { kind: 'tool', callId: 'c1' } } },
      seq: 0,
      time: Date.now(),
    })

    // Review happens mid-turn, before turn/end.
    const reviewed = await host.runTool('experience_review', { experiences: [DOCKER_SKILL] }, { agent })
    assert.equal(reviewed.value.created.length, 1)
    assert.equal(runtime.store.recentEpisodes(5).length, 0, 'the turn has not closed yet')

    host.emit('session/event', session, { type: 'turn/end', data: { turn: 4, reason: 'stop' }, seq: 0, time: Date.now() })
    const episode = runtime.store.recentEpisodes(5)[0]
    assert.equal(episode.turn, 4)
    assert.equal(episode.ask, ASK)
    assert.equal(episode.toolCallCount, 1)
    assert.ok(episode.reviewedAt, 'the episode is closed as reviewed as soon as the turn ends')
    assert.deepEqual(episode.recordIds, [reviewed.value.created[0].id])
  } finally {
    cleanup(root)
  }
})

test('a relayed subagent task counts as the ask when subagent retrieval is on', async () => {
  // Regression: a subagent's assignment arrives as source {kind:'agent-message',
  // form:'relay'} (dsh-subagent's createAgentMessage), not {kind:'user'}, so
  // extractAsk found nothing and subagent retrieval could never fire.
  const { root, host, runtime } = boot({ injectSubagents: true })
  try {
    const parent = makeAgent({ sessionId: 'session-parent' })
    host.emit('agent/session-start', { agent: parent, source: 'startup' })
    await host.runTool('experience_review', { experiences: [DOCKER_SKILL] }, { agent: parent })

    const child = makeAgent({ sessionId: 'session-child', origin: 'subagent' })
    const relayed = {
      id: 'relay-1',
      role: 'user',
      content: [{ type: 'text', text: `Agent ${parent.session.id} sent a message: ${ASK}` }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: parent.session.id },
    }
    const decision = await host.preStep({ agent: child, turn: 1, step: 1, messages: [relayed] })
    assert.equal(decision.messages.length, 2, 'the relayed task must drive retrieval')
    assert.match(decision.messages[1].content[0].text, /<experience_loop_context>/)
    assert.match(decision.messages[1].content[0].text, /Docker service recovery/)

    // Our OWN injected block must never become the next query.
    const injected = decision.messages[1]
    const second = await host.preStep({ agent: child, turn: 9, step: 1, messages: [injected] })
    assert.equal(second.messages.length, 1, 'a recall block alone is not a request')

    // A catalog/snapshot snapshot is context, not a request either.
    const catalog = {
      id: 'cat-1',
      role: 'user',
      content: [{ type: 'text', text: ASK }],
      source: { kind: 'plugin', plugin: 'dsh-tool-skill', form: 'catalog' },
    }
    const third = await host.preStep({ agent: child, turn: 10, step: 1, messages: [catalog] })
    assert.equal(third.messages.length, 1)
    assert.ok(runtime.store.readState().injections >= 1)
  } finally {
    cleanup(root)
  }
})

test('every review outcome path returns a value its own schema accepts', async () => {
  // Regression: the `superseded` array pushed {id, by, title} while the output
  // schema declared it as a full record reference, so the HOST rejected the
  // tool result ("returned invalid output") even though the write had landed.
  // A schema is only correct if the runtime value passes it — so every path is
  // validated here through the real tool call.
  const { root, host, runtime, agent } = boot()
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    const check = (label, value) => {
      const violations = validateValue(SCHEMAS.REVIEW_OUTPUT, value, '', [])
      assert.deepEqual(violations, [], `${label} produced an invalid value: ${violations.join('; ')}`)
    }

    const created = await host.runTool('experience_review', { experiences: [DOCKER_SKILL] }, { agent })
    check('create', created.value)
    const id = created.value.created[0].id

    const merged = await host.runTool(
      'experience_review',
      { experiences: [{ ...DOCKER_SKILL, mergeInto: id, body: { ...DOCKER_SKILL.body, steps: [...DOCKER_SKILL.body.steps, 'check DNS first'] } }] },
      { agent },
    )
    check('merge', merged.value)

    const conflictish = await host.runTool(
      'experience_review',
      {
        experiences: [
          {
            type: 'memory',
            title: 'Docker port conflict recovery find owner',
            summary: 'Find the process that owns the port and stop it, then restart the service.',
            scope: 'global',
          },
          {
            type: 'memory',
            title: 'Docker port conflict recovery find owner',
            summary:
              'Find the process that owns the port, then rebuild the image, redeploy the compose stack and change the exposed port.',
            scope: 'global',
          },
        ],
      },
      { agent },
    )
    check('create + conflict', conflictish.value)

    const superseded = await host.runTool(
      'experience_review',
      { experiences: [{ ...DOCKER_SKILL, title: 'Docker recovery, compose-less host', supersedes: id }] },
      { agent },
    )
    check('supersede', superseded.value)
    assert.equal(superseded.value.superseded.length, 1)
    assert.equal(superseded.value.superseded[0].by, superseded.value.created[0].id)
    // Regression: `superseded` items lacked `scope`, so the model-facing line
    // rendered as `[failure/undefined]`. Only the rendered text reveals that.
    assert.equal(superseded.value.superseded[0].scope, 'project')
    assert.match(superseded.text, /Superseded:/)
    assert.ok(!superseded.text.includes('undefined'), `supersede rendering leaked undefined: ${superseded.text}`)
    // A supersede is a RESOLVED relationship: it must not also be flagged as an
    // unresolved conflict, or `/experience conflicts` fills with settled pairs.
    assert.deepEqual(
      runtime.store.find(superseded.value.created[0].id).conflictsWith,
      [],
      'a superseding record must not be flagged as conflicting with the record it replaced',
    )

    const withOutcome = await host.runTool(
      'experience_review',
      { experiences: [], outcomes: [{ id: superseded.value.created[0].id, outcome: 'success' }, { id: 'exp_missing', outcome: 'failure' }] },
      { agent },
    )
    check('outcome', withOutcome.value)
    assert.ok(withOutcome.value.notes.some((note) => note.includes('exp_missing')))
    assert.equal(runtime.store.find('exp_missing'), undefined)

    const rejected = await host.runTool(
      'experience_review',
      { experiences: [{ type: 'memory', title: 'sk-abcdefghijklmnopqrstuvwxyz012345', summary: 'password=hunter2secret' }] },
      { agent },
    )
    check('all-rejected', rejected.value)
    assert.equal(rejected.value.rejected.length, 1)
  } finally {
    cleanup(root)
  }
})

test('a one-letter answer to a posed question is still a request', async () => {
  // Regression: short replies were dropped as "not a substantive request", so
  // the turns where a stored lesson matters most — the user picking an option —
  // got no retrieval at all. A reply's meaning lives in the question it answers.
  const { root, host, runtime, agent } = boot()
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    await host.runTool('experience_review', { experiences: [DOCKER_SKILL] }, { agent })

    // The agent finishes a turn by offering a choice.
    playTurn(host, {
      session: agent.session,
      turn: 1,
      ask: 'the docker service is down again, what should we do?',
      toolCalls: [{ name: 'pwsh', arguments: '{"command":"docker ps -a"}' }],
      assistantText:
        'Which option do you want? A) restart the container. B) read the docker logs. C) check the host port conflict, then restart the service and verify the healthcheck.',
    })

    const decision = await host.preStep({ agent, turn: 2, step: 1, messages: [userMessage('C')] })
    assert.equal(decision.messages.length, 2, 'the single-letter answer must still retrieve')
    const block = decision.messages[1]?.content?.[0]?.text ?? ''
    assert.match(block, /<experience_loop_context>/)
    assert.match(block, /Docker service recovery/, 'the QUESTION vocabulary is what matches')

    // With nothing to resolve against, a bare letter really is unusable.
    const fresh = makeAgent({ sessionId: 'session-without-context' })
    host.emit('agent/session-start', { agent: fresh, source: 'startup' })
    const none = await host.preStep({ agent: fresh, turn: 1, step: 1, messages: [userMessage('C')] })
    assert.equal(none.messages.length, 1)
    // …and the resolved request is what the journal records as the turn's subject.
    host.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 2 }, seq: 0, time: Date.now() })
    host.emit('session/event', agent.session, { type: 'user/message', data: userMessage('C'), seq: 0, time: Date.now() })
    host.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 2, reason: 'stop' }, seq: 0, time: Date.now() })
    const episode = runtime.store.recentEpisodes(5).find((entry) => entry.turn === 2)
    assert.ok(episode, 'the reply turn must be journalled')
    assert.equal(episode.ask, 'C', 'the raw words are stored unchanged')
    assert.match(episode.askContext ?? '', /port conflict/, 'the resolved context must be journalled too')
  } finally {
    cleanup(root)
  }
})

test('a posed choice gives a one-letter reply an exact referent', async () => {
  // The referent, not a threshold, is what makes "C" resolvable. With the option
  // set known the reply is a LOOKUP; without it the same letter is a guess.
  const { root, host, runtime, agent } = boot()
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    await host.runTool('experience_review', { experiences: [DOCKER_SKILL] }, { agent })

    // Control: the same letter with no posed question and no prior turn.
    const fresh = makeAgent({ sessionId: 'session-no-slate' })
    host.emit('agent/session-start', { agent: fresh, source: 'startup' })
    const bare = await host.preStep({ agent: fresh, turn: 1, step: 1, messages: [userMessage('C')] })
    assert.equal(bare.messages.length, 1, 'without a referent a bare letter must find nothing')

    // The agent poses a choice. The user answers in the chat instead of through
    // the question UI, so the answerer reports no selection — but the option set
    // is recorded all the same.
    const returned = await host.askUserQuestion(
      {
        agent,
        questions: [
          {
            id: 'q1',
            question: 'The docker service is down again — which approach?',
            options: [
              { label: 'A) restart the container' },
              { label: 'B) read the docker logs first' },
              { label: 'C) check the host port conflict, then restart the service and verify the healthcheck' },
            ],
          },
        ],
      },
      { answers: [] },
    )
    assert.deepEqual(returned, { answers: [] }, 'the observer must delegate the answer unchanged')

    const decision = await host.preStep({ agent, turn: 2, step: 1, messages: [userMessage('C')] })
    assert.equal(decision.messages.length, 2, 'the letter must resolve against the option set')
    assert.match(decision.messages[1].content[0].text, /Docker service recovery/)

    // Close the turn so the journal shows WHAT the letter was taken to mean.
    host.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 2 }, seq: 0, time: Date.now() })
    host.emit('session/event', agent.session, { type: 'user/message', data: userMessage('C'), seq: 0, time: Date.now() })
    host.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 2, reason: 'stop' }, seq: 0, time: Date.now() })
    const episode = runtime.store.recentEpisodes(5).find((entry) => entry.turn === 2)
    assert.equal(episode.ask, 'C')
    assert.match(episode.askContext ?? '', /port conflict/, 'the canonical option is what got resolved')
  } finally {
    cleanup(root)
  }
})

test('the query tool answers every action with schema-valid output', async () => {
  const { root, host, runtime, agent } = boot()
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    await host.runTool('experience_review', { experiences: [DOCKER_SKILL] }, { agent })
    for (const action of ['list', 'search', 'show', 'stats', 'conflicts', 'pending', 'deprecated', 'projects', 'metric', 'audit']) {
      const result = await host.runTool(
        'experience_query',
        { action, query: 'docker', id: runtime.store.all(runtime.store.lastProjectKey)[0].id },
        { agent },
      )
      const violations = validateValue(SCHEMAS.QUERY_OUTPUT, result.value, '', [])
      assert.deepEqual(violations, [], `action ${action} produced an invalid value: ${violations.join('; ')}`)
      assert.equal(typeof result.text, 'string')
      assert.ok(result.text.length > 0, `action ${action} produced no model-facing text`)
    }
    const reviewViolations = validateValue(
      SCHEMAS.REVIEW_OUTPUT,
      (await host.runTool('experience_review', { experiences: [DOCKER_SKILL] }, { agent })).value,
      '',
      [],
    )
    assert.deepEqual(reviewViolations, [])
  } finally {
    cleanup(root)
  }
})

test('invalid tool arguments are reported, never thrown', async () => {
  const { root, host, agent } = boot()
  try {
    await assert.rejects(
      () => host.runTool('experience_review', { experiences: 'not-an-array' }, { agent }),
      /experience_review/,
    )
    const bad = await host.runTool('experience_query', { action: 'nonsense' }, { agent })
    assert.equal(bad.value.count, 0)
    assert.match(bad.text, /invalid arguments/)
    const structured = validateValue(SCHEMAS.QUERY_OUTPUT, bad.value, '', [])
    assert.deepEqual(structured, [])
  } finally {
    cleanup(root)
  }
})

test('the conflicts view lists only UNRESOLVED disagreement', async () => {
  // Regression: every historical supersede/conflict left a permanent entry in
  // this view, so it reported five settled pairs and hid any real conflict.
  const { root, host, runtime, agent } = boot()
  try {
    host.emit('agent/session-start', { agent, source: 'startup' })
    const pair = [
      {
        type: 'memory',
        title: 'Docker port conflict recovery find owner',
        summary: 'Find the process that owns the port and stop it, then restart the service.',
        scope: 'global',
      },
      {
        type: 'memory',
        title: 'Docker port conflict recovery find owner',
        summary:
          'Find the process that owns the port, then rebuild the image, redeploy the compose stack and change the exposed port.',
        scope: 'global',
      },
    ]
    const created = await host.runTool('experience_review', { experiences: pair }, { agent })
    const [first, second] = created.value.created.map((item) => item.id)
    assert.equal(created.value.conflicts.length, 1, 'the fixture must produce a conflict')

    const open = runtime.query({ action: 'conflicts' }, agent)
    assert.equal(open.count, 2, 'both sides of an unresolved conflict are listed')
    assert.match(open.text, /unresolved conflict/)
    // `stats` must use the SAME definition: two numbers for one word is worse
    // than either number alone, and that is exactly what shipped first.
    assert.match(runtime.query({ action: 'stats' }, agent).text, /conflicting 2/)

    // Retiring one side settles the disagreement in practice: it can no longer
    // be retrieved, so it must leave the view.
    runtime.commandDeprecate(first, 'resolved by human review')
    const after = runtime.query({ action: 'conflicts' }, agent)
    assert.equal(after.count, 0, `a deprecated partner must not keep the conflict open: ${after.text}`)
    assert.match(after.text, /No unresolved conflicting records/)
    assert.match(runtime.query({ action: 'stats' }, agent).text, /conflicting 0/)

    // …while the record itself survives, merely retired.
    assert.equal(runtime.store.find(first).status, 'deprecated')
    assert.equal(runtime.store.find(second).status, 'candidate')
  } finally {
    cleanup(root)
  }
})
