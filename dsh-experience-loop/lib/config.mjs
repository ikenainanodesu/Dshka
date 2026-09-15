/**
 * Configuration normalization.
 *
 * The plugin exports no `Config` schema on purpose (that would require
 * `@deepseek-ai/schemastery`, which a symlink-installed local plugin cannot
 * resolve — see lib/util.mjs). Instead every field is validated and clamped
 * here, and unknown fields are reported through the returned `warnings` so a
 * typo in a profile patch is visible in the log rather than silently ignored.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { clamp } from './util.mjs'

export const PLUGIN_NAME = 'experience-loop'

/** The only values accepted for `exposeSkills`. */
export const EXPOSE_MODES = ['verified', 'all', 'none']

const KNOWN_KEYS = new Set([
  'enabled',
  'storeRoot',
  'inject',
  'injectTopK',
  'injectBudgetChars',
  'injectMinScore',
  'injectCooldownTurns',
  'learn',
  'captureEpisodes',
  'episodeRetention',
  'episodeAskChars',
  'askContextChars',
  'exposeSkills',
  'maxExposedSkills',
  'skillDescriptionChars',
  'defaultScope',
  'recencyHalfLifeDays',
  'weights',
  'promoteConfidence',
  'promoteSuccesses',
  'deprecateConfidence',
  'autoDeprecate',
  'observeOutcomes',
  'logLevel',
])

function num(value, fallback, lo, hi) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return clamp(parsed, lo, hi)
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Normalize raw plugin config.
 * @param {Record<string, unknown>} input - config object from the patch row.
 * @returns {{ config: Record<string, any>, warnings: string[] }}
 */
export function resolveConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const warnings = []
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`unknown config key "${key}" ignored`)
  }

  const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const storeRoot =
    typeof raw.storeRoot === 'string' && raw.storeRoot.trim() !== ''
      ? raw.storeRoot.trim()
      : join(home, 'experience-loop')

  const inject = raw.inject && typeof raw.inject === 'object' ? raw.inject : {}
  const weights = raw.weights && typeof raw.weights === 'object' ? raw.weights : {}

  const exposeSkills = EXPOSE_MODES.includes(raw.exposeSkills) ? raw.exposeSkills : 'verified'
  if (raw.exposeSkills !== undefined && !EXPOSE_MODES.includes(raw.exposeSkills)) {
    warnings.push(`exposeSkills "${raw.exposeSkills}" is not one of ${EXPOSE_MODES.join('|')}; using "verified"`)
  }

  const defaultScope = raw.defaultScope === 'global' ? 'global' : 'project'

  const config = {
    enabled: bool(raw.enabled, true),
    storeRoot,

    inject: bool(inject.enabled, bool(raw.injectEnabled, true)),
    injectTopK: Math.round(num(inject.topK ?? raw.injectTopK, 4, 1, 12)),
    injectBudgetChars: Math.round(num(inject.budgetChars ?? raw.injectBudgetChars, 1800, 200, 8000)),
    injectMinScore: num(inject.minScore ?? raw.injectMinScore, 0.32, 0, 1),
    /** Suppress re-injection for this many turns after one fired, per session. */
    injectCooldownTurns: Math.round(num(inject.cooldownTurns ?? raw.injectCooldownTurns, 1, 0, 50)),
    /** Optional hard cap on injections per session, to bound worst-case cost. */
    injectMaxPerSession: Math.round(num(inject.maxPerSession ?? raw.injectMaxPerSession, 60, 1, 1000)),
    /**
     * Whether subagent sessions also receive retrieval. Off by default: the
     * parent already paid for the same context, and a delegated search or
     * analysis task rarely needs project memory.
     */
    injectSubagents: bool(inject.subagents ?? raw.injectSubagents, false),

    learn: bool(raw.learn, true),
    captureEpisodes: bool(raw.captureEpisodes, true),
    episodeRetention: Math.round(num(raw.episodeRetention, 400, 20, 5000)),
    episodeAskChars: Math.round(num(raw.episodeAskChars, 400, 60, 4000)),
    /**
     * How much of the preceding assistant turn may be used as retrieval
     * REFERENT — the second-pass material tried only when the user's own words
     * found nothing. There is deliberately no "is this a reply?" threshold: a
     * shape test is an arbitrary constant that both misses real replies and
     * discards real short requests. What a reply needs is an explicit referent,
     * which comes from the question the agent posed (see lib/slate.mjs) or,
     * failing that, from this text.
     */
    askContextChars: Math.round(num(raw.askContextChars, 1200, 0, 8000)),

    exposeSkills,
    maxExposedSkills: Math.round(num(raw.maxExposedSkills, 25, 0, 200)),
    skillDescriptionChars: Math.round(num(raw.skillDescriptionChars, 300, 40, 500)),

    defaultScope,
    recencyHalfLifeDays: num(raw.recencyHalfLifeDays, 45, 1, 3650),

    weights: {
      relevance: num(weights.relevance, 1.0, 0, 10),
      confidence: num(weights.confidence, 0.6, 0, 10),
      environment: num(weights.environment, 0.5, 0, 10),
      recency: num(weights.recency, 0.25, 0, 10),
      reliability: num(weights.reliability, 0.4, 0, 10),
    },

    promoteConfidence: num(raw.promoteConfidence, 0.7, 0.1, 1),
    promoteSuccesses: Math.round(num(raw.promoteSuccesses, 2, 1, 50)),
    deprecateConfidence: num(raw.deprecateConfidence, 0.15, 0, 0.9),
    autoDeprecate: bool(raw.autoDeprecate, true),
    /**
     * Credit outcomes the plugin OBSERVES on the session event stream — a
     * learned skill actually being loaded, and how the turn that loaded it
     * ended. Model-reported `outcomes` are rare in practice, and without this
     * the promotion gate is unreachable. See lib/outcome.mjs for exactly which
     * signals score and which are recorded but deliberately neutral.
     */
    observeOutcomes: bool(raw.observeOutcomes, true),

    logLevel: ['debug', 'info', 'warn', 'error'].includes(raw.logLevel) ? raw.logLevel : 'info',
  }

  return { config, warnings }
}
