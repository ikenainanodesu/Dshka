/**
 * Observed outcome attribution — the part of the loop that does not need the
 * model to volunteer anything.
 *
 * Reviews may omit explicit outcomes. This module attributes loaded skills
 * using turn-end events so lifecycle updates can also use observed signals.
 * Completion/error is a heuristic, not proof of skill efficacy or causation.
 *
 * What makes this module different from the model-reported path is the SOURCE
 * of the evidence: these are facts the plugin already sees on `session/event`,
 * so they cost no model call and no context:
 *
 *   OBSERVED USE (moves confidence, can promote)
 *     The record's skill was actually LOADED, by either route the harness has:
 *       - the model called the `skill` tool with this record's skillName and
 *         that call did not fail (`dsh-tool-skill` executes the tool), or
 *       - a human typed `/skillName`, which `dsh-tool-skill` resolves through
 *         the provider directly and injects as a `skill-invocation` message.
 *     Loading is a deliberate act naming one record. It is the strongest
 *     signal available without asking a model to grade itself.
 *
 *   OBSERVED OUTCOME
 *     ...and the turn that loaded it ended `completed` (success) or `error`
 *     (failure). `aborted`, `interrupted`, `blocked` and `max-tokens` are
 *     attributed to nothing: a user hitting stop, a crashed process or a
 *     truncated answer is not evidence about a record.
 *
 *   SURFACED (recorded, deliberately NOT scored)
 *     The record appeared in an injected retrieval block. This is NOT evidence
 *     of use, so turn completion must not promote a merely surfaced record.
 *     The counter helps identify records that surface without being loaded.
 *
 * A record can therefore still reach `verified` automatically, but only by
 * being genuinely picked up and surviving the turn. Nothing here writes an
 * Experience, invents a lesson, or changes what retrieval returns.
 */

import { nowIso, truncate } from './util.mjs'

/** Provenance labels written onto the record and into the audit journal. */
export const OBSERVED = {
  skillUsed: 'observed:skill-used',
  skillFailed: 'observed:skill-failed',
  surfaced: 'observed:surfaced',
}

/** Turn-end kinds that say something about the record that was loaded. */
const SUCCESS_REASONS = new Set(['completed'])
const FAILURE_REASONS = new Set(['error'])

/** Cap on tracked in-flight turns and skill calls, so a long session cannot grow without bound. */
const MAX_TURNS = 256
const MAX_CALLS = 256

/** Parse the raw `arguments` JSON string of a `tool/call` without ever throwing. */
function parseToolArguments(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Attribute observed outcomes to existing records.
 *
 * This class never decides what `verified` means. It hands one observed
 * outcome at a time to the injected `apply` callback, which is the same
 * `applyOutcome` the model-reported path uses — so there is still exactly one
 * place in the codebase that can promote a record.
 */
export class OutcomeLedger {
  /**
   * @param {object} options - `{ config, store, logger, apply }`.
   *   `apply({ record, outcome, signal, sessionId, turn })` mutates and persists.
   */
  constructor({ config, store, logger, apply }) {
    this.config = config
    this.store = store
    this.logger = logger
    this.apply = apply
    /**
     * In-flight turns we have something to say about, keyed `sessionId:turn`.
     * @type {Map<string, {sessionId: string, turn: number, injected: Set<string>, loads: object[]}>}
     */
    this.turns = new Map()
    /**
     * A `skill` tool call awaiting its result, keyed by callId.
     * @type {Map<string, {sessionId: string, turn: number, skillName: string}>}
     */
    this.calls = new Map()
    /**
     * Turn currently open per session. `user/message` omits `turn` in the
     * durable schema, so the only way to attribute a `/skill` gesture is to
     * remember the turn `turn/start` opened.
     * @type {Map<string, number>}
     */
    this.currentTurn = new Map()
    /** Cumulative counters, mirrored into state.json. */
    this.counters = { skillUses: 0, skillFailures: 0, surfaced: 0, loadFailures: 0, unattributed: 0 }
  }

  /** Whether observed attribution runs at all. */
  get enabled() {
    return this.config.observeOutcomes === true
  }

  entry(sessionId, turn) {
    const key = `${sessionId}:${turn}`
    let entry = this.turns.get(key)
    if (entry === undefined) {
      entry = { sessionId, turn, injected: new Set(), loads: [] }
      this.turns.set(key, entry)
      if (this.turns.size > MAX_TURNS) this.turns.delete(this.turns.keys().next().value)
    }
    return entry
  }

  /**
   * Remember which records this turn's retrieval block surfaced.
   * @param {string} sessionId - owning session.
   * @param {number} turn - turn the block was injected into.
   * @param {string[]} recordIds - ids in the block, best first.
   */
  noteInjection(sessionId, turn, recordIds) {
    if (!this.enabled) return
    if (!Array.isArray(recordIds) || recordIds.length === 0) return
    if (!Number.isFinite(turn)) return
    const entry = this.entry(sessionId, turn)
    for (const id of recordIds) if (typeof id === 'string' && id !== '') entry.injected.add(id)
  }

  /** The record a harness skill name belongs to, or undefined when it is not ours. */
  recordForSkill(name) {
    return this.store.findBySkillName(name)
  }

  /**
   * A skill was loaded, by the model or by a human gesture.
   * @param {string} sessionId - owning session.
   * @param {number} turn - turn it happened in.
   * @param {string} skillName - harness skill name that was resolved.
   */
  noteLoad(sessionId, turn, skillName) {
    if (!this.enabled) return
    const record = this.recordForSkill(skillName)
    if (record === undefined) return
    if (!Number.isFinite(turn)) return
    this.entry(sessionId, turn).loads.push({ recordId: record.id, skillName })
  }

  /**
   * Fold one durable session event into the ledger.
   * @param {object} session - the owning session.
   * @param {object} event - one `session/event` payload.
   */
  observe(session, event) {
    if (!this.enabled) return
    const sessionId = session?.id === undefined ? '' : String(session.id)
    if (sessionId === '') return
    const type = event?.type
    try {
      if (type === 'turn/start') {
        this.currentTurn.set(sessionId, event.data?.turn)
        return
      }
      if (type === 'tool/call') {
        if (event.data?.name !== 'skill') return
        const skillName = parseToolArguments(event.data?.arguments)?.name
        if (typeof skillName !== 'string' || skillName === '') return
        const callId = String(event.data?.callId ?? '')
        if (callId === '') return
        this.calls.set(callId, { sessionId, turn: event.data?.turn, skillName })
        if (this.calls.size > MAX_CALLS) this.calls.delete(this.calls.keys().next().value)
        return
      }
      if (type === 'tool/result') {
        // The pairing id lives on the result MESSAGE's source, not on the event
        // data — the durable `tool/result` payload is `{turn, step, message}`.
        const callId = String(event.data?.message?.source?.callId ?? event.data?.callId ?? '')
        const pending = this.calls.get(callId)
        if (pending === undefined) return
        this.calls.delete(callId)
        // A skill whose own load failed was never used. Say so loudly instead of
        // attributing it: the usual cause is that retrieval advertised a skill
        // the catalog does not actually contain.
        const failed =
          event.data?.error !== undefined || event.data?.message?.content?.[0]?.isError === true
        if (failed) {
          this.counters.loadFailures += 1
          this.logger?.warn?.(
            'experience-loop: skill %j was offered but could not be loaded (%s); it was advertised without being available',
            pending.skillName,
            event.data?.error?.code ?? 'tool error',
          )
          return
        }
        this.noteLoad(pending.sessionId, pending.turn, pending.skillName)
        return
      }
      // The user gesture path: `/skill-name` resolves through the provider and
      // reaches the model as a user message tagged `skill-invocation`.
      if (type === 'user/message') {
        const source = event.data?.source
        if (source?.kind !== 'skill-invocation') return
        this.noteLoad(sessionId, this.currentTurn.get(sessionId), source?.name)
        return
      }
      if (type === 'turn/end') {
        this.settle(sessionId, event.data?.turn, event.data?.reason?.kind)
        this.currentTurn.delete(sessionId)
      }
    } catch (error) {
      this.logger?.debug?.('experience-loop: outcome observation failed: %s', error?.message ?? error)
    }
  }

  /**
   * Close one turn: count what it surfaced, then attribute every skill it
   * actually loaded against how the turn ended.
   */
  settle(sessionId, turn, reasonKind) {
    const key = `${sessionId}:${turn}`
    const entry = this.turns.get(key)
    if (entry === undefined) return
    this.turns.delete(key)

    for (const id of entry.injected) {
      const record = this.store.find(id)
      if (record === undefined) continue
      record.surfacedCount = (record.surfacedCount ?? 0) + 1
      record.lastSurfacedAt = nowIso()
      this.store.put(record)
      this.counters.surfaced += 1
    }

    const outcome = SUCCESS_REASONS.has(reasonKind)
      ? 'success'
      : FAILURE_REASONS.has(reasonKind)
        ? 'failure'
        : undefined
    const seen = new Set()
    for (const load of entry.loads) {
      if (seen.has(load.recordId)) continue
      seen.add(load.recordId)
      if (outcome === undefined) {
        // Loaded, but the turn was cancelled or truncated. Neutral: record that
        // it was picked up, and do not pretend to know whether it helped.
        this.counters.unattributed += 1
        continue
      }
      const record = this.store.find(load.recordId)
      if (record === undefined) continue
      this.apply({
        record,
        outcome,
        signal: outcome === 'success' ? OBSERVED.skillUsed : OBSERVED.skillFailed,
        sessionId,
        turn,
      })
      if (outcome === 'success') this.counters.skillUses += 1
      else this.counters.skillFailures += 1
    }
  }

  /** Persist cumulative counters. Safe to call repeatedly. */
  flushCounters() {
    const { skillUses, skillFailures, surfaced, loadFailures, unattributed } = this.counters
    if (skillUses + skillFailures + surfaced + loadFailures + unattributed === 0) return
    this.store.bumpCounters({
      observedSkillUses: skillUses,
      observedSkillFailures: skillFailures,
      observedSurfaced: surfaced,
      observedLoadFailures: loadFailures,
      observedUnattributed: unattributed,
    })
    this.counters = { skillUses: 0, skillFailures: 0, surfaced: 0, loadFailures: 0, unattributed: 0 }
  }

  /** Drop everything belonging to one session. */
  forget(sessionId) {
    const prefix = `${sessionId}:`
    for (const key of [...this.turns.keys()]) if (key.startsWith(prefix)) this.turns.delete(key)
    for (const [callId, pending] of [...this.calls.entries()]) {
      if (pending.sessionId === sessionId) this.calls.delete(callId)
    }
    this.currentTurn.delete(sessionId)
  }

  /** One-line summary for the plugin's ready log and for `/experience stats`. */
  summary() {
    return truncate(
      `surfaced ${this.counters.surfaced}, skill uses ${this.counters.skillUses} ok / ${this.counters.skillFailures} failed` +
        (this.counters.loadFailures > 0 ? `, ${this.counters.loadFailures} advertised-but-unloadable` : ''),
      200,
    )
  }
}
