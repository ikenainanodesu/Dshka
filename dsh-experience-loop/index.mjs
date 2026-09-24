/**
 * Experience Loop — a bounded, auditable continual-learning loop for DeepSeek
 * Harness.
 *
 *   execute → validate → review → distill → reuse → revise
 *
 * The plugin contributes three things to the host and nothing else:
 *
 *   1. Retrieval before a step. `agent/pre-step` (prepended, so it sees the
 *      final claimed batch) selects the handful of records whose environment
 *      and vocabulary actually match the current request and appends ONE
 *      plugin-sourced user message carrying them. Hard-bounded by count and
 *      characters; never a dump of the store.
 *
 *   2. Evidence capture after a turn. `session/event` folds the durable event
 *      stream into one redacted journal line per finished turn. This is
 *      evidence, never an Experience, and it is never injected verbatim.
 *
 *   3. The write path. `experience_review` (model) and `/experience` (human)
 *      provide record creation and lifecycle controls. Observed outcomes
 *      additionally update confidence and status using session-event signals.
 *
 * Skills reuse the harness's own skill system: learned skills are exposed
 * through `ctx.skills` as a runtime provider, so discovery, cataloguing,
 * invalidation and the `skill` tool all stay the host's business.
 *
 * The plugin imports NO `@deepseek-ai/*` package (see lib/util.mjs for why) and
 * exports no `Config` schema, so it also carries no peer-dependency coupling.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveConfig, PLUGIN_NAME } from './lib/config.mjs'
import { ExperienceStore } from './lib/store.mjs'
import { applyObservedOutcome, applyReview, EpisodeRecorder } from './lib/review.mjs'
import { OutcomeLedger } from './lib/outcome.mjs'
import { environmentOf, extractAsk, planInjection, RetrievalState } from './lib/retrieve.mjs'
import { answerToRequest, buildSlate, resolveReply } from './lib/slate.mjs'
import { registerSkillProvider } from './lib/skills.mjs'
import {
  buildTools,
  registerCommand,
  registerPrompt,
  selectRecords,
  renderRecordDetail,
  renderRecordList,
} from './lib/surface.mjs'
import { computeRepeatMetric } from './lib/rank.mjs'
import { cleanField, redactText } from './lib/redact.mjs'
import { renderDigest } from './lib/render.mjs'
import { nowIso, truncate } from './lib/util.mjs'

export const name = PLUGIN_NAME
/**
 * Every service the plugin touches. Declaring them makes Cordis hold the
 * plugin INACTIVE until they exist — which reports "waiting for service(s)"
 * at boot instead of failing silently later.
 */
export const inject = ['agents', 'sessions', 'tools', 'commands', 'systemPrompt', 'skills']

/**
 * Build one plugin-sourced user message. `createUserMessage` would only add a
 * branded uuid, so the shape is constructed directly and stays import-free.
 */
function pluginMessage(text, form = 'recall', plugin = PLUGIN_NAME) {
  return {
    id: `exp-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin, form },
  }
}

/**
 * Records whose disagreement is still OPEN.
 *
 * A partner that no longer exists, or that is already deprecated, cannot be
 * retrieved, so the disagreement is settled in practice and must not be
 * reported as something needing attention. This is the single definition used
 * by BOTH `/experience conflicts` and the `conflicting` line of `stats` —
 * before it was shared, those two reported different numbers for the same word,
 * which is worse than either number alone.
 * @param {object[]} records - records in view.
 * @returns {object[]} records with at least one retrievable conflicting partner.
 */
function unresolvedConflicts(records) {
  const retrievable = new Set(records.filter((record) => record.status !== 'deprecated').map((record) => record.id))
  return records.filter(
    (record) =>
      record.status !== 'deprecated' &&
      (record.conflictsWith ?? []).some((id) => retrievable.has(id)),
  )
}

/**
 * The plugin runtime: owns the store and every operation reachable from a
 * tool, a command or a hook. Kept as a plain object so the tools and the
 * command share exactly one implementation of each behaviour.
 */
class ExperienceRuntime {
  constructor({ config, store, logger, warnings }) {
    this.config = config
    this.store = store
    this.logger = logger
    this.warnings = warnings
    this.enabled = config.enabled
    this.retrieval = new RetrievalState(config)
    this.lastTurn = new Map()
    /**
     * Records distilled during a session's current turn, keyed by session id.
     * Consulted (and cleared) when that turn's episode is written, so the
     * journal line can cite what it produced even though the review ran before
     * the turn ended.
     * @type {Map<string, Set<string>>}
     */
    this.turnRecords = new Map()
    /**
     * Tail of the last assistant message per session. A short user reply only
     * means something relative to what it answers, so this is the context a
     * one-letter answer is resolved against.
     * @type {Map<string, string>}
     */
    this.lastAssistantText = new Map()
    /**
     * The request as retrieval saw it, per session, for the current turn.
     * @type {Map<string, string>}
     */
    this.turnQuery = new Map()
    /**
     * The last question this agent POSED, per session, plus the answer it got.
     *
     * When the agent offers a choice the candidate set is known, so a reply like
     * "C" has an explicit referent and needs no guessing. Held until the next
     * request arrives, because the user may answer a posed question as an
     * ordinary chat message rather than through the question UI.
     * @type {Map<string, {slate: object[], posedRequest: string, at: string}>}
     */
    this.posedQuestions = new Map()
    this.skillBridge = { invalidate() {}, dispose() {} }
    /**
     * Attribute loaded skills using the turn-end signal independently of
     * explicit review outcomes. This shares the promotion gate, but is a heuristic:
     * turn completion or error does not establish a skill's causal efficacy.
     */
    this.outcomes = new OutcomeLedger({
      config,
      store,
      logger,
      apply: ({ record, outcome, signal, sessionId, turn }) => {
        const result = applyObservedOutcome({ store, record, outcome, signal, sessionId, turn, config })
        // Persist at once: a promotion that exists only in memory could be lost
        // to a kill, and the whole point of observing it is that it took effect.
        try {
          store.flush()
        } catch (error) {
          logger?.warn?.('experience-loop: flush after observed outcome failed: %s', error?.message ?? error)
        }
        if (result.promoted) {
          logger?.info?.(
            'experience-loop: %s promoted to verified by an observed outcome (%s)',
            record.id,
            signal,
          )
        }
        return result
      },
    })
    this.recorder = new EpisodeRecorder({
      config,
      logger,
      onEpisode: (episode) => this.store.appendEpisode(episode),
      takeRecordLinks: (sessionId) => {
        const ids = this.turnRecords.get(sessionId)
        if (!ids || ids.size === 0) return []
        this.turnRecords.delete(sessionId)
        return [...ids]
      },
      takeQuery: (sessionId) => {
        const query = this.turnQuery.get(sessionId)
        this.turnQuery.delete(sessionId)
        return query ?? ''
      },
    })
  }

  /** Remember the tail of one assistant message, for resolving short replies. */
  noteAssistantText(sessionId, text) {
    if (typeof text !== 'string' || text.trim() === '') return
    this.lastAssistantText.set(sessionId, truncate(text, this.config.askContextChars))
    if (this.lastAssistantText.size > 64) {
      const oldest = this.lastAssistantText.keys().next().value
      if (oldest !== sessionId) this.lastAssistantText.delete(oldest)
    }
  }

  /**
   * Remember a question this agent posed and the answer it received, so a reply
   * can be resolved against the ACTUAL candidate set instead of guessed at.
   *
   * Observation only: `user-questions/request` is a waterfall and this plugin
   * calls `next()`, so it never claims, answers, or delays a question.
   */
  notePosedQuestion(agent, questions, answer) {
    const sessionId = agent?.session ? String(agent.session.id) : undefined
    if (sessionId === undefined) return
    const slate = buildSlate(questions)
    if (slate.length === 0) return
    this.posedQuestions.set(sessionId, {
      slate,
      posedRequest: answerToRequest(answer, slate),
      at: nowIso(),
    })
    if (this.posedQuestions.size > 64) {
      const oldest = this.posedQuestions.keys().next().value
      if (oldest !== sessionId) this.posedQuestions.delete(oldest)
    }
  }

  /** Consume the pending posed question for one session, if any. */
  takePosedQuestion(sessionId) {
    const entry = this.posedQuestions.get(sessionId)
    if (entry === undefined) return undefined
    this.posedQuestions.delete(sessionId)
    return entry
  }

  attachSkillBridge(bridge) {
    this.skillBridge = bridge
  }

  setEnabled(value) {
    this.enabled = value
    this.logger?.info?.('experience-loop: %s', value ? 'enabled' : 'disabled')
  }

  noteTurn(session, turn) {
    this.lastTurn.set(String(session.id), turn)
    if (this.lastTurn.size > 64) {
      const oldest = this.lastTurn.keys().next().value
      this.lastTurn.delete(oldest)
    }
  }

  /**
   * Environment + identity facts of one agent's session. When there is no
   * agent (the human slash command runs without one), the project most
   * recently seen by any hook is used instead — otherwise `/experience stats`
   * would silently report only global records.
   */
  contextOf(agent) {
    const session = agent?.session
    if (session) {
      const env = environmentOf(session)
      this.store.setProject(env.projectKey, env.projectPath)
      const sessionId = String(session.id)
      return {
        sessionId,
        turn: this.lastTurn.get(sessionId),
        projectKey: env.projectKey,
        projectPath: env.projectPath,
        platform: env.platform,
        shell: env.shell,
        source: 'agent',
      }
    }
    return {
      sessionId: 'unknown',
      turn: undefined,
      projectKey: this.store.lastProjectKey,
      projectPath: this.store.lastProjectPath,
      platform: process.platform,
      shell: process.platform === 'win32' ? 'pwsh' : 'bash',
      source: 'user',
    }
  }

  /** Write path used by the review tool. */
  review(payload, agent) {
    const context = this.contextOf(agent)
    if (!this.enabled || !this.config.learn) {
      return {
        created: [],
        updated: [],
        merged: [],
        superseded: [],
        conflicts: [],
        rejected: [],
        outcomesApplied: 0,
        redactions: 0,
        notes: ['Experience Loop is disabled (or learning is off); nothing was written.'],
      }
    }
    const episodes = this.store.pendingEpisodes(6, context.sessionId)
    const report = applyReview({
      store: this.store,
      payload,
      context: { ...context, episodeIds: episodes.map((episode) => episode.id) },
      config: this.config,
      logger: this.logger,
    })
    const produced = [...report.created.map((item) => item.id), ...report.merged.map((item) => item.id)]
    if (produced.length > 0 && context.sessionId !== 'unknown') {
      const existing = this.turnRecords.get(context.sessionId) ?? new Set()
      for (const id of produced) existing.add(id)
      this.turnRecords.set(context.sessionId, existing)
    }
    this.store.flush()
    this.skillBridge.invalidate()
    // A review is a single-level operation by construction: it writes records
    // and returns. Nothing here can start another review.
    return report
  }

  /** Read path used by the query tool and the slash command. */
  query(args, agent) {
    const context = this.contextOf(agent)
    const action = typeof args?.action === 'string' ? args.action : 'list'
    const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(200, args.limit)) : 25
    const all = this.store.all(context.projectKey)
    const filters = { type: args?.type, scope: args?.scope, status: args?.status }
    const toRef = (record, withDetail) => ({
      id: record.id,
      type: record.type,
      title: record.title,
      status: record.status,
      scope: record.scope.level,
      confidence: Number((record.confidence ?? 0).toFixed(2)),
      summary: record.summary,
      ...(withDetail ? { detail: renderRecordDetail(record) } : {}),
    })

    const listBy = (predicate, sort) => {
      let records = selectRecords(all, filters).filter(predicate)
      records = sort ? sort(records) : records
      return records
    }

    switch (action) {
      case 'show': {
        const record = this.store.resolve(args?.id ?? '')
        if (!record) {
          return { action, count: 0, text: `No record matches "${args?.id ?? ''}".`, records: [] }
        }
        return { action, count: 1, text: renderRecordDetail(record), records: [toRef(record, true)] }
      }
      case 'search': {
        const records = selectRecords(all, { ...filters, query: args?.query ?? '' }).slice(0, limit)
        return {
          action,
          count: records.length,
          text: renderRecordList(records, { emptyText: `Nothing matches "${args?.query ?? ''}".` }),
          records: records.map((record) => toRef(record, args?.full === true)),
        }
      }
      case 'list': {
        const records = selectRecords(all, filters)
          .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
          .slice(0, limit)
        return {
          action,
          count: records.length,
          text: renderRecordList(records),
          records: records.map((record) => toRef(record, args?.full === true)),
        }
      }
      case 'conflicts': {
        // Only GENUINE, unresolved disagreement — see `unresolvedConflicts`.
        const records = unresolvedConflicts(all)
        const retrievable = new Set(all.filter((record) => record.status !== 'deprecated').map((record) => record.id))
        const livePartners = (record) => record.conflictsWith.filter((id) => retrievable.has(id)).join(', ')
        return {
          action,
          count: records.length,
          text:
            records.length === 0
              ? 'No unresolved conflicting records.'
              : `${records.length} record(s) in unresolved conflict:\n${records
                  .map((record) => `${record.id} [${record.type}] ${record.title} ↔ ${livePartners(record)}`)
                  .join('\n')}`,
          records: records.map((record) => toRef(record, false)),
        }
      }
      case 'pending': {
        const episodes = this.store.pendingEpisodes(limit, undefined)
        const text =
          episodes.length === 0
            ? 'No unreviewed turns.'
            : `${episodes.length} unreviewed turn(s):\n${episodes
                .map(
                  (episode) =>
                    `- ${episode.id} (session ${episode.sessionId.slice(0, 18)}…, turn ${episode.turn}) ` +
                    `${episode.toolCallCount} tool call(s)${episode.failedTools?.length ? `, failures: ${episode.failedTools.join('/')}` : ''}\n    "${truncate(episode.ask, 160)}"`,
                )
                .join('\n')}`
        return { action, count: episodes.length, text, records: [] }
      }
      case 'deprecated': {
        const records = listBy(
          (record) => record.status === 'deprecated',
          (list) => [...list].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
        ).slice(0, limit)
        return {
          action,
          count: records.length,
          text:
            records.length === 0
              ? 'No deprecated records.'
              : `${records.length} deprecated record(s):\n${records
                  .map((record) => `${record.id} [${record.type}] ${record.title} — ${record.deprecatedReason ?? 'no reason recorded'}`)
                  .join('\n')}`,
          records: records.map((record) => toRef(record, false)),
        }
      }
      case 'projects': {
        const projects = this.store.projects()
        return {
          action,
          count: projects.length,
          text:
            projects.length === 0
              ? 'No project-scoped records.'
              : projects.map((entry) => `${entry.project}: ${entry.count} record(s)`).join('\n'),
          records: [],
        }
      }
      case 'audit': {
        const entries = this.store.recentAudit(limit)
        return {
          action,
          count: entries.length,
          text:
            entries.length === 0
              ? 'No audit entries.'
              : entries
                  .slice()
                  .reverse()
                  .map((entry) => `${entry.at} ${entry.action} ${entry.recordId ?? entry.newRecord?.id ?? ''} ${entry.title ?? entry.incomingTitle ?? ''}`.trim())
                  .join('\n'),
          records: [],
        }
      }
      case 'metric': {
        const metric = computeRepeatMetric(this.store.recentEpisodes(2000), { askCap: this.config.episodeAskChars })
        const caveatParts = []
        if (metric.episodesSkippedShort > 0) {
          caveatParts.push(
            `${metric.episodesSkippedShort} turn(s) carrying no wording to identify the task (a short reply counts only when the preceding turn it answered was recorded)`,
          )
        }
        if (metric.episodesSkippedTruncated > 0) {
          caveatParts.push(
            `${metric.episodesSkippedTruncated} turn(s) whose request was truncated for the journal, so their retained opening is boilerplate rather than the task`,
          )
        }
        const caveat =
          caveatParts.length > 0
            ? `\n(not compared: ${caveatParts.join('; ')}.)`
            : ''
        const text =
          metric.repeatedTaskGroups === 0
            ? `Not enough comparable repeats yet. A task counts once the same request has been seen at least twice in the same workspace, with enough untruncated wording to recognise it.${caveat}`
            : [
                `Repeated task groups: ${metric.repeatedTaskGroups}  (from ${metric.episodesAnalysed} comparable turn(s))`,
                `First run average tool calls: ${metric.firstRunAverageToolCalls}`,
                `Later runs average tool calls: ${metric.laterRunAverageToolCalls}`,
                `Reduction: ${metric.reductionPercent}%`,
                '',
                ...metric.rows
                  .slice(0, 12)
                  .map(
                    (row) =>
                      `- ${row.runs}× ${row.isReply ? '(reply to) ' : ''}"${row.example}" first ${row.firstToolCalls} → later ${row.laterAverageToolCalls} (${row.delta >= 0 ? '+' : ''}${row.delta})`,
                  ),
              ].join('\n') + caveat
        return {
          action,
          count: metric.repeatedTaskGroups,
          text,
          records: [],
          metric: {
            episodesAnalysed: metric.episodesAnalysed,
            episodesSkipped: metric.episodesSkipped,
            episodesSkippedShort: metric.episodesSkippedShort,
            episodesSkippedTruncated: metric.episodesSkippedTruncated,
            repeatedTaskGroups: metric.repeatedTaskGroups,
            firstRunAverageToolCalls: metric.firstRunAverageToolCalls,
            laterRunAverageToolCalls: metric.laterRunAverageToolCalls,
            reductionPercent: metric.reductionPercent,
          },
        }
      }
      case 'stats':
      default: {
        const state = this.store.readState()
        const counts = { memory: 0, skill: 0, failure: 0, validation: 0 }
        const statuses = { candidate: 0, verified: 0, deprecated: 0 }
        let global = 0
        let project = 0
        for (const record of all) {
          counts[record.type] = (counts[record.type] ?? 0) + 1
          statuses[record.status] = (statuses[record.status] ?? 0) + 1
          if (record.scope.level === 'global') global++
          else project++
        }
        const pending = this.store.pendingEpisodes(1000, undefined).length
        const conflicts = unresolvedConflicts(all).length
        const text = [
          `Experience Loop is ${this.enabled ? 'enabled' : 'disabled'} (retrieval ${this.config.inject ? 'on' : 'off'}, learning ${this.config.learn ? 'on' : 'off'}).`,
          `Store: ${this.store.root}`,
          '',
          `Records: ${all.length} (global ${global}, project ${project})`,
          `  memory ${counts.memory} · skill ${counts.skill} · failure ${counts.failure} · validation ${counts.validation}`,
          `  candidate ${statuses.candidate} · verified ${statuses.verified} · deprecated ${statuses.deprecated}`,
          `  conflicting ${conflicts}`,
          `Episodes: ${state.episodes} total, ${pending} unreviewed`,
          '',
          `Injections: ${state.injections} (${state.injectionChars} chars)`,
          `Reviews: ${state.reviews} · created ${state.recordsCreated} · merged ${state.recordsMerged} · rejected ${state.recordsRejected}`,
          `Outcome reports: ${state.outcomesSuccess} ok / ${state.outcomesFailure} failed (model-reported)`,
          `Observed outcomes: ${state.observedSkillUses ?? 0} skill use(s) ok / ${state.observedSkillFailures ?? 0} failed · ${state.observedSurfaced ?? 0} record surface(s), scored only for skill use`,
          ...((state.observedLoadFailures ?? 0) > 0
            ? [
                `  WARNING: ${state.observedLoadFailures} skill(s) were offered in a retrieval block but could not be loaded`,
              ]
            : []),
          `Learning: skills exposed as ${this.config.exposeSkills} (max ${this.config.maxExposedSkills}) · observed attribution ${this.config.observeOutcomes ? 'on' : 'off'}`,
          `Conflicts seen: ${state.conflictsSeen} · sensitive spans redacted: ${state.secretsRedacted}`,
        ].join('\n')
        return { action: 'stats', count: all.length, text, records: [] }
      }
    }
  }

  // ── command surface ────────────────────────────────────────────────────────

  commandList({ type, limit } = {}) {
    const max = Number.parseInt(limit ?? '25', 10)
    const records = selectRecords(this.store.all(this.store.lastProjectKey), {
      type: type && type !== 'all' ? type : undefined,
    })
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, Number.isFinite(max) ? max : 25)
    return renderRecordList(records)
  }

  commandSearch(text) {
    const records = selectRecords(this.store.all(this.store.lastProjectKey), { query: text }).slice(0, 25)
    return renderRecordList(records, { emptyText: `Nothing matches "${text}".` })
  }

  commandShow(idOrName) {
    const record = this.store.resolve(idOrName)
    if (!record) return `No record matches "${idOrName}".`
    return renderRecordDetail(record)
  }

  commandStats() {
    return this.query({ action: 'stats' }, undefined).text
  }

  commandMetric() {
    return this.query({ action: 'metric' }, undefined).text
  }

  commandConflicts() {
    return this.query({ action: 'conflicts' }, undefined).text
  }

  commandPending() {
    return this.query({ action: 'pending' }, undefined).text
  }

  commandDeprecated() {
    return this.query({ action: 'deprecated' }, undefined).text
  }

  commandProjects() {
    return this.query({ action: 'projects' }, undefined).text
  }

  commandAudit(limit) {
    const n = Number.parseInt(limit ?? '20', 10)
    return this.query({ action: 'audit', limit: Number.isFinite(n) ? n : 20 }, undefined).text
  }

  commandSetFlag(idOrName, _flag, value) {
    const record = this.store.resolve(idOrName)
    if (!record) return `No record matches "${idOrName}".`
    record.pinned = value
    record.updatedAt = nowIso()
    this.store.put(record)
    this.store.audit({ action: value ? 'pin' : 'unpin', recordId: record.id })
    this.store.flush()
    this.skillBridge.invalidate()
    return `${value ? 'Pinned' : 'Unpinned'} ${record.id} — ${record.title}`
  }

  commandSetStatus(idOrName, status) {
    const record = this.store.resolve(idOrName)
    if (!record) return `No record matches "${idOrName}".`
    record.status = status
    if (status === 'verified') record.confidence = Math.max(record.confidence, 0.7)
    if (status === 'candidate') record.confidence = Math.min(record.confidence, 0.6)
    record.deprecatedReason = null
    record.updatedAt = nowIso()
    this.store.put(record)
    this.store.audit({ action: 'status', recordId: record.id, status, by: 'user' })
    this.store.flush()
    this.skillBridge.invalidate()
    return `${record.id} is now ${status} (confidence ${record.confidence.toFixed(2)}).`
  }

  commandDeprecate(idOrName, reason) {
    const record = this.store.resolve(idOrName)
    if (!record) return `No record matches "${idOrName}".`
    record.status = 'deprecated'
    record.deprecatedReason = reason && reason !== '' ? reason : 'deprecated by user'
    record.updatedAt = nowIso()
    this.store.put(record)
    this.store.audit({ action: 'deprecate', recordId: record.id, reason: record.deprecatedReason, by: 'user' })
    this.store.flush()
    this.skillBridge.invalidate()
    return `Deprecated ${record.id} — ${record.title}\nReason: ${record.deprecatedReason}`
  }

  commandDelete(idOrName) {
    const record = this.store.resolve(idOrName)
    if (!record) return `No record matches "${idOrName}".`
    this.store.remove(record.id)
    this.store.audit({ action: 'delete', recordId: record.id, title: record.title, by: 'user' })
    this.store.flush()
    this.skillBridge.invalidate()
    return `Deleted ${record.id} — ${record.title}`
  }

  commandForgetProject(key) {
    const projectKey = key && key !== '' ? key : this.store.lastProjectKey
    if (!projectKey) return 'No project context; pass a project key from `/experience projects`.'
    const count = this.store.forgetProject(projectKey)
    this.store.audit({ action: 'forget-project', project: projectKey, deleted: count, by: 'user' })
    this.store.flush()
    this.skillBridge.invalidate()
    return `Deleted ${count} project-scoped record(s) for ${projectKey}. Global records are untouched.`
  }

  commandExport(target) {
    const records = this.store.all(this.store.lastProjectKey)
    const path = target && target !== '' ? target : `${this.store.root}\\export-${Date.now()}.json`
    const bundle = {
      version: 1,
      kind: 'dsh-experience-loop-export',
      exportedAt: nowIso(),
      storeRoot: this.store.root,
      records,
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
    this.store.audit({ action: 'export', path, count: records.length, by: 'user' })
    return `Exported ${records.length} record(s) to ${path}`
  }

  commandImport(path) {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const incoming = Array.isArray(parsed?.records) ? parsed.records : Array.isArray(parsed) ? parsed : []
    if (incoming.length === 0) return `Nothing to import from ${path}.`
    let added = 0
    let skipped = 0
    for (const raw of incoming) {
      if (!raw || typeof raw !== 'object') continue
      const title = cleanField(raw.title, 200)
      const summary = cleanField(raw.summary, 2000)
      if (title.rejected || summary.rejected || title.text.trim() === '') {
        skipped++
        continue
      }
      if (typeof raw.id === 'string' && this.store.find(raw.id)) {
        skipped++
        continue
      }
      const record = {
        ...raw,
        title: title.text,
        summary: summary.text,
        source: 'import',
        updatedAt: nowIso(),
      }
      delete record.skillName
      this.store.put(record)
      added++
    }
    this.store.flush()
    this.skillBridge.invalidate()
    return `Imported ${added} record(s) from ${path}${skipped > 0 ? ` (${skipped} skipped: duplicates or credential-only)` : ''}.`
  }

  commandDigest() {
    return renderDigest(this.store.all(this.store.lastProjectKey), this.store.readState(), this.store.root)
  }

  commandRedact(text) {
    if (!text || text.trim() === '') return 'usage: /experience redact <text>'
    const single = redactText(text)
    const field = cleanField(text, 4000)
    return [
      'Input:',
      text,
      '',
      'Stored as:',
      single.text,
      '',
      `Rules matched: ${single.hits.length === 0 ? '(none)' : single.hits.join(', ')}`,
      `Rejected as credential-only: ${field.rejected ? 'yes' : 'no'}`,
    ].join('\n')
  }
}

/**
 * Plugin entry point.
 * @param {object} ctx - Cordis context with the injected services.
 * @param {object} rawConfig - the patch row's `config`.
 */
export function apply(ctx, rawConfig) {
  const { config, warnings } = resolveConfig(rawConfig)
  const logger = ctx.logger
  for (const warning of warnings) logger?.warn?.('experience-loop: %s', warning)

  const store = new ExperienceStore({ root: config.storeRoot, logger })
  const runtime = new ExperienceRuntime({ config, store, logger, warnings })

  if (!config.enabled) {
    logger?.info?.('experience-loop: disabled by config; no tools, hooks or prompt section mounted')
    return
  }

  // ── discovery for the tools and the command ────────────────────────────────
  runtime.attachSkillBridge(registerSkillProvider({ ctx, store, config, logger }))
  ctx.effect(() => () => runtime.skillBridge.dispose(), 'experience-loop.skillProvider')

  for (const tool of buildTools(runtime)) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      logger?.error?.('experience-loop: tool %s registration failed: %s', tool.name, error?.message ?? error)
    }
  }
  registerCommand(ctx, runtime, logger)
  registerPrompt(ctx, logger)

  // Expose the runtime so another plugin can read or write experiences without
  // re-implementing the lifecycle.
  try {
    ctx.provide('experienceLoop', runtime)
  } catch (error) {
    logger?.debug?.('experience-loop: provide() skipped: %s', error?.message ?? error)
  }

  // ── hook 1: retrieval before a step ────────────────────────────────────────
  // `prepend` puts this listener first, so `next()` runs every downstream
  // contributor and the batch it returns is final — the same contract the
  // shipped memory plugin relies on.
  ctx.on(
    'agent/pre-step',
    async ({ agent, turn, step, signal }, next) => {
      const decision = await next()
      if (!runtime.enabled || decision?.kind !== 'enter' || signal?.aborted) return decision
      if (step !== 1) return decision
      const origin = agent?.session?.header?.origin
      if (origin === 'subagent' && !config.injectSubagents) return decision
      try {
        const sessionId = String(agent.session.id)
        // A reply like "C" is a real request whose meaning lives in the question
        // it answers. If this agent actually posed that question, the candidate
        // set is known — resolve against it instead of guessing. The stash is
        // consumed here because it belongs to the request that just arrived.
        const posed = runtime.takePosedQuestion(sessionId)
        const rawAsk = extractAsk(decision.messages).trim()
        const resolution = posed === undefined ? { outcome: 'none', labels: [] } : resolveReply(posed.slate, rawAsk)
        if (resolution.outcome === 'ambiguous') {
          logger?.info?.(
            'experience-loop: reply %j matches more than one option of %j; not guessing — a clarification should be asked',
            rawAsk,
            posed?.slate?.[0]?.question ?? '',
          )
        }
        const result = planInjection({
          store,
          session: agent.session,
          turn,
          messages: decision.messages,
          config,
          state: runtime.retrieval,
          logger,
          // Pass 2 material, used ONLY when the user's own words found nothing.
          conversationContext: runtime.lastAssistantText.get(sessionId) ?? '',
          resolvedReply: resolution.outcome === 'selected' ? resolution : undefined,
          posedRequest: posed?.posedRequest ?? '',
        })
        // Remember what this turn was actually ABOUT, whether or not anything
        // matched, so the journal can identify a short reply as a task.
        if (result.query !== '') runtime.turnQuery.set(sessionId, result.query)
        if (result.text === '') return decision
        // Hand the ledger what this block surfaced, so the turn can later be
        // settled against how it ended.
        runtime.outcomes.noteInjection(
          sessionId,
          turn,
          result.hits.map((hit) => hit.record.id),
        )
        return { kind: 'enter', messages: [...decision.messages, pluginMessage(result.text, 'recall')] }
      } catch (error) {
        logger?.warn?.('experience-loop: retrieval failed: %s', error?.message ?? error)
        return decision
      }
    },
    { prepend: true },
  )

  // ── hook 2: deterministic evidence capture ─────────────────────────────────
  ctx.on('agent/session-start', ({ agent }) => {
    const env = environmentOf(agent.session)
    store.setProject(env.projectKey, env.projectPath)
    agent.ctx.effect(() => () => {
      runtime.retrieval.forget(String(agent.session.id))
      runtime.recorder.forget(String(agent.session.id))
      runtime.lastTurn.delete(String(agent.session.id))
      runtime.turnRecords.delete(String(agent.session.id))
      runtime.lastAssistantText.delete(String(agent.session.id))
      runtime.turnQuery.delete(String(agent.session.id))
      runtime.posedQuestions.delete(String(agent.session.id))
      runtime.outcomes.forget(String(agent.session.id))
    }, 'experience-loop.sessionCleanup')
  })

  // ── hook 2b: the candidate set of a question this agent posed ──────────────
  // `user-questions/request` is a waterfall. This listener observes and then
  // delegates with `next()`: it never claims the question, answers it, or adds
  // latency the user would notice. What it buys is the REFERENT a short reply
  // needs — when the agent offers "A / B / C", a reply of "C" stops being a
  // guess and becomes a lookup against a known option list.
  ctx.on('user-questions/request', async (request, next) => {
    const answer = await next()
    try {
      runtime.notePosedQuestion(request?.agent, request?.questions, answer)
      const labels = (answer?.answers ?? [])
        .flatMap((entry) => (Array.isArray(entry?.selected) ? entry.selected : []))
        .filter((label) => typeof label === 'string' && label !== '')
      const custom = (answer?.answers ?? []).filter((entry) => typeof entry?.custom === 'string' && entry.custom !== '')
      if (labels.length > 0 || custom.length > 0) {
        logger?.debug?.(
          'experience-loop: recorded a posed question (%d option set(s)); answer was %s',
          buildSlate(request?.questions).length,
          labels.length > 0 ? `${labels.length} canonical label(s)` : 'free text',
        )
      }
    } catch (error) {
      logger?.warn?.('experience-loop: could not record a posed question: %s', error?.message ?? error)
    }
    return answer
  })

  ctx.on('session/event', (session, event) => {
    if (!runtime.enabled) return
    if (event?.type === 'turn/start') runtime.noteTurn(session, event.data.turn)
    if (event?.type === 'assistant/message') {
      const content = event.data?.message?.content
      const text = (Array.isArray(content) ? content : [])
        .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .join('\n')
      runtime.noteAssistantText(String(session.id), text)
    }
    if (config.captureEpisodes) runtime.recorder.observe(session, event)
    // Observed outcomes ride the same stream, but stay a separate concern: the
    // recorder writes evidence about a TURN, the ledger scores a RECORD.
    runtime.outcomes.observe(session, event)
  })

  // ── hook 3: durability ─────────────────────────────────────────────────────
  ctx.on('session/flush', () => {
    try {
      runtime.outcomes.flushCounters()
      if (store.dirty.size > 0) store.flush()
    } catch (error) {
      logger?.warn?.('experience-loop: flush failed: %s', error?.message ?? error)
    }
  })

  ctx.effect(
    () => () => {
      try {
        runtime.outcomes.flushCounters()
        store.flush()
      } catch (error) {
        logger?.warn?.('experience-loop: final flush failed: %s', error?.message ?? error)
      }
    },
    'experience-loop.flushOnUnload',
  )

  logger?.info?.(
    'experience-loop: ready (store=%s, retrieval=%s/%d, learning=%s, skills=%s, observed outcomes=%s)',
    config.storeRoot,
    config.inject ? 'on' : 'off',
    config.injectTopK,
    config.learn ? 'on' : 'off',
    config.exposeSkills,
    config.observeOutcomes ? 'on' : 'off',
  )
}

export { ExperienceRuntime }
