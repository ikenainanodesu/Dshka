/**
 * Bridge learned Skills into the harness's OWN skill system.
 *
 * This is the main piece of reuse: rather than growing a private skill loader,
 * the plugin registers a `SkillProvider` on `ctx.skills`, so a learned skill
 * appears in the normal `<available_skills>` catalog and is loaded on demand by
 * the normal `skill` tool — with the harness's own discovery, invalidation and
 * token accounting.
 *
 * Two deliberate cost controls, both about the fact that a catalog entry is paid
 * for on EVERY request:
 *   - every non-deprecated record is listed, but an UNVERIFIED one gets a
 *     shortened description plus an explicit `[candidate]` marker. Hiding it
 *     instead would cost more than the tokens it saves: a learned skill the
 *     model cannot see is one it will never load, never exercise, and therefore
 *     never earn the evidence that would promote it. That is a deadlock, not a
 *     policy, and it was measured in production before this was changed.
 *   - descriptions are trimmed (`skillDescriptionChars` / `candidateDescriptionChars`),
 *     because the catalog's cost is (skills × description length) on EVERY request.
 */

import { skillBodyMarkdown, skillDescription } from './render.mjs'
import { projectKeyOf, projectRootOf, truncate } from './util.mjs'

export const PROVIDER_NAME = 'experience-loop'

/** Placed in front of an unverified description so the model knows what it is loading. */
export const CANDIDATE_MARKER = '[candidate - unproven] '

/**
 * Whether a record is currently reachable through the harness `skill` tool.
 *
 * Exported because the retrieval block makes a claim about this and must not
 * be allowed to guess: `dsh-tool-skill` resolves a requested name against
 * `ctx.skills.list()` and rejects anything absent, so advertising a skill that
 * fails this test is a promise the plugin cannot keep.
 *
 * `all` means every non-deprecated record. A deprecated record is never offered
 * under any mode: it was withdrawn for a reason, and continuing to hand it to
 * the model would make the lifecycle decorative.
 */
export function isExposed(record, mode) {
  if (mode === 'none') return false
  if (record.status === 'deprecated') return false
  if (mode === 'all') return true
  return record.status === 'verified'
}

/**
 * The catalog line for one record: full text for a proven skill, a shorter
 * marked one for a candidate. The marker is charged against the same budget, so
 * a candidate's total stays inside `candidateDescriptionChars`.
 */
function descriptionFor(record, config) {
  if (record.status === 'verified') return skillDescription(record, config.skillDescriptionChars)
  const room = Math.max(20, config.candidateDescriptionChars - CANDIDATE_MARKER.length)
  return CANDIDATE_MARKER + skillDescription(record, room)
}

/** Candidate for one record, in the shape the skill registry requires. */
function candidateFor(record, config) {
  return {
    name: record.skillName,
    description: descriptionFor(record, config),
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
    // Verified first, then by confidence. Ordering matters only when the cap
    // bites, and when it does it must never be a PROVEN skill that gets dropped
    // in favour of an unproven one.
    records.sort(
      (a, b) =>
        Number(b.status === 'verified') - Number(a.status === 'verified') ||
        (b.confidence ?? 0) - (a.confidence ?? 0),
    )
    return records.slice(0, config.maxExposedSkills).map((record) => candidateFor(record, config))
  }

  const provider = {
    name: PROVIDER_NAME,
    list: async (options) => listCandidates(options),
    /**
     * `dsh-tool-skill` reaches `get` by two different routes:
     *
     *   - the model's `skill` tool first resolves the requested name against
     *     `list()`, so it can only ever ask for something the catalog holds;
     *   - the human's `/skill-name` gesture in `agent/pre-step` calls `get`
     *     DIRECTLY, bypassing the catalog entirely.
     *
     * So this is the human's channel, and it is deliberately more permissive
     * than the catalog: any non-deprecated record loads by its exact name, even
     * under `exposeSkills: verified` where the catalog would not have offered
     * it. Naming a skill exactly is an explicit request, and the returned body
     * states its own status, so the human can see what they got.
     */
    get: async (candidate) => {
      const id = candidate?.locator?.id
      if (typeof id !== 'string') return undefined
      const record = store.find(id)
      if (!record || record.type !== 'skill' || record.skillName !== candidate.name) return undefined
      const byName = config.exposeSkills !== 'none' && record.status !== 'deprecated'
      if (!isExposed(record, config.exposeSkills) && !byName) return undefined
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
