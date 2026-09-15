/**
 * Offline smoke demo of the whole loop — no dsh, no model, no network.
 *
 * Prints the actual artefacts the plugin produces so the behaviour can be
 * judged directly: the journal line, the stored record, the exact text that
 * would be injected before the second attempt, the harness skill the model
 * would load, and the measured repeat-task metric.
 *
 *   node tools/smoke.mjs [--keep]
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../index.mjs'
import { createFakeHost, makeAgent, makeTempStoreRoot, playTurn, userMessage } from '../test/harness.mjs'

const keep = process.argv.includes('--keep')
const rule = (title) => `\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`

const root = makeTempStoreRoot('smoke')
const { ctx, host } = createFakeHost()
apply(ctx, { storeRoot: root })
const runtime = host.provided.get('experienceLoop')
const agent = makeAgent()
const ASK = 'The docker service on this box keeps restarting, find out why and fix it'

const line = (label, value) => console.log(`${label.padEnd(26)} ${value}`)

console.log(rule('1. FIRST TIME — nothing known yet'))
host.emit('agent/session-start', { agent, source: 'startup' })
line('records in store', runtime.store.all(runtime.store.lastProjectKey).length)
const first = await host.preStep({ agent, turn: 1, step: 1, messages: [userMessage(ASK)] })
// The batch INCLUDING the caller's own message, so 1 means "nothing was added".
line('messages in batch (1 = nothing injected)', first.messages.length)

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
  assistantText: 'Restarted the container; the health endpoint now returns 200.',
})

console.log(rule('2. DETERMINISTIC EVIDENCE — one journal line per finished turn'))
const episode = runtime.store.recentEpisodes(1)[0]
console.log(
  JSON.stringify(
    {
      toolCallCount: episode.toolCallCount,
      distinctTools: episode.distinctTools,
      failedTools: episode.failedTools,
      recovered: episode.recovered,
      verificationCount: episode.verificationCount,
      reviewedAt: episode.reviewedAt,
      ask: episode.ask,
    },
    null,
    2,
  ),
)

console.log(rule('3. REVIEW — the model distils it (this is the only write path)'))
const reviewed = await host.runTool(
  'experience_review',
  {
    experiences: [
      {
        type: 'skill',
        title: 'Docker service recovery',
        summary: 'Recover a Docker service that will not stay up, then prove it is healthy.',
        scope: 'project',
        tags: ['docker', 'healthcheck'],
        body: {
          purpose: 'Recover a docker service that will not stay running',
          trigger: 'a container exits or restarts repeatedly',
          steps: ['check container state', 'read the last 100 log lines', 'check host port conflicts', 'restart the service'],
          validation: ['docker healthcheck reports healthy', 'the API returns the expected payload', 'a real business request succeeds'],
          pitfalls: ['docker restart exits 0 while the app is still broken'],
        },
      },
      {
        type: 'failure',
        title: 'docker restart is not proof of health',
        summary: 'exit code 0 from docker restart only means the command ran; the app can still be broken.',
        scope: 'global',
        body: {
          attempted: 'docker restart app',
          symptom: 'exit 0 but the API returned 502',
          cause: 'the app crashed again after the restart',
          avoidance: 'always follow a restart with a health and API check',
        },
      },
    ],
  },
  { agent },
)
console.log(reviewed.text)
for (const ref of reviewed.value.created) {
  const record = runtime.store.find(ref.id)
  console.log(`  stored: ${record.id}  skillName=${record.skillName ?? '-'}  status=${record.status}  scope=${record.scope.level}`)
}

console.log(rule('4. HARNESS SKILL CATALOG — a candidate is deliberately NOT advertised'))
console.log(`before promotion: ${(await host.listSkills({ cwd: agent.session.header.cwd })).length} exposed skill(s)`)
await host.runTool(
  'experience_review',
  { experiences: [], outcomes: reviewed.value.created.map((ref) => ({ id: ref.id, outcome: 'success' })) },
  { agent },
)
await host.runTool(
  'experience_review',
  { experiences: [], outcomes: reviewed.value.created.map((ref) => ({ id: ref.id, outcome: 'success' })) },
  { agent },
)
const catalog = await host.listSkills({ cwd: agent.session.header.cwd })
console.log(`after two successful uses: ${catalog.length} exposed skill(s)`)
for (const candidate of catalog) console.log(`  - ${candidate.name}: ${candidate.description}`)
if (catalog[0]) {
  const loaded = await host.getSkill(catalog[0])
  console.log('\n  (the body the `skill` tool would return, first 12 lines)')
  console.log(
    loaded.content
      .split('\n')
      .slice(0, 12)
      .map((text) => `  | ${text}`)
      .join('\n'),
  )
}

console.log(rule('5. SECOND TIME — retrieval, hard-bounded'))
const second = await host.preStep({ agent, turn: 6, step: 1, messages: [userMessage(ASK)] })
console.log(`messages now: ${second.messages.length} (ask + one context message)`)
const injected = second.messages[1]
console.log(`\nsource: ${JSON.stringify(injected.source)}`)
console.log(`chars:  ${injected.content[0].text.length} (budget 1800)\n`)
console.log(
  injected.content[0].text
    .split('\n')
    .map((text) => `  | ${text}`)
    .join('\n'),
)

console.log(rule('6. ENVIRONMENT GATE — a Linux lesson is invisible on win32'))
await host.runTool(
  'experience_review',
  {
    experiences: [
      {
        type: 'skill',
        title: 'Linux systemd unit recovery',
        summary: 'Recover a failed systemd unit.',
        scope: 'global',
        applies: { platform: 'linux', shell: 'bash' },
        body: { purpose: 'Recover a systemd unit', trigger: 'a unit is failed', steps: ['systemctl status'] },
      },
    ],
  },
  { agent },
)
const gated = await host.preStep({ agent, turn: 12, step: 1, messages: [userMessage(ASK)] })
const gateText = gated.messages[1]?.content[0].text ?? ''
console.log(`injected on win32: ${gateText.length} chars`)
console.log(`mentions the Linux skill: ${gateText.includes('Linux systemd')}`)
console.log(`mentions the Windows-relevant material: ${gateText.includes('Docker service recovery') || gateText.includes('docker restart')}`)

console.log(rule('7. OBSERVABILITY'))
console.log((await host.runCommand('experience', 'stats', agent)).text)
console.log(`\n--- /experience metric ---\n${(await host.runCommand('experience', 'metric', agent)).text}`)

console.log(rule('8. ON DISK (human-readable, hand-editable, deletable)'))
const walk = (dir, depth = 0) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    console.log(`${'  '.repeat(depth)}${entry.isDirectory() ? '[dir] ' : '      '}${entry.name}`)
    if (entry.isDirectory()) walk(full, depth + 1)
  }
}
walk(root)
const globalDoc = JSON.parse(readFileSync(join(root, 'global', 'experiences.json'), 'utf8'))
console.log('\n--- global/experiences.json (records[0]) ---')
console.log(JSON.stringify(globalDoc.records[0], null, 2).split('\n').slice(0, 24).join('\n'))
console.log(`\nstore root: ${root}`)
console.log(keep ? 'kept for inspection' : 'delete this directory to erase everything the plugin knows')
if (!keep) {
  const { rmSync } = await import('node:fs')
  rmSync(root, { recursive: true, force: true })
}
