/**
 * The learning loop: deterministic evidence capture and review application.
 *
 * Two distinct things live here, and the split is the safety property:
 *
 *  1. `EpisodeRecorder` is DETERMINISTIC. It watches the session event stream
 *     and writes one redacted episode per finished turn — raw evidence, never
 *     injected verbatim, never promoted to an Experience by itself. This is why
 *     a chatty or failed turn cannot pollute the experience base on its own.
 *
 *  2. `applyReview` is MODEL-DRIVEN. Only a distilled payload — produced by the
 *     agent through the `experience_review` tool, or by the human through
 *     `/experience` — becomes a Memory, Skill, Failure pattern or Validation
 *     pattern. It is also the single place where dedupe, conflict detection and
 *     the lifecycle transitions happen.
 */

import { cleanField, redactText } from './redact.mjs'
import { makeRecord, BODY_FIELDS } from './store.mjs'
import {
  CONFLICT_SIMILARITY,
  MERGE_SIMILARITY,
  closestMatch,
  mergeRecord,
  stampKeywords,
} from './rank.mjs'
import { clamp, kebabFrom, newId, nowIso, truncate, uniqueStrings } from './util.mjs'

// ── episode recording ────────────────────────────────────────────────────────

const CORRECTION_MARKERS = [
  '不对', '错了', '不是', '应该是', '不该', '重来', '重新', '纠正', '你搞错',
  'wrong', "that's not", 'that is not', 'incorrect', 'actually', 'no,', 'instead', 'should be', "don't", 'do not',
]

const VERIFICATION_MARKERS = [
  'test', 'verify', 'check', 'health', 'healthcheck', 'curl', 'invoke-webrequest', 'invoke-restmethod',
  'status', 'ps ', 'docker ps', 'systemctl status', 'pytest', 'assert', 'validat', 'smoke',
]

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function looksLikeVerification(name, argsText) {
  const haystack = `${name} ${argsText ?? ''}`.toLowerCase()
  if (!/pwsh|bash|shell|terminal/.test(name.toLowerCase())) return false
  return VERIFICATION_MARKERS.some((marker) => haystack.includes(marker))
}

function looksLikeCorrection(text) {
  const lowered = String(text ?? '').toLowerCase()
  return CORRECTION_MARKERS.some((marker) => lowered.includes(marker))
}

/**
 * Deterministic per-turn evidence collector. One instance per plugin, keyed by
 * session id then turn, so a multi-session process never mixes journals.
 */
export class EpisodeRecorder {
  /**
   * @param {object} options - `{ config, logger, onEpisode, takeRecordLinks, takeQuery }`.
   *   `takeRecordLinks(sessionId)` returns (and consumes) the ids of records
   *   distilled during the session's current turn, so the evidence line can
   *   point back at them.
   *   `takeQuery(sessionId)` returns (and consumes) the RESOLVED request for
   *   that turn — for a short reply, the question it answered plus the reply.
   *   The raw words stay in `ask`; the resolved form is what makes a one-letter
   *   answer identifiable as a task.
   */
  constructor({ config, logger, onEpisode, takeRecordLinks, takeQuery }) {
    this.config = config
    this.logger = logger
    this.onEpisode = onEpisode
    this.takeRecordLinks = takeRecordLinks
    this.takeQuery = takeQuery
    /** @type {Map<string, Map<number, object>>} */
    this.turns = new Map()
    /**
     * The turn each session currently has open.
     *
     * `user/message` is the ONE message-producing event whose payload is the
     * bare message — it carries no `turn` — so the ask text cannot be routed by
     * reading the payload. Tracking the open turn from `turn/start` is the only
     * correct source: without it every request is journalled against a phantom
     * turn 0 and the evidence line records an empty ask.
     * @type {Map<string, number>}
     */
    this.currentTurn = new Map()
  }

  turnState(session, turn) {
    const sessionId = String(session.id)
    let byTurn = this.turns.get(sessionId)
    if (!byTurn) {
      byTurn = new Map()
      this.turns.set(sessionId, byTurn)
    }
    let state = byTurn.get(turn)
    if (!state) {
      state = {
        turn,
        sessionId,
        cwd: session.header?.cwd,
        startedAt: nowIso(),
        ask: '',
        asks: 0,
        tools: [],
        pending: new Map(),
        failures: [],
        verifications: [],
        assistantText: '',
        userCorrected: false,
      }
      byTurn.set(turn, state)
      // Bound the map: a very long session must not grow without limit.
      if (byTurn.size > 24) {
        const oldest = [...byTurn.keys()].sort((a, b) => a - b)[0]
        if (oldest !== turn) byTurn.delete(oldest)
      }
    }
    return state
  }

  /** Observe one session event. Never throws into the harness event bus. */
  observe(session, event) {
    try {
      if (!this.config.captureEpisodes) return
      const type = event?.type
      const sessionId = String(session.id)
      if (type === 'turn/start') {
        this.currentTurn.set(sessionId, event.data.turn)
        this.turnState(session, event.data.turn)
        return
      }
      if (type === 'turn/end') {
        this.finish(session, event.data.turn)
        return
      }
      // `user/message` omits `turn`; every other message event carries it.
      const turn = Number.isFinite(event.data?.turn) ? event.data.turn : this.currentTurn.get(sessionId)
      if (!Number.isFinite(turn)) return
      const state = this.turnState(session, turn)
      if (type === 'user/message') {
        const source = event.data.source
        if (source?.kind !== 'user') return
        const text = textOfContent(event.data.content)
        if (text.trim() === '') return
        state.asks += 1
        if (state.ask === '') state.ask = text
        else if (looksLikeCorrection(text)) state.userCorrected = true
        return
      }
      if (type === 'tool/call') {
        state.pending.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments })
        return
      }
      if (type === 'tool/result') {
        const callId = event.data.message?.source?.callId
        const pending = callId ? state.pending.get(callId) : undefined
        if (callId) state.pending.delete(callId)
        const name = pending?.name ?? 'unknown'
        const isError = event.data.message?.content?.[0]?.isError === true
        state.tools.push({ name, ok: !isError })
        if (isError) {
          state.failures.push({ name, at: state.tools.length })
        } else if (looksLikeVerification(name, pending?.arguments)) {
          state.verifications.push(name)
        }
        return
      }
      if (type === 'assistant/message') {
        state.assistantText += textOfContent(event.data.message?.content)
      }
    } catch (error) {
      this.logger?.warn?.('experience-loop: episode observe failed: %s', error?.message ?? error)
    }
  }

  /** Close one turn and hand the episode to the store. */
  finish(session, turn) {
    const sessionId = String(session.id)
    if (this.currentTurn.get(sessionId) === turn) this.currentTurn.delete(sessionId)
    const byTurn = this.turns.get(sessionId)
    const state = byTurn?.get(turn)
    if (!state) return undefined
    byTurn.delete(turn)
    if (byTurn.size === 0) this.turns.delete(sessionId)

    // A turn with no request and no tool work carries no evidence worth a line.
    if (state.asks === 0 && state.tools.length === 0) return undefined

    const ask = cleanField(state.ask, this.config.episodeAskChars)
    const recovered = state.failures.length > 0
      && state.tools.some((tool, index) => tool.ok && index > (state.failures[0]?.at ?? 0))
    // A review almost always happens DURING the turn it reviews, so the episode
    // for that turn does not exist yet at review time. The link is therefore
    // completed here, when the turn finally closes, instead of being lost.
    let linked = []
    try {
      linked = this.takeRecordLinks?.(sessionId) ?? []
    } catch (error) {
      this.logger?.warn?.('experience-loop: record linkage failed: %s', error?.message ?? error)
    }
    let resolvedQuery = ''
    try {
      resolvedQuery = this.takeQuery?.(sessionId) ?? ''
    } catch (error) {
      this.logger?.warn?.('experience-loop: query resolution failed: %s', error?.message ?? error)
    }
    const episode = {
      id: newId('ep'),
      sessionId,
      turn,
      cwd: state.cwd,
      startedAt: state.startedAt,
      endedAt: nowIso(),
      ask: ask.text,
      // Original length, so a reader can tell a whole request from a truncated
      // one. Long delegated prompts get cut at `episodeAskChars`, and their
      // retained prefix is usually shared boilerplate — comparing such turns as
      // "the same task" produced a false pair that looked like a regression.
      askChars: state.ask.length,
      askTruncated: state.ask.length > this.config.episodeAskChars,
      // The request as RETRIEVAL saw it: unchanged for a normal request, or
      // "preceding assistant turn + reply" when the user answered a question
      // with something as short as a single letter.
      askContext: resolvedQuery === '' ? undefined : truncate(resolvedQuery, 1200),
      askRedactions: ask.hits,
      extraAsks: Math.max(0, state.asks - 1),
      toolCallCount: state.tools.length,
      distinctTools: uniqueStrings(state.tools.map((tool) => tool.name), 20),
      failedTools: uniqueStrings(state.failures.map((failure) => failure.name), 20),
      recovered,
      userCorrected: state.userCorrected,
      verificationCount: state.verifications.length,
      assistantChars: state.assistantText.length,
      reviewedAt: linked.length > 0 ? nowIso() : null,
      recordIds: linked,
    }
    try {
      this.onEpisode?.(episode)
    } catch (error) {
      this.logger?.warn?.('experience-loop: episode persist failed: %s', error?.message ?? error)
    }
    return episode
  }

  forget(sessionId) {
    this.turns.delete(String(sessionId))
    this.currentTurn.delete(String(sessionId))
  }
}

// ── review application ───────────────────────────────────────────────────────

function redactBody(type, body) {
  const raw = body && typeof body === 'object' ? body : {}
  const out = {}
  const hits = []
  let rejected = false
  for (const field of BODY_FIELDS[type] ?? []) {
    const value = raw[field]
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      const list = []
      for (const item of value) {
        if (typeof item !== 'string') continue
        const cleaned = cleanField(item, 1200)
        if (cleaned.rejected) {
          rejected = true
          continue
        }
        hits.push(...cleaned.hits)
        if (cleaned.text.trim() !== '') list.push(cleaned.text.trim())
      }
      if (list.length > 0) out[field] = list
      continue
    }
    if (typeof value === 'string') {
      const cleaned = cleanField(value, 4000)
      if (cleaned.rejected) {
        rejected = true
        continue
      }
      hits.push(...cleaned.hits)
      if (cleaned.text.trim() !== '') out[field] = cleaned.text.trim()
    }
  }
  return { body: out, hits: [...new Set(hits)], rejected }
}

/** Allocate a stable, unique, kebab-case harness skill name for a record. */
function allocateSkillName(store, record, taken) {
  const base = kebabFrom(record.title, 40)
  const candidate = base.startsWith('exp-') ? base : `exp-${base}`
  let name = candidate
  let counter = 2
  const exists = (value) =>
    taken.has(value) || store.all(store.lastProjectKey).some((other) => other.id !== record.id && other.skillName === value)
  while (exists(name)) {
    name = `${candidate}-${counter}`
    counter++
  }
  taken.add(name)
  return name
}

function applyOutcome(record, outcome, config) {
  record.useCount = (record.useCount ?? 0) + 1
  record.lastUsedAt = nowIso()
  if (outcome === 'success') {
    record.successCount = (record.successCount ?? 0) + 1
    record.confidence = clamp(record.confidence + 0.08, 0.05, 0.95)
  } else {
    record.failureCount = (record.failureCount ?? 0) + 1
    record.confidence = clamp(record.confidence - 0.18, 0.05, 0.95)
  }
  record.updatedAt = nowIso()
  if (record.status === 'deprecated' && outcome === 'success') {
    // Demonstrated useful again; re-open it as a candidate rather than verified.
    record.status = 'candidate'
    record.deprecatedReason = null
  }
  if (record.status === 'candidate') {
    if (record.confidence >= config.promoteConfidence || record.successCount >= config.promoteSuccesses) {
      record.status = 'verified'
    }
  }
  if (
    config.autoDeprecate &&
    record.status !== 'deprecated' &&
    record.failureCount >= 2 &&
    record.confidence <= config.deprecateConfidence
  ) {
    record.status = 'deprecated'
    record.deprecatedReason = `auto: ${record.failureCount} recorded failures with confidence ${record.confidence.toFixed(2)}`
  }
  return record
}

/**
 * Apply one OBSERVED outcome — evidence the plugin saw on the session event
 * stream rather than a claim a model made about itself.
 *
 * It funnels into the same `applyOutcome` the model-reported path uses, so the
 * promotion gate and the auto-deprecation rule keep exactly one implementation.
 * What differs is only what gets recorded alongside: the signal that produced
 * it, so a human reading `experiences.json` can tell an observation from a
 * self-report instead of trusting both equally.
 *
 * @param {object} options - `{ store, record, outcome, signal, sessionId, turn, config }`.
 * @returns {{ status: string, confidence: number, promoted: boolean }}
 */
export function applyObservedOutcome({ store, record, outcome, signal, sessionId, turn, config }) {
  const before = { status: record.status, confidence: record.confidence }
  applyOutcome(record, outcome === 'failure' ? 'failure' : 'success', config)
  const counts = record.observedOutcomes ?? { success: 0, failure: 0 }
  if (outcome === 'failure') counts.failure += 1
  else counts.success += 1
  record.observedOutcomes = counts
  record.lastOutcome = { signal, outcome, at: nowIso(), sessionId, turn }
  store.put(record)
  store.audit({
    action: 'outcome',
    source: 'observed',
    signal,
    recordId: record.id,
    sessionId,
    turn,
    before,
    after: { status: record.status, confidence: record.confidence },
  })
  return {
    status: record.status,
    confidence: record.confidence,
    promoted: before.status !== 'verified' && record.status === 'verified',
  }
}

/**
 * Apply one review payload.
 * @param {object} options - `{ store, payload, context, config, logger }`.
 * @returns {object} a structured outcome report.
 */
export function applyReview({ store, payload, context, config, logger }) {
  const report = {
    created: [],
    updated: [],
    merged: [],
    superseded: [],
    conflicts: [],
    rejected: [],
    outcomesApplied: 0,
    redactions: 0,
    notes: [],
  }
  const entries = Array.isArray(payload?.experiences) ? payload.experiences : []
  const takenNames = new Set()
  const now = nowIso()

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      report.rejected.push({ title: '(unnamed)', reason: 'entry is not an object' })
      continue
    }
    const title = cleanField(entry.title, 160)
    const summary = cleanField(entry.summary, 1200)
    if (title.text.trim() === '' || summary.text.trim() === '') {
      report.rejected.push({ title: title.text || '(untitled)', reason: 'title and summary are both required' })
      continue
    }
    if (title.rejected || summary.rejected) {
      report.rejected.push({ title: title.text, reason: 'payload was almost entirely credentials' })
      report.redactions += title.hits.length + summary.hits.length
      continue
    }
    const bodyResult = redactBody(entry.type, entry.body)
    if (bodyResult.rejected && Object.keys(bodyResult.body).length === 0 && entry.type !== 'memory') {
      report.rejected.push({ title: title.text, reason: 'skill body was almost entirely credentials' })
      continue
    }

    const redactions = [...new Set([...title.hits, ...summary.hits, ...bodyResult.hits])]
    report.redactions += redactions.length

    let incoming = makeRecord(
      {
        type: entry.type,
        title: title.text.trim(),
        summary: summary.text.trim(),
        body: bodyResult.body,
        scope: entry.scope,
        confidence: typeof entry.confidence === 'number' ? clamp(entry.confidence, 0.05, 0.95) : 0.4,
        applies: { ...(entry.applies ?? {}), tags: uniqueStrings(entry.tags ?? entry.applies?.tags ?? [], 16) },
        evidence: [
          {
            kind: 'review',
            sessionId: context.sessionId,
            at: now,
            note: truncate(`reviewed in turn ${context.turn ?? '?'}`, 160),
          },
        ],
        source: context.source ?? 'agent',
        redactions,
      },
      {
        scope: entry.scope === 'global' || entry.scope === 'project' ? entry.scope : config.defaultScope,
        projectKey: context.projectKey,
        projectPath: context.projectPath,
        platform: context.platform,
        shell: context.shell,
        source: context.source ?? 'agent',
        now,
      },
    )
    stampKeywords(incoming)
    if (incoming.type === 'skill') incoming.skillName = allocateSkillName(store, incoming, takenNames)

    // ── explicit merge target ────────────────────────────────────────────────
    if (typeof entry.mergeInto === 'string' && entry.mergeInto !== '') {
      const target = store.resolve(entry.mergeInto)
      if (!target) {
        report.notes.push(`mergeInto "${entry.mergeInto}" not found; created a new record instead`)
      } else {
        const change = mergeRecord(target, incoming, { replaceLists: entry.replaceLists === true })
        store.put(target)
        store.audit({ action: 'merge', recordId: target.id, into: target.id, fields: change.added, source: incoming.id })
        report.merged.push({ id: target.id, type: target.type, title: target.title, scope: target.scope.level, fields: change.added.length })
        continue
      }
    }

    // ── explicit supersede ───────────────────────────────────────────────────
    if (typeof entry.supersedes === 'string' && entry.supersedes !== '') {
      const old = store.resolve(entry.supersedes)
      if (!old) {
        report.notes.push(`supersedes "${entry.supersedes}" not found; created a new record instead`)
      } else {
        old.status = 'deprecated'
        old.deprecatedReason = `superseded by ${incoming.id}`
        old.supersededBy = incoming.id
        old.updatedAt = now
        store.put(old)
        incoming.supersedes = old.id
        // Deliberately NOT linked via `conflictsWith`. A supersede is a
        // RESOLVED relationship and already recorded by `supersedes` /
        // `supersededBy`; marking it a conflict too filled `/experience
        // conflicts` with settled pairs until that view was useless. Reserve
        // `conflictsWith` for genuine unresolved disagreement.
        incoming.conflictsWith = []
        store.put(incoming)
        report.superseded.push({
          id: old.id,
          by: incoming.id,
          type: old.type,
          scope: old.scope.level,
          title: old.title,
        })
        report.created.push({ id: incoming.id, type: incoming.type, title: incoming.title, scope: incoming.scope.level })
        store.audit({
          action: 'supersede',
          oldRecord: { id: old.id, title: old.title },
          newRecord: { id: incoming.id, title: incoming.title },
          reason: entry.supersedeReason ?? 'model-declared supersede',
        })
        continue
      }
    }

    // ── automatic dedupe / conflict ──────────────────────────────────────────
    const visible = store
      .all(context.projectKey)
      .filter((record) => record.scope.level === incoming.scope.level)
    const { best, score, rivals } = closestMatch(visible, incoming)

    if (best && score >= MERGE_SIMILARITY) {
      const change = mergeRecord(best, incoming, { replaceLists: entry.replaceLists === true })
      store.put(best)
      store.audit({
        action: 'merge-auto',
        recordId: best.id,
        similarity: Number(score.toFixed(3)),
        fields: change.added,
        incomingTitle: incoming.title,
      })
      report.merged.push({
        id: best.id,
        type: best.type,
        title: best.title,
        scope: best.scope.level,
        fields: change.added.length,
        similarity: Number(score.toFixed(3)),
      })
      continue
    }

    if (best && score >= CONFLICT_SIMILARITY) {
      // A near-but-not-identical neighbour: keep BOTH, link them, and refuse to
      // let the new claim inherit trust it has not earned. Never silently
      // overwrite.
      incoming.status = incoming.confidence >= 0.85 ? 'candidate' : 'candidate'
      incoming.conflictsWith = [best.id, ...rivals.filter((r) => r.record.id !== best.id).map((r) => r.record.id)]
      best.conflictsWith = [...new Set([...(best.conflictsWith ?? []), incoming.id])]
      best.updatedAt = now
      store.put(best)
      store.put(incoming)
      const conflict = {
        newRecord: { id: incoming.id, title: incoming.title, summary: truncate(incoming.summary, 300) },
        oldRecord: { id: best.id, title: best.title, summary: truncate(best.summary, 300) },
        similarity: Number(score.toFixed(3)),
        reason: 'same type and scope with overlapping vocabulary but materially different content',
        environmentDifference: JSON.stringify({ old: best.applies, new: incoming.applies }),
        decision: 'both kept; new record held at status=candidate for human or outcome-based resolution',
      }
      store.audit({ action: 'conflict', ...conflict })
      report.conflicts.push({ id: incoming.id, with: best.id, title: incoming.title, similarity: conflict.similarity })
      report.created.push({ id: incoming.id, type: incoming.type, title: incoming.title, scope: incoming.scope.level })
      continue
    }

    store.put(incoming)
    store.audit({ action: 'create', recordId: incoming.id, type: incoming.type, title: incoming.title, scope: incoming.scope.level })
    report.created.push({ id: incoming.id, type: incoming.type, title: incoming.title, scope: incoming.scope.level })
  }

  // ── outcomes: the only path that moves confidence ──────────────────────────
  for (const outcome of Array.isArray(payload?.outcomes) ? payload.outcomes : []) {
    if (!outcome || typeof outcome.id !== 'string') continue
    const record = store.resolve(outcome.id)
    if (!record) {
      report.notes.push(`outcome for unknown record "${outcome.id}" ignored`)
      continue
    }
    const before = { status: record.status, confidence: record.confidence }
    applyOutcome(record, outcome.outcome === 'failure' ? 'failure' : 'success', config)
    store.put(record)
    store.audit({
      action: 'outcome',
      recordId: record.id,
      outcome: outcome.outcome,
      note: truncate(String(outcome.note ?? ''), 300),
      before,
      after: { status: record.status, confidence: record.confidence },
    })
    report.outcomesApplied += 1
    report.updated.push({
      id: record.id,
      type: record.type,
      title: record.title,
      scope: record.scope.level,
      status: record.status,
      confidence: Number(record.confidence.toFixed(2)),
    })
  }

  // ── link evidence episodes to what they produced ───────────────────────────
  const produced = [...report.created.map((item) => item.id), ...report.merged.map((item) => item.id)]
  if (Array.isArray(context.episodeIds) && context.episodeIds.length > 0 && produced.length > 0) {
    const linked = store.markEpisodesReviewed(context.episodeIds, produced)
    if (linked > 0) report.notes.push(`linked ${linked} episode(s) as evidence`)
  }

  const counters = {
    reviews: 1,
    recordsCreated: report.created.length,
    recordsMerged: report.merged.length,
    recordsRejected: report.rejected.length,
    conflictsSeen: report.conflicts.length,
    secretsRedacted: report.redactions,
    outcomesSuccess: (payload?.outcomes ?? []).filter((o) => o?.outcome === 'success').length,
    outcomesFailure: (payload?.outcomes ?? []).filter((o) => o?.outcome === 'failure').length,
  }
  store.bumpCounters(counters)
  logger?.info?.(
    'experience-loop: review -> created %d, merged %d, conflicts %d, rejected %d, outcomes %d',
    report.created.length,
    report.merged.length,
    report.conflicts.length,
    report.rejected.length,
    report.outcomesApplied,
  )
  return report
}

export { redactText }
