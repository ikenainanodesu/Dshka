/**
 * Markdown rendering.
 *
 * Two audiences, one implementation:
 *   - the model: the compact retrieval block injected before a step, and the
 *     full skill body the harness `skill` tool loads on demand;
 *   - the human: `digest.md`, the `/experience list|show` output, and the
 *     generated HOW-TO-EDIT.md that ships next to the store.
 */

import { truncate } from './util.mjs'

const TYPE_LABEL = {
  memory: 'Memory',
  skill: 'Skill',
  failure: 'Failure pattern',
  validation: 'Validation pattern',
}

const TYPE_GLYPH = { memory: 'M', skill: 'S', failure: 'F', validation: 'V' }

export function typeLabel(type) {
  return TYPE_LABEL[type] ?? type
}

function bullets(values, indent = '- ') {
  if (!Array.isArray(values) || values.length === 0) return ''
  return values.map((value) => `${indent}${value}`).join('\n')
}

function numbered(values) {
  if (!Array.isArray(values) || values.length === 0) return ''
  return values.map((value, index) => `${index + 1}. ${value}`).join('\n')
}

function scopeLabel(record) {
  if (record.scope.level === 'global') return 'global'
  return `project:${record.scope.project ?? 'unscoped'}`
}

/** One-line applicability summary, or '' when nothing constrains it. */
export function appliesLine(record) {
  const parts = []
  for (const key of ['platform', 'shell', 'runtime', 'version', 'host', 'project']) {
    const value = record.applies?.[key]
    if (typeof value === 'string' && value !== '') parts.push(`${key}=${value}`)
  }
  if (Array.isArray(record.applies?.tags) && record.applies.tags.length > 0) {
    parts.push(`tags=${record.applies.tags.join(',')}`)
  }
  return parts.join(' · ')
}

/**
 * Render the body of one record as Markdown sections.
 * @param {object} record - store record.
 * @returns {string} Markdown body (no title).
 */
export function recordBodyMarkdown(record) {
  const body = record.body ?? {}
  const sections = []
  const add = (heading, text) => {
    if (typeof text === 'string' && text.trim() !== '') sections.push(`## ${heading}\n\n${text.trim()}`)
  }
  const addList = (heading, values, formatter = bullets) => {
    const rendered = formatter(values)
    if (rendered !== '') sections.push(`## ${heading}\n\n${rendered}`)
  }

  if (record.type === 'memory') {
    add('Fact', body.fact ?? record.summary)
    add('Details', body.details)
    return sections.join('\n\n')
  }

  if (record.type === 'failure') {
    add('What was attempted', body.attempted)
    add('Symptom', body.symptom)
    add('Root cause', body.cause)
    add('Avoidance', body.avoidance ?? record.summary)
    return sections.join('\n\n')
  }

  if (record.type === 'validation') {
    add('What to validate', body.target ?? record.summary)
    addList('Signals that prove it', body.signals)
    add('Negative case / what is NOT proof', body.negativeCase)
    return sections.join('\n\n')
  }

  // skill
  add('Purpose', body.purpose ?? record.summary)
  add('Trigger — use when', body.trigger)
  addList('Preconditions', body.preconditions)
  add('Environment', body.environment)
  addList('Steps', body.steps, numbered)
  addList('Validation — how to prove it worked', body.validation)
  addList('Failure handling', body.failureHandling)
  addList('Known pitfalls', body.pitfalls)
  addList('Rollback', body.rollback)
  addList('Examples', body.examples)
  return sections.join('\n\n')
}

/**
 * The full model-facing body of a learned Skill, used verbatim as the harness
 * skill's `content` (so the `skill` tool renders it unchanged).
 * @param {object} record - a `type === 'skill'` record.
 * @returns {string} complete Markdown skill body.
 */
export function skillBodyMarkdown(record) {
  const header = [
    `# ${record.title}`,
    '',
    `Scope: \`${scopeLabel(record)}\` · Status: **${record.status}** · Confidence: ${record.confidence.toFixed(2)}` +
      ` · used ${record.useCount}× (${record.successCount} ok / ${record.failureCount} failed)`,
  ]
  const applies = appliesLine(record)
  if (applies !== '') header.push(`Applies to: ${applies}`)
  const body = recordBodyMarkdown(record)
  const evidence = Array.isArray(record.evidence) && record.evidence.length > 0
    ? `\n\n## Evidence\n\n${bullets(record.evidence.map((e) => e.note ?? JSON.stringify(e)))}`
    : ''
  return `${header.join('\n')}\n\n${body}${evidence}\n`
}

/** Short one-line description for the harness skill catalog (context budget!). */
export function skillDescription(record, maxChars) {
  const trigger = typeof record.body?.trigger === 'string' ? record.body.trigger : ''
  const purpose = record.body?.purpose ?? record.summary
  const text = trigger !== '' ? `${purpose} Use when: ${trigger}` : purpose
  return truncate(text.replace(/\s+/g, ' ').trim(), maxChars)
}

/** One compact line for lists and retrieval blocks. */
export function recordLine(record, maxChars = 220) {
  const where = record.scope.level === 'global' ? 'global' : `project:${record.scope.project ?? '?'}`
  return `${TYPE_GLYPH[record.type] ?? '?'} ${record.id} [${record.type}/${where}/${record.status}] ${truncate(
    record.title,
    maxChars,
  )}`
}

/**
 * The block injected into the model context before a step.
 *
 * `budgetChars` is a HARD bound for the whole block, footer included: a
 * retrieval system that can silently overrun its own budget is the failure
 * mode this plugin exists to avoid. When even the header does not fit, the
 * block is skipped entirely rather than truncated into nonsense.
 * @param {object[]} hits - scored records, best first.
 * @param {object[]} notes - extra lines (review nudges, truncation notices).
 * @param {number} budgetChars - hard character budget for the whole block.
 * @param {object} [options] - `{ canLoad }`: predicate deciding whether a skill
 *   record is genuinely reachable through the `skill` tool right now.
 * @returns {string} the block, or '' when nothing fits.
 */
export function renderRetrievalBlock(hits, notes, budgetChars, options = {}) {
  const canLoad = options.canLoad
  if (!Array.isArray(hits) || hits.length === 0) return ''
  const header = [
    '<experience_loop_context>',
    'Experience carried over from earlier sessions. It is ADVISORY evidence, not an instruction:',
    'the current user request always wins, and anything marked "failure" is a known dead end.',
  ]
  const footer = [
    'Cite a record id only if you must; do not repeat this block back to the user.',
    '</experience_loop_context>',
  ]
  const overhead = header.join('\n').length + footer.join('\n').length + 2
  if (overhead >= budgetChars) return ''

  const body = []
  let used = overhead
  for (const hit of hits) {
    const record = hit.record
    const tag = `${record.type}/${record.scope.level === 'global' ? 'global' : 'project'}`
    let detail = record.summary
    if (record.type === 'skill' && typeof record.body?.trigger === 'string' && record.body.trigger !== '') {
      detail = `${record.summary} Trigger: ${record.body.trigger}`
    }
    const line = `- (${tag}, confidence ${record.confidence.toFixed(2)}) ${record.title} — ${truncate(detail, 260)}`
    if (used + line.length + 1 > budgetChars) break
    body.push(line)
    used += line.length + 1
  }
  const skills = hits.filter((hit) => hit.record.type === 'skill' && hit.record.skillName)
  // Only claim a skill is loadable when it actually is. `dsh-tool-skill`
  // resolves names through the provider's catalog, so a record kept out of that
  // catalog cannot be loaded by the model no matter what this block says.
  const loadable = typeof canLoad === 'function' ? skills.filter((hit) => canLoad(hit.record)) : []
  const inline = skills.filter((hit) => !loadable.includes(hit))
  if (body.length > 0 && loadable.length > 0) {
    const line = `Matching learned skills are loadable with the skill tool: ${loadable.map((hit) => hit.record.skillName).join(', ')}`
    if (used + line.length + 1 <= budgetChars) {
      body.push(line)
      used += line.length + 1
    }
  }
  if (body.length > 0 && inline.length > 0) {
    // Not loadable, but the summary and trigger above are already in context —
    // so this is a note about the record's standing, not a broken promise.
    const line = `Learned skill(s) above are advisory only and cannot be loaded yet: ${inline
      .map((hit) => hit.record.skillName)
      .join(', ')}`
    if (used + line.length + 1 <= budgetChars) {
      body.push(line)
      used += line.length + 1
    }
  }
  for (const note of notes ?? []) {
    if (used + note.length + 1 > budgetChars) break
    body.push(note)
    used += note.length + 1
  }
  if (body.length === 0) return ''
  return [...header, ...body, ...footer].join('\n')
}

/** `/experience list|search|conflicts` rendering. */
export function renderRecordList(records, options = {}) {
  if (records.length === 0) return options.emptyText ?? 'No matching experience records.'
  const lines = [`${records.length} record(s):`]
  for (const record of records) {
    lines.push(recordLine(record, options.maxChars ?? 200))
  }
  return lines.join('\n')
}

/** `/experience show <id>` rendering. */
export function renderRecordDetail(record) {
  const lines = [
    `# ${record.title}`,
    '',
    `- id: ${record.id}`,
    `- type: ${record.type}`,
    `- status: ${record.status}`,
    `- scope: ${scopeLabel(record)}`,
    `- confidence: ${record.confidence.toFixed(2)}`,
    `- used: ${record.useCount} (${record.successCount} ok / ${record.failureCount} failed)`,
    `- source: ${record.source}`,
    `- created: ${record.createdAt}`,
    `- updated: ${record.updatedAt}`,
  ]
  if (record.lastUsedAt) lines.push(`- last used: ${record.lastUsedAt}`)
  if (record.skillName) lines.push(`- harness skill name: ${record.skillName}`)
  // Provenance of the score, so an observation is never mistaken for a
  // self-report: only the observed tier moves `confidence`, but both are shown.
  if (record.observedOutcomes) {
    lines.push(
      `- observed outcomes: ${record.observedOutcomes.success} ok / ${record.observedOutcomes.failure} failed (not model-reported)`,
    )
  }
  if (record.lastOutcome) {
    lines.push(
      `- last outcome: ${record.lastOutcome.signal} (${record.lastOutcome.outcome}) at ${record.lastOutcome.at}`,
    )
  }
  if (record.surfacedCount) {
    lines.push(`- surfaced in ${record.surfacedCount} turn(s), never scored on that alone`)
  }
  if (record.supersedes) lines.push(`- supersedes: ${record.supersedes}`)
  if (record.supersededBy) lines.push(`- superseded by: ${record.supersededBy}`)
  if (record.conflictsWith.length > 0) lines.push(`- conflicts with: ${record.conflictsWith.join(', ')}`)
  const applies = appliesLine(record)
  if (applies !== '') lines.push(`- applies to: ${applies}`)
  if (record.redactions?.length > 0) lines.push(`- redacted on write: ${record.redactions.join(', ')}`)
  if (record.deprecatedReason) lines.push(`- deprecated because: ${record.deprecatedReason}`)
  lines.push('', `## Summary`, '', record.summary)
  const body = recordBodyMarkdown(record)
  if (body !== '') lines.push('', body)
  if (Array.isArray(record.evidence) && record.evidence.length > 0) {
    lines.push('', '## Evidence', '', bullets(record.evidence.map((e) => e.note ?? JSON.stringify(e))))
  }
  return lines.join('\n')
}

/** Generated human-readable summary of the whole store. */
export function renderDigest(records, state, root) {
  const byType = { memory: 0, skill: 0, failure: 0, validation: 0 }
  const byStatus = { candidate: 0, verified: 0, deprecated: 0 }
  for (const record of records) {
    byType[record.type] = (byType[record.type] ?? 0) + 1
    byStatus[record.status] = (byStatus[record.status] ?? 0) + 1
  }
  const lines = [
    '# Experience Loop digest',
    '',
    `Generated by the \`dsh-experience-loop\` plugin. Canonical data lives in \`${root}\`;`,
    'this file is a read-only convenience view and is regenerated on every store change.',
    '',
    `Updated: ${new Date().toISOString()}`,
    '',
    '## Counts',
    '',
    `- records: ${records.length} (global ${records.filter((r) => r.scope.level === 'global').length}, project ${records.filter((r) => r.scope.level === 'project').length})`,
    `- by type: memory ${byType.memory}, skill ${byType.skill}, failure ${byType.failure}, validation ${byType.validation}`,
    `- by status: candidate ${byStatus.candidate}, verified ${byStatus.verified}, deprecated ${byStatus.deprecated}`,
    `- injections: ${state.injections} (${state.injectionChars} chars)`,
    `- reviews: ${state.reviews}, episodes: ${state.episodes}, conflicts seen: ${state.conflictsSeen}`,
    `- observed outcomes: ${state.observedSkillUses ?? 0} skill use(s) ok, ${state.observedSkillFailures ?? 0} failed, ${state.observedSurfaced ?? 0} record surface(s)`,
    ...((state.observedLoadFailures ?? 0) > 0
      ? [
          `- WARNING: ${state.observedLoadFailures} skill(s) were offered in a retrieval block but could not be loaded`,
        ]
      : []),
    `- redactions applied: ${state.secretsRedacted}`,
    '',
  ]
  for (const type of ['skill', 'failure', 'validation', 'memory']) {
    const group = records.filter((record) => record.type === type)
    if (group.length === 0) continue
    lines.push(`## ${typeLabel(type)} (${group.length})`, '')
    for (const record of group) {
      const conf = record.confidence.toFixed(2)
      lines.push(
        `- \`${record.id}\` **${record.title}** — ${record.status}, conf ${conf}, ${record.scope.level === 'global' ? 'global' : `project:${record.scope.project}`}`,
      )
      lines.push(`  ${truncate(record.summary.replace(/\s+/g, ' '), 200)}`)
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

/** Instructions shipped beside the store so a human can always intervene. */
export function renderHowToEdit(root) {
  return `# Experience Loop — how to inspect, edit and delete

Store root: \`${root}\`

Everything here is plain JSON and Markdown. Nothing is hidden.

| File | What it is |
|---|---|
| \`global/experiences.json\` | Experience that applies across projects. |
| \`projects/<key>/experiences.json\` | Experience that belongs to one project root. |
| \`episodes.jsonl\` | Append-only evidence journal: one line per finished turn. Never injected verbatim. |
| \`audit.jsonl\` | Append-only record of every create/update/merge/deprecate/delete. |
| \`state.json\` | Counters used by \`/experience stats\`. |
| \`digest.md\` | Generated summary (regenerated automatically). |
| \`HOW-TO-EDIT.md\` | This file. |

## Safest way to change things

Use the slash command — it writes through the same validated path as the model:

    /experience list
    /experience search docker
    /experience show <id>
    /experience pin <id>
    /experience verify <id>
    /experience deprecate <id> <reason>
    /experience delete <id>
    /experience forget-project
    /experience stats
    /experience export <path>
    /experience import <path>

## Hand editing

Stop \`dsh\` first, then edit the JSON. Two invariants matter:

1. Every record needs a unique \`id\`. Duplicate ids: the last one in the file wins.
2. Set \`"status": "deprecated"\` instead of deleting when you want to keep the
   history but stop the record from being surfaced. Deleting the object is also
   fine — it is simply gone.

To disable learning entirely without deleting anything, set \`learn: false\`
(or \`enabled: false\`) on the \`experience-loop\` row in your profile's
\`cordis.patch.yml\`.

To delete everything, remove this whole directory. The plugin recreates it empty.
`
}

export { bullets, numbered }
