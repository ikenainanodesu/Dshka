/**
 * Scoring, deduplication and the repeat-task KPI metric.
 *
 * Everything here is deliberately mechanical — no embeddings, no model calls.
 * The retrieval goal is "small and accurate": coverage of the current task's
 * vocabulary, gated by a hard environment filter so a Windows-only lesson can
 * never be offered on Linux.
 */

import { jaccard, recencyFactor, tokenize, truncate, MS_DAY } from './util.mjs'

/** Record types that carry a reusable procedure and therefore get an env gate. */
export const ENV_GATED_TYPES = new Set(['skill', 'failure', 'validation'])

/** Extract the full keyword set of one record (title, tags, summary, body). */
export function keywordsFor(record) {
  if (Array.isArray(record.keywords) && record.keywords.length > 0) return new Set(record.keywords)
  const parts = [record.title ?? '', record.summary ?? '']
  if (Array.isArray(record.applies?.tags)) parts.push(record.applies.tags.join(' '))
  const body = record.body ?? {}
  for (const value of Object.values(body)) {
    if (typeof value === 'string') parts.push(value)
    else if (Array.isArray(value)) parts.push(value.filter((v) => typeof v === 'string').join(' '))
  }
  return tokenize(parts.join(' \n '))
}

/** Persist the derived keyword set onto a record so scoring stays cheap. */
export function stampKeywords(record) {
  const tokens = [...keywordsFor(record)].slice(0, 64)
  record.keywords = tokens
  return record
}

/**
 * The environment facts a record is judged against.
 * @param {object} facts - `{ platform, shell, runtime, project, projectKey }`.
 */
export function envContext(facts) {
  return {
    platform: (facts?.platform ?? '').toLowerCase() || undefined,
    shell: (facts?.shell ?? '').toLowerCase() || undefined,
    runtime: (facts?.runtime ?? '').toLowerCase() || undefined,
    project: facts?.project ?? undefined,
    projectKey: facts?.projectKey ?? undefined,
  }
}

/**
 * Hard gate + soft penalty for one record against the current environment.
 * @returns {{ accepted: boolean, factor: number, reason: string }}
 */
export function environmentFit(record, env) {
  const applies = record.applies ?? {}
  if (ENV_GATED_TYPES.has(record.type) || record.type === 'memory') {
    const platform = typeof applies.platform === 'string' ? applies.platform.toLowerCase() : ''
    if (platform !== '' && env.platform && platform !== env.platform) {
      return { accepted: false, factor: 0, reason: `platform ${platform} != ${env.platform}` }
    }
    const shell = typeof applies.shell === 'string' ? applies.shell.toLowerCase() : ''
    if (shell !== '' && env.shell && shell !== env.shell) {
      return { accepted: false, factor: 0, reason: `shell ${shell} != ${env.shell}` }
    }
  }
  let factor = 1
  const reason = []
  const runtime = typeof applies.runtime === 'string' ? applies.runtime.toLowerCase() : ''
  if (runtime !== '' && env.runtime && runtime !== env.runtime) {
    factor *= 0.5
    reason.push(`runtime ${runtime} != ${env.runtime}`)
  }
  if (typeof applies.project === 'string' && applies.project !== '' && env.project && applies.project !== env.project) {
    factor *= 0.3
    reason.push(`project ${applies.project} != ${env.project}`)
  }
  return { accepted: true, factor, reason: reason.join('; ') }
}

/** Success ratio with a prior, so an unused record is not scored as perfect. */
export function reliability(record) {
  const ok = record.successCount ?? 0
  const bad = record.failureCount ?? 0
  if (ok + bad === 0) return 0.5
  // Laplace-smoothed.
  return (ok + 1) / (ok + bad + 2)
}

/**
 * Satiation constant for the overlap term.
 *
 * Plain query coverage (`|query ∩ record| / |query|`) is the obvious relevance
 * measure and it is WRONG for this system: a detailed multi-paragraph task
 * prompt has a large token set, so a record that matches several of its
 * meaningful tokens can still score a tiny fraction and be filtered out.
 *
 * Relevance therefore mixes a SATURATING function of the raw overlap count
 * (1 hit → 0.25, 3 → 0.5, 8 → 0.73) with Jaccard precision, so it is stable
 * across query lengths. The absolute floor that keeps a single chance word from
 * qualifying is `minOverlap` in {@link rankRecords}, not a fraction.
 */
const OVERLAP_SATURATION = 3

/** Number of shared tokens between two sets. */
export function overlapCount(a, b) {
  let hits = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const item of small) if (large.has(item)) hits++
  return hits
}

function saturation(hits) {
  return hits / (hits + OVERLAP_SATURATION)
}

/**
 * Score one record against a query.
 * @param {object} record - store record.
 * @param {object} query - `{ tokens: Set<string>, env, now, weights, recencyHalfLifeMs }`.
 * @returns {{ record, score, relevance, overlap, envFactor, accepted, reason }}
 */
export function scoreRecord(record, query) {
  const fit = environmentFit(record, query.env)
  if (!fit.accepted) {
    return { record, score: 0, relevance: 0, overlap: 0, envFactor: 0, accepted: false, reason: fit.reason }
  }
  if (record.status === 'deprecated') {
    return { record, score: 0, relevance: 0, overlap: 0, envFactor: fit.factor, accepted: false, reason: 'deprecated' }
  }

  const tokens = keywordsFor(record)
  const overlap = overlapCount(query.tokens, tokens)
  const relevance = 0.65 * saturation(overlap) + 0.35 * jaccard(query.tokens, tokens)

  const confidence = record.status === 'verified' ? Math.max(record.confidence, 0.6) : record.confidence
  const recency = recencyFactor(Date.parse(record.updatedAt ?? record.createdAt ?? ''), query.now, query.recencyHalfLifeMs)
  const reliabilityScore = reliability(record)

  const weights = query.weights
  const total = weights.relevance + weights.confidence + weights.environment + weights.recency + weights.reliability
  const raw =
    weights.relevance * relevance +
    weights.confidence * confidence +
    weights.environment * fit.factor +
    weights.recency * recency +
    weights.reliability * reliabilityScore

  let score = total > 0 ? raw / total : 0
  if (record.pinned) score = Math.min(1, score + 0.15)
  return { record, score, relevance, overlap, envFactor: fit.factor, accepted: true, reason: fit.reason }
}

/**
 * Rank a candidate set.
 * @param {object[]} records - visible records.
 * @param {object} query - see {@link scoreRecord}.
 * @param {object} options - `{ limit, minScore, minRelevance, minOverlap, types }`.
 * @returns {object[]} accepted hits, best first.
 */
export function rankRecords(records, query, options = {}) {
  const limit = options.limit ?? 6
  const minScore = options.minScore ?? 0
  const minRelevance = options.minRelevance ?? 0.2
  /** Two shared meaningful tokens; one is too often a coincidence. */
  const minOverlap = options.minOverlap ?? 2
  const types = options.types ? new Set(options.types) : undefined
  const hits = []
  for (const record of records) {
    if (types && !types.has(record.type)) continue
    const scored = scoreRecord(record, query)
    if (!scored.accepted) continue
    if (scored.overlap < minOverlap) continue
    if (scored.relevance < minRelevance) continue
    if (scored.score < minScore) continue
    hits.push(scored)
  }
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return String(a.record.id).localeCompare(String(b.record.id))
  })
  return hits.slice(0, limit)
}

/** Build the query object used by {@link rankRecords} from raw task text. */
export function makeQuery({ text, env, config, now = Date.now(), extraText = '' }) {
  return {
    tokens: tokenize(`${text}\n${extraText}`),
    env,
    now,
    weights: config.weights,
    recencyHalfLifeMs: config.recencyHalfLifeDays * MS_DAY,
  }
}

// ── dedupe / conflict ────────────────────────────────────────────────────────

export const MERGE_SIMILARITY = 0.72
export const CONFLICT_SIMILARITY = 0.4

/** Text similarity used for dedupe: same-slot title+summary keyword overlap. */
export function similarity(a, b) {
  const left = tokenize(`${a.title ?? ''} ${a.summary ?? ''}`)
  const right = tokenize(`${b.title ?? ''} ${b.summary ?? ''}`)
  const direct = jaccard(left, right)
  // A record that supersedes/merges is by definition about the same thing.
  if (a.supersedes && (a.supersedes === b.id)) return 1
  if (b.supersedes && (b.supersedes === a.id)) return 1
  return direct
}

/**
 * Find the closest existing record in the same type + scope slot.
 * @param {object[]} records - candidate records.
 * @param {object} incoming - the record about to be written.
 * @returns {{ best: object|undefined, score: number, rivals: object[] }}
 */
export function closestMatch(records, incoming) {
  let best
  let bestScore = 0
  const rivals = []
  for (const record of records) {
    if (record.id === incoming.id) continue
    if (record.type !== incoming.type) continue
    if (record.scope.level !== incoming.scope.level) continue
    if (record.status === 'deprecated') continue
    const score = similarity(incoming, record)
    if (score > bestScore) {
      best = record
      bestScore = score
    }
    if (score >= CONFLICT_SIMILARITY) rivals.push({ record, score })
  }
  rivals.sort((a, b) => b.score - a.score)
  return { best, score: bestScore, rivals }
}

const LIST_FIELDS = new Set(['preconditions', 'steps', 'validation', 'failureHandling', 'pitfalls', 'rollback', 'examples', 'signals'])

const normalizeItem = (value) => String(value).trim().toLowerCase()

/**
 * Fold `incoming` into `target` in place and return a change summary.
 * The target keeps its id — the whole point of merging is that a refined
 * procedure is the SAME skill, not a v2 copy.
 *
 * List fields have three merge modes, chosen to never lose a step silently:
 *
 *  - the incoming list is a SUPERSET of the stored one (`existing ⊂ incoming`):
 *    nothing is lost, so the incoming ORDER is adopted. This is how "check DNS
 *    first" moves a step to the front, or inserts one in the middle.
 *  - the incoming list is a SUBSET: taking it literally would delete steps a
 *    restatement merely omitted, so it is refused unless the entry explicitly
 *    declares `replaceLists: true`.
 *  - otherwise: new items are appended and nothing is removed.
 *
 * @param {object} target - the stored record to refine.
 * @param {object} incoming - the newly distilled record.
 * @param {{ replaceLists?: boolean }} [options] - caller intent.
 * @returns {{ added: string[], keptScalars: string[], version: number }}
 */
export function mergeRecord(target, incoming, options = {}) {
  const replaceLists = options.replaceLists === true
  const added = []
  const keptScalars = []
  target.body = target.body ?? {}
  for (const [field, value] of Object.entries(incoming.body ?? {})) {
    if (LIST_FIELDS.has(field) && Array.isArray(value)) {
      const existing = Array.isArray(target.body[field]) ? target.body[field] : []
      const existingSet = new Set(existing.map(normalizeItem))
      const incomingSet = new Set(value.map(normalizeItem))
      const isSuperset = existing.every((item) => incomingSet.has(normalizeItem(item)))
      const isSubset = value.every((item) => existingSet.has(normalizeItem(item)))
      const novel = value.filter((item) => !existingSet.has(normalizeItem(item)))

      if (existing.length === 0) {
        target.body[field] = [...value]
        for (const item of value) added.push(`${field}: ${truncate(item, 80)}`)
        continue
      }
      if (isSuperset) {
        const reordered = existing.some((item, index) => normalizeItem(item) !== normalizeItem(value[index] ?? ''))
        target.body[field] = [...value]
        if (reordered) added.push(`${field} (reordered: ${value.length} items)`)
        for (const item of novel) added.push(`${field}: ${truncate(item, 80)}`)
        continue
      }
      if (isSubset && replaceLists) {
        const dropped = existing.filter((item) => !incomingSet.has(normalizeItem(item)))
        target.body[field] = [...value]
        added.push(`${field} (replaced: ${value.length} kept, ${dropped.length} dropped)`)
        for (const item of dropped) added.push(`${field} dropped: ${truncate(item, 80)}`)
        continue
      }
      const union = [...existing]
      for (const item of novel) {
        union.push(item)
        added.push(`${field}: ${truncate(item, 80)}`)
      }
      if (novel.length > 0) target.body[field] = union
      if (isSubset && !replaceLists) keptScalars.push(`${field} (incoming omitted ${existing.length - value.length} stored item(s); kept)`)
      continue
    }
    if (typeof value === 'string') {
      const current = target.body[field]
      if (typeof current !== 'string' || current.trim() === '') {
        target.body[field] = value
        added.push(`${field} (filled)`)
      } else if (current.trim() !== value.trim()) {
        // A scalar the model restated differently: keep the longer, more
        // specific wording and record it, rather than silently overwriting.
        if (value.length > current.length) {
          target.body[field] = value
          added.push(`${field} (expanded)`)
        } else {
          keptScalars.push(field)
        }
      }
    }
  }
  if (incoming.summary && incoming.summary.length > (target.summary?.length ?? 0)) {
    target.summary = incoming.summary
    added.push('summary (expanded)')
  }
  target.confidence = Math.max(target.confidence, incoming.confidence)
  target.evidence = [...(target.evidence ?? []), ...(incoming.evidence ?? [])].slice(-20)
  target.applies = { ...target.applies, ...incoming.applies }
  if (Array.isArray(incoming.applies?.tags)) {
    target.applies.tags = [...new Set([...(target.applies.tags ?? []), ...incoming.applies.tags])]
  }
  target.keywords = [...new Set([...(target.keywords ?? []), ...(incoming.keywords ?? [])])].slice(0, 64)
  target.version = (target.version ?? 1) + 1
  target.updatedAt = incoming.updatedAt ?? target.updatedAt
  return { added, keptScalars, version: target.version }
}

// ── repeat-task KPI metric ───────────────────────────────────────────────────

/**
 * A request needs at least this many meaningful tokens to be comparable at all.
 *
 * Below it there is nothing to identify the task by. The important case is a
 * SHORT REPLY — a multiple-choice answer such as "C", or "好" — which is a
 * completely legitimate request but carries no identifying wording of its own.
 * Such a turn is only comparable through its RESOLVED form (the question it
 * answered plus the reply), which the recorder stores as `askContext`; without
 * that, grouping them would merge unrelated answers and produce a first/later
 * comparison that means nothing.
 */
const MIN_TASK_TOKENS = 3

/**
 * Two requests are the same task when their FULL token sets overlap this much.
 *
 * Compared against the whole set rather than a truncated signature, because a
 * signature built from a handful of alphabetically-first tokens is dominated by
 * shared boilerplate. Different subagent tasks can share the same workspace
 * preamble without being comparable repetitions.
 */
const TASK_CLUSTER_SIMILARITY = 0.5

/**
 * Vocabulary signature of a turn's request, for display and for cheap tests.
 * Returns '' when the request is too short to be comparable.
 */
export function taskSignature(episode, size = 6) {
  const tokens = [...tokenize(episode?.ask ?? '')]
    .filter((token) => token.length > 1)
    .sort()
  if (tokens.length < MIN_TASK_TOKENS) return ''
  return tokens.slice(0, size).join('+')
}

/**
 * Compare first-run and later tool-call counts for vocabulary-matched tasks.
 * This descriptive metric does not prove equal difficulty, outcome quality,
 * or a causal improvement from experience reuse.
 *
 * Grouping is deliberately conservative, because a KPI that invents repeats is
 * worse than no KPI:
 *   - requests with fewer than {@link MIN_TASK_TOKENS} tokens are skipped, not
 *     lumped together;
 *   - requests are clustered by full-set Jaccard, not by a truncated signature;
 *   - clustering never crosses workspaces — the same words in another project
 *     are a different task, and its tool-call counts are not comparable.
 *
 * @param {object[]} episodes - journal entries, oldest first.
 * @param {{ askCap?: number }} [options] - `askCap` is the recorder's
 *   `episodeAskChars`: a stored ask that reached the cap was truncated, and its
 *   surviving prefix is usually boilerplate shared with unrelated tasks, so it
 *   cannot identify a task. Omitted, only the `askTruncated` flag is honoured.
 * @returns {object} per-cluster and aggregate comparison, plus what was skipped.
 */
export function computeRepeatMetric(episodes, options = {}) {
  const analysed = []
  let skippedShort = 0
  let skippedTruncated = 0
  for (const episode of episodes ?? []) {
    if (!episode || typeof episode.toolCallCount !== 'number') continue
    const capped = options.askCap !== undefined && (episode.ask ?? '').length >= options.askCap
    if (episode.askTruncated === true || capped) {
      skippedTruncated += 1
      continue
    }
    // Identify the turn by its RESOLVED request when one was recorded: for a
    // short reply that is "the question it answered + the reply", which is the
    // only form in which a one-letter answer identifies a task.
    const requestText = episode.askContext || episode.ask || ''
    const tokens = tokenize(requestText)
    if (tokens.size < MIN_TASK_TOKENS) {
      skippedShort += 1
      continue
    }
    analysed.push({ episode, tokens, cwd: String(episode.cwd ?? '') })
  }

  const clusters = []
  for (const item of analysed) {
    let best
    let bestSimilarity = 0
    for (const cluster of clusters) {
      if (cluster.cwd !== item.cwd) continue
      const similarity = jaccard(item.tokens, cluster.representative)
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity
        best = cluster
      }
    }
    if (best !== undefined && bestSimilarity >= TASK_CLUSTER_SIMILARITY) {
      best.items.push(item.episode)
    } else {
      clusters.push({ cwd: item.cwd, representative: item.tokens, items: [item.episode] })
    }
  }

  const rows = []
  let firstTotal = 0
  let laterTotal = 0
  let laterCount = 0
  let groupsConsidered = 0
  for (const cluster of clusters) {
    if (cluster.items.length < 2) continue
    groupsConsidered++
    const ordered = [...cluster.items].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
    const first = ordered[0]
    const later = ordered.slice(1)
    const firstCalls = first.toolCallCount
    const laterAvg = later.reduce((sum, episode) => sum + episode.toolCallCount, 0) / later.length
    firstTotal += firstCalls
    laterTotal += later.reduce((sum, episode) => sum + episode.toolCallCount, 0)
    laterCount += later.length
    rows.push({
      signature: taskSignature(ordered[ordered.length - 1]),
      runs: ordered.length,
      workspace: cluster.cwd,
      firstToolCalls: firstCalls,
      laterAverageToolCalls: Number(laterAvg.toFixed(2)),
      delta: Number((laterAvg - firstCalls).toFixed(2)),
      // A one-letter answer is meaningless in a report; say so and show the
      // resolved question instead.
      isReply: Boolean(ordered[ordered.length - 1].askContext),
      example: truncate(
        ordered[ordered.length - 1].askContext || ordered[ordered.length - 1].ask || '',
        90,
      ),
    })
  }
  rows.sort((a, b) => a.delta - b.delta)
  const firstAverage = groupsConsidered > 0 ? firstTotal / groupsConsidered : 0
  const laterAverage = laterCount > 0 ? laterTotal / laterCount : 0
  return {
    episodesAnalysed: analysed.length,
    episodesSkipped: skippedShort + skippedTruncated,
    episodesSkippedShort: skippedShort,
    episodesSkippedTruncated: skippedTruncated,
    repeatedTaskGroups: groupsConsidered,
    firstRunAverageToolCalls: Number(firstAverage.toFixed(2)),
    laterRunAverageToolCalls: Number(laterAverage.toFixed(2)),
    reductionPercent: firstAverage > 0 ? Number((((firstAverage - laterAverage) / firstAverage) * 100).toFixed(1)) : 0,
    rows,
  }
}
