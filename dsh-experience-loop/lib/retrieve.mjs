/**
 * Experience retrieval — the "before the task" half of the loop.
 *
 * The whole point is a SMALL prompt: filter by environment, score by keyword
 * coverage, take a handful, and hard-stop at a character budget. A learn-ing
 * system that dumps its whole store into context is worse than no system.
 */

import { makeQuery, rankRecords } from './rank.mjs'
import { renderRetrievalBlock } from './render.mjs'
import { projectKeyOf, projectRootOf } from './util.mjs'
import { tokenize } from './util.mjs'
import { PLUGIN_NAME } from './config.mjs'

/**
 * Message sources that ARE the task statement.
 *
 * `user` is a human prompt. `agent-message` (`form: 'relay'`) is how a
 * SUBAGENT receives its assignment: `dsh-subagent` relays the parent's task
 * with `createAgentMessage()`, whose source is `{kind: 'agent-message',
 * form: 'relay'}` — NOT `kind: 'user'`. Accepting only `user` silently disabled
 * retrieval for every delegated session, which was caught in live testing.
 */
const ASK_SOURCES = new Set(['user', 'agent-message'])

/**
 * Forms that are context, never a request. Excluding them keeps the agent's own
 * injected material (including this plugin's own `recall` block) out of the
 * retrieval query — otherwise a long catalog or snapshot would both dilute the
 * score and create a feedback loop.
 */
const NON_TASK_FORMS = new Set(['catalog', 'snapshot', 'recall', 'instructions', 'notice'])

/** Which messages are "the ask" for this step? */
export function extractAsk(messages) {
  const parts = []
  for (const message of messages ?? []) {
    const source = message?.source
    if (!source) continue
    if (!ASK_SOURCES.has(source.kind)) continue
    if (source.plugin === PLUGIN_NAME) continue
    if (NON_TASK_FORMS.has(source.form)) continue
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/** Environment facts of the current activity, derived from the session. */
export function environmentOf(session, platform = process.platform) {
  const cwd = session?.header?.cwd
  const root = projectRootOf(cwd)
  return {
    platform,
    shell: platform === 'win32' ? 'pwsh' : 'bash',
    project: root ? root.split(/[\\/]/).filter(Boolean).pop() : undefined,
    projectKey: projectKeyOf(root),
    projectPath: root,
  }
}

/** Per-session retrieval bookkeeping: cooldown and hard caps. */
export class RetrievalState {
  constructor(config) {
    this.config = config
    /** @type {Map<string, {turns: Set<number>, count: number, lastTurn: number, seen: Set<string>}>} */
    this.sessions = new Map()
  }

  stateFor(sessionId) {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = { turns: new Set(), count: 0, lastTurn: -1, seen: new Set() }
      this.sessions.set(sessionId, state)
      if (this.sessions.size > 64) {
        const oldest = this.sessions.keys().next().value
        if (oldest !== sessionId) this.sessions.delete(oldest)
      }
    }
    return state
  }

  shouldAttempt(sessionId, turn) {
    const state = this.stateFor(sessionId)
    if (state.turns.has(turn)) return false
    if (state.count >= this.config.injectMaxPerSession) return false
    if (this.config.injectCooldownTurns > 0 && state.lastTurn >= 0 && turn - state.lastTurn <= this.config.injectCooldownTurns) {
      // A cooldown exists so a burst of turns inside one task does not pay the
      // same injection over and over; it never blocks the first turn.
      return false
    }
    return true
  }

  record(sessionId, turn, ids) {
    const state = this.stateFor(sessionId)
    state.turns.add(turn)
    state.count += 1
    state.lastTurn = turn
    for (const id of ids) state.seen.add(id)
  }

  forget(sessionId) {
    this.sessions.delete(sessionId)
  }
}

/**
 * Decide and render the injection for one step.
 * @param {object} options - `{ store, session, turn, messages, config, state, logger }`.
 * @returns {{ text: string, hits: object[], reason: string }}
 */
export function planInjection({ store, session, turn, messages, config, state, logger }) {
  const empty = { text: '', hits: [], reason: '' }
  if (!config.inject) return { ...empty, reason: 'retrieval disabled' }

  const ask = extractAsk(messages)
  if (ask.trim().length < 12) return { ...empty, reason: 'not a substantive request' }

  const sessionId = String(session.id)
  if (!state.shouldAttempt(sessionId, turn)) return { ...empty, reason: 'cooldown or cap' }

  const env = environmentOf(session)
  store.setProject(env.projectKey, env.projectPath)
  const records = store.all(env.projectKey)
  if (records.length === 0) return { ...empty, reason: 'store is empty' }

  const query = makeQuery({ text: ask, env, config })
  if (query.tokens.size === 0) return { ...empty, reason: 'no usable query tokens' }

  const hits = rankRecords(records, query, {
    limit: config.injectTopK,
    minScore: config.injectMinScore,
    // Two shared meaningful tokens minimum. Relevance is intentionally a
    // saturating function of the overlap COUNT (see lib/rank.mjs), because a
    // long, detailed task prompt must not score lower than a one-line one.
    minOverlap: 2,
    minRelevance: 0.18,
  })
  if (hits.length === 0) return { ...empty, reason: 'nothing scored above threshold' }

  const pending = store.pendingEpisodes(5, sessionId)
  const notes = []
  if (pending.length > 0 && config.learn) {
    notes.push(
      `You have ${pending.length} unreviewed turn(s) in this session. If you learned something durable here, call experience_review once before finishing.`,
    )
  }

  const text = renderRetrievalBlock(hits, notes, config.injectBudgetChars)
  if (text === '') return { ...empty, reason: 'budget too small' }

  state.record(sessionId, turn, hits.map((hit) => hit.record.id))
  store.bumpCounters({ injections: 1, injectionChars: text.length })
  logger?.debug?.(
    'experience-loop: injected %d record(s) (%d chars) for turn %d',
    hits.length,
    text.length,
    turn,
  )
  return { text, hits, reason: 'injected' }
}

export { tokenize }
