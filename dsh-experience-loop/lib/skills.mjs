/**
 * Bridge learned Skills into the harness's OWN skill system.
 *
 * This is the main piece of reuse: rather than growing a private skill loader,
 * the plugin registers a `SkillProvider` on `ctx.skills`, so a learned skill
 * appears in the normal `<available_skills>` catalog and is loaded on demand by
 * the normal `skill` tool — with the harness's own discovery, invalidation and
 * token accounting.
 *
 * Two deliberate limits, both about context cost:
 *   - only records whose status passes `config.exposeSkills` are listed. A brand
 *     new candidate would otherwise sit in every request's catalog before
 *     anything had validated it.
 *   - the catalog description is trimmed to `config.skillDescriptionChars`,
 *     because the catalog's cost is (skills × description length) on EVERY
 *     request.
 */

import { skillBodyMarkdown, skillDescription } from './render.mjs'
import { projectKeyOf, projectRootOf } from './util.mjs'

export const PROVIDER_NAME = 'experience-loop'

function isExposed(record, mode) {
  if (mode === 'none') return false
  if (mode === 'all') return true
  return record.status === 'verified'
}

/** Candidate for one record, in the shape the skill registry requires. */
function candidateFor(record, config) {
  return {
    name: record.skillName,
    description: skillDescription(record, config.skillDescriptionChars),
    ...(typeof record.body?.trigger === 'string' && record.body.trigger !== ''
      ? { whenToUse: record.body.trigger.slice(0, 400) }
      : {}),
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'runtime',
    provider: PROVIDER_NAME,
    // Lower rank wins a duplicate name inside one layer. Project-scoped skills
    // are more specific than global ones, so they rank ahead of the file
    // provider's project rows (100/200) and of the user roots (400/500).
    rank: record.scope.level === 'project' ? 90 : 390,
    locator: { id: record.id },
    metadata: {
      experienceLoopId: record.id,
      status: record.status,
      confidence: record.confidence,
      scope: record.scope.level,
    },
  }
}

/**
 * Register the provider. The returned `invalidate` must be called after any
 * store change so the catalog digest is recomputed and republished.
 * @param {object} options - `{ ctx, store, config, logger }`.
 * @returns {{ invalidate: () => void, dispose: () => void }}
 */
export function registerSkillProvider({ ctx, store, config, logger }) {
  let control

  const listCandidates = (options = {}) => {
    if (config.exposeSkills === 'none') return []
    const cwd = options?.cwd
    const projectKey = cwd ? projectKeyOf(projectRootOf(cwd)) : store.lastProjectKey
    const records = store
      .all(projectKey)
      .filter((record) => record.type === 'skill' && record.skillName && isExposed(record, config.exposeSkills))
    records.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    return records.slice(0, config.maxExposedSkills).map((record) => candidateFor(record, config))
  }

  const provider = {
    name: PROVIDER_NAME,
    list: async (options) => listCandidates(options),
    get: async (candidate) => {
      const id = candidate?.locator?.id
      if (typeof id !== 'string') return undefined
      const record = store.find(id)
      if (!record || record.type !== 'skill' || record.skillName !== candidate.name) return undefined
      if (!isExposed(record, config.exposeSkills)) return undefined
      return {
        ...candidateFor(record, config),
        content: skillBodyMarkdown(record),
      }
    },
  }

  let dispose
  try {
    dispose = ctx.skills.registerProvider((registrationControl) => {
      control = registrationControl
      return provider
    })
    logger?.info?.('experience-loop: registered skill provider "%s"', PROVIDER_NAME)
  } catch (error) {
    logger?.warn?.('experience-loop: skill provider registration failed: %s', error?.message ?? error)
    dispose = () => {}
  }

  return {
    invalidate() {
      try {
        control?.invalidate?.()
      } catch (error) {
        logger?.debug?.('experience-loop: skill catalog invalidate failed: %s', error?.message ?? error)
      }
    },
    dispose,
  }
}
