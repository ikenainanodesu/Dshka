/**
 * The Experience store.
 *
 * Design goal: simple, transparent, migratable, backup-friendly — and
 * hand-editable, which is why this is a plain JSON document per scope rather
 * than a validated domain on `ctx.storageDomain`. A hand-typed record must
 * never be able to lock the whole store out (a schema-validated domain refuses
 * to open on one malformed record), and "编辑经验" is an explicit requirement.
 * The companion `digest.md` is generated for reading; the JSON is canonical.
 *
 * Layout under `storeRoot`:
 *   global/experiences.json          scope = global   (travels between projects)
 *   projects/<key>/experiences.json  scope = project  (one tree per project root)
 *   episodes.jsonl                   append-only per-turn evidence journal
 *   audit.jsonl                      append-only lifecycle audit trail
 *   state.json                       counters used by `stats` and the KPI metric
 *   digest.md                        generated human-readable summary
 *   HOW-TO-EDIT.md                   generated editing/deleting instructions
 *
 * Every write goes through `writeJsonAtomic`, so a crash never leaves a
 * half-written document. Reads are synchronous from an in-memory cache loaded
 * lazily per scope.
 */

import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  appendJsonl,
  countJsonl,
  ensureDir,
  newId,
  nowIso,
  readJson,
  readJsonlTail,
  truncate,
  writeJsonAtomic,
  writeTextAtomic,
} from './util.mjs'
import { renderDigest, renderHowToEdit } from './render.mjs'

export const RECORD_TYPES = ['memory', 'skill', 'failure', 'validation']
export const RECORD_STATUSES = ['candidate', 'verified', 'deprecated']
export const STORE_VERSION = 1

/** Canonical empty body per record type — the fields the model may fill. */
export const BODY_FIELDS = {
  memory: ['fact', 'details'],
  skill: [
    'purpose',
    'trigger',
    'preconditions',
    'environment',
    'steps',
    'validation',
    'failureHandling',
    'pitfalls',
    'rollback',
    'examples',
  ],
  failure: ['attempted', 'symptom', 'cause', 'avoidance'],
  validation: ['target', 'signals', 'negativeCase'],
}

function emptyDocument(scope, projectKey) {
  return {
    version: STORE_VERSION,
    scope,
    project: projectKey ?? null,
    updatedAt: nowIso(),
    note: 'Canonical Experience Loop store. Edit by hand only while dsh is stopped, or prefer `/experience`.',
    records: [],
  }
}

function normalizeStringList(value, max = 24, maxChars = 400) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    out.push(truncate(text, maxChars))
    if (out.length >= max) break
  }
  return out
}

function normalizeBody(type, body) {
  const source = body && typeof body === 'object' ? body : {}
  const out = {}
  for (const field of BODY_FIELDS[type] ?? []) {
    const value = source[field]
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      const list = normalizeStringList(value)
      if (list.length > 0) out[field] = list
    } else if (typeof value === 'string') {
      const text = truncate(value.trim(), 4000)
      if (text !== '') out[field] = text
    }
  }
  return out
}

function normalizeApplies(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const out = {}
  for (const key of ['platform', 'shell', 'runtime', 'version', 'project', 'host']) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim() !== '') out[key] = truncate(value.trim(), 120)
  }
  const tags = normalizeStringList(raw.tags, 16, 48).map((tag) => tag.toLowerCase())
  if (tags.length > 0) out.tags = tags
  return out
}

/**
 * Build a canonical record from an already-redacted review payload entry.
 * @param {object} entry - normalized payload entry.
 * @param {object} context - `{ scope, projectPath, platform, shell, source, now }`.
 * @returns {object} a complete record.
 */
export function makeRecord(entry, context) {
  const now = context.now ?? nowIso()
  const type = RECORD_TYPES.includes(entry.type) ? entry.type : 'memory'
  const level = entry.scope === 'global' || entry.scope === 'project' ? entry.scope : context.scope
  return {
    id: entry.id && typeof entry.id === 'string' ? entry.id : newId(),
    type,
    status: RECORD_STATUSES.includes(entry.status) ? entry.status : 'candidate',
    scope: {
      level,
      project: level === 'project' ? (context.projectKey ?? null) : null,
      projectPath: level === 'project' ? (context.projectPath ?? null) : null,
    },
    title: truncate(String(entry.title ?? '').trim(), 160),
    summary: truncate(String(entry.summary ?? '').trim(), 1200),
    body: normalizeBody(type, entry.body),
    applies: normalizeApplies({ platform: context.platform, shell: context.shell, ...(entry.applies ?? {}) }),
    confidence: typeof entry.confidence === 'number' ? entry.confidence : 0.4,
    successCount: Number.isFinite(entry.successCount) ? entry.successCount : 0,
    failureCount: Number.isFinite(entry.failureCount) ? entry.failureCount : 0,
    useCount: 0,
    pinned: entry.pinned === true,
    version: 1,
    supersedes: typeof entry.supersedes === 'string' ? entry.supersedes : null,
    supersededBy: null,
    conflictsWith: [],
    evidence: Array.isArray(entry.evidence) ? entry.evidence.slice(0, 20) : [],
    source: entry.source ?? context.source ?? 'agent',
    redactions: Array.isArray(entry.redactions) ? entry.redactions.slice(0, 12) : [],
    keywords: Array.isArray(entry.keywords) ? entry.keywords.slice(0, 64) : [],
    skillName: null,
    deprecatedReason: null,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  }
}

/** Coerce whatever is on disk into a usable record without dropping user edits. */
function reviveRecord(raw, scope, projectKey) {
  const type = RECORD_TYPES.includes(raw?.type) ? raw.type : 'memory'
  const now = nowIso()
  return {
    id: typeof raw?.id === 'string' && raw.id !== '' ? raw.id : newId(),
    type,
    status: RECORD_STATUSES.includes(raw?.status) ? raw.status : 'candidate',
    scope: {
      level: raw?.scope?.level === 'global' ? 'global' : scope,
      project: raw?.scope?.level === 'global' ? null : (raw?.scope?.project ?? projectKey ?? null),
      projectPath: raw?.scope?.level === 'global' ? null : (raw?.scope?.projectPath ?? null),
    },
    title: String(raw?.title ?? '').slice(0, 400),
    summary: String(raw?.summary ?? '').slice(0, 4000),
    body: raw?.body && typeof raw.body === 'object' ? raw.body : {},
    applies: raw?.applies && typeof raw.applies === 'object' ? raw.applies : {},
    confidence: Number.isFinite(raw?.confidence) ? raw.confidence : 0.4,
    successCount: Number.isFinite(raw?.successCount) ? raw.successCount : 0,
    failureCount: Number.isFinite(raw?.failureCount) ? raw.failureCount : 0,
    useCount: Number.isFinite(raw?.useCount) ? raw.useCount : 0,
    pinned: raw?.pinned === true,
    version: Number.isFinite(raw?.version) ? raw.version : 1,
    supersedes: raw?.supersedes ?? null,
    supersededBy: raw?.supersededBy ?? null,
    conflictsWith: Array.isArray(raw?.conflictsWith) ? raw.conflictsWith.filter((v) => typeof v === 'string') : [],
    evidence: Array.isArray(raw?.evidence) ? raw.evidence : [],
    source: typeof raw?.source === 'string' ? raw.source : 'imported',
    redactions: Array.isArray(raw?.redactions) ? raw.redactions : [],
    keywords: Array.isArray(raw?.keywords) ? raw.keywords : [],
    skillName: typeof raw?.skillName === 'string' ? raw.skillName : null,
    deprecatedReason: typeof raw?.deprecatedReason === 'string' ? raw.deprecatedReason : null,
    createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : now,
    lastUsedAt: typeof raw?.lastUsedAt === 'string' ? raw.lastUsedAt : null,
  }
}

export class ExperienceStore {
  /**
   * @param {object} options - `{ root, logger }`.
   */
  constructor({ root, logger }) {
    this.root = root
    this.logger = logger
    /** @type {Map<string, {path: string, records: Map<string, object>, loaded: boolean}>} */
    this.scopes = new Map()
    this.dirty = new Set()
    this.episodeCount = null
    /**
     * The project most recently seen by the plugin. It is the default
     * destination for a project-scoped record and the second half of the
     * retrieval view. Set from the agent's session header on every hook.
     */
    this.lastProjectKey = undefined
    this.lastProjectPath = undefined
  }

  /** Remember which project the current activity belongs to. */
  setProject(projectKey, projectPath) {
    if (projectKey) this.lastProjectKey = projectKey
    if (projectPath) this.lastProjectPath = projectPath
  }

  // ── paths ──────────────────────────────────────────────────────────────────

  get globalDir() {
    return join(this.root, 'global')
  }

  projectDir(projectKey) {
    return join(this.root, 'projects', projectKey ?? '_unscoped')
  }

  fileFor(level, projectKey) {
    return level === 'global'
      ? join(this.globalDir, 'experiences.json')
      : join(this.projectDir(projectKey), 'experiences.json')
  }

  get episodesPath() {
    return join(this.root, 'episodes.jsonl')
  }

  get auditPath() {
    return join(this.root, 'audit.jsonl')
  }

  get statePath() {
    return join(this.root, 'state.json')
  }

  get digestPath() {
    return join(this.root, 'digest.md')
  }

  // ── scope loading ──────────────────────────────────────────────────────────

  scopeState(level, projectKey) {
    const key = `${level}::${projectKey ?? ''}`
    let state = this.scopes.get(key)
    if (state) return state
    const path = this.fileFor(level, projectKey)
    state = { key, level, projectKey: projectKey ?? null, path, records: new Map(), loaded: false }
    this.scopes.set(key, state)
    return state
  }

  loadScope(level, projectKey) {
    const state = this.scopeState(level, projectKey)
    if (state.loaded) return state
    state.loaded = true
    if (!existsSync(state.path)) return state
    const document = readJson(state.path, undefined)
    if (document === undefined) {
      this.logger?.warn?.('%s: store document %s is unreadable; starting from an empty view of it', 'experience-loop', state.path)
      return state
    }
    const records = Array.isArray(document?.records) ? document.records : []
    for (const raw of records) {
      const record = reviveRecord(raw, level, projectKey)
      if (record.scope.level === 'global') {
        // A record physically filed under a project but marked global belongs to
        // the global view; re-home it so both views agree with the file.
        const globalState = this.scopeState('global', undefined)
        if (globalState !== state && !globalState.records.has(record.id)) globalState.records.set(record.id, record)
        if (globalState === state) state.records.set(record.id, record)
        continue
      }
      state.records.set(record.id, record)
    }
    return state
  }

  /** All records visible from one project context (global first, then project). */
  all(projectKey) {
    const out = [...this.loadScope('global', undefined).records.values()]
    if (projectKey) out.push(...this.loadScope('project', projectKey).records.values())
    return out
  }

  find(id) {
    if (typeof id !== 'string' || id === '') return undefined
    const direct = this.loadScope('global', undefined).records.get(id)
    if (direct) return direct
    for (const state of this.scopes.values()) {
      const hit = state.records.get(id)
      if (hit) return hit
    }
    return undefined
  }

  /** Look up by exact id, then by unique id prefix, then by exact skill name. */
  resolve(idOrName) {
    if (typeof idOrName !== 'string' || idOrName === '') return undefined
    const exact = this.find(idOrName)
    if (exact) return exact
    const candidates = []
    for (const record of this.all(this.lastProjectKey)) {
      if (record.id.startsWith(idOrName) || record.skillName === idOrName) candidates.push(record)
      if (candidates.length > 1) break
    }
    if (candidates.length === 1) return candidates[0]
    for (const state of this.scopes.values()) {
      for (const record of state.records.values()) {
        if (record.skillName === idOrName && !candidates.includes(record)) candidates.push(record)
      }
    }
    return candidates.length === 1 ? candidates[0] : undefined
  }

  // ── mutation ───────────────────────────────────────────────────────────────

  put(record) {
    const level = record.scope.level === 'global' ? 'global' : 'project'
    const projectKey = level === 'project' ? (record.scope.project ?? this.lastProjectKey) : undefined
    if (level === 'project' && !projectKey) {
      // Without a project identity a project-scoped record has no home; the
      // global scope is the only correct destination.
      record.scope.level = 'global'
      record.scope.project = null
      record.scope.projectPath = null
      return this.put(record)
    }
    const state = this.loadScope(level, projectKey)
    state.records.set(record.id, record)
    this.dirty.add(state.key)
    return record
  }

  remove(id) {
    let removed
    for (const state of this.scopes.values()) {
      const record = state.records.get(id)
      if (!record) continue
      state.records.delete(id)
      this.dirty.add(state.key)
      removed = record
    }
    return removed
  }

  markDirty(level, projectKey) {
    this.dirty.add(this.scopeState(level, projectKey).key)
  }

  flush() {
    for (const key of this.dirty) {
      const state = this.scopes.get(key)
      if (!state) continue
      const records = [...state.records.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      writeJsonAtomic(state.path, {
        version: STORE_VERSION,
        scope: state.level,
        project: state.projectKey,
        updatedAt: nowIso(),
        note: 'Canonical Experience Loop store. Prefer `/experience` over hand edits.',
        counts: records.length,
        records,
      })
    }
    this.dirty.clear()
    this.writeDigest()
  }

  writeDigest() {
    try {
      const records = this.all(this.lastProjectKey)
      const state = this.readState()
      writeTextAtomic(this.digestPath, renderDigest(records, state, this.root))
      ensureDir(this.root)
      const howTo = join(this.root, 'HOW-TO-EDIT.md')
      if (!existsSync(howTo)) writeTextAtomic(howTo, renderHowToEdit(this.root))
    } catch (error) {
      this.logger?.warn?.('experience-loop: digest write failed: %s', error?.message ?? error)
    }
  }

  // ── counters ───────────────────────────────────────────────────────────────

  readState() {
    const state = readJson(this.statePath, undefined)
    return {
      injections: 0,
      injectionChars: 0,
      reviews: 0,
      recordsCreated: 0,
      recordsUpdated: 0,
      recordsMerged: 0,
      recordsRejected: 0,
      secretsRedacted: 0,
      conflictsSeen: 0,
      outcomesSuccess: 0,
      outcomesFailure: 0,
      episodes: 0,
      firstSeenAt: nowIso(),
      ...(state && typeof state === 'object' ? state : {}),
    }
  }

  /** Apply an atomic counter delta and persist. */
  bumpCounters(delta) {
    const state = this.readState()
    for (const [key, value] of Object.entries(delta)) {
      if (typeof value === 'number') state[key] = (Number.isFinite(state[key]) ? state[key] : 0) + value
    }
    try {
      writeJsonAtomic(this.statePath, state)
    } catch (error) {
      this.logger?.warn?.('experience-loop: state write failed: %s', error?.message ?? error)
    }
    return state
  }

  // ── episodes (evidence journal) ────────────────────────────────────────────

  appendEpisode(episode) {
    try {
      appendJsonl(this.episodesPath, episode)
      this.episodeCount = (this.episodeCount ?? countJsonl(this.episodesPath)) + 1
      this.bumpCounters({ episodes: 1 })
    } catch (error) {
      this.logger?.warn?.('experience-loop: episode append failed: %s', error?.message ?? error)
    }
  }

  recentEpisodes(limit = 50) {
    return readJsonlTail(this.episodesPath, limit)
  }

  /**
   * Unreviewed episodes, newest first, optionally limited to one session.
   * Episodes older than the retained window are simply gone; they were already
   * offered to the model on the turn after they were written.
   */
  pendingEpisodes(limit = 20, sessionId) {
    const all = readJsonlTail(this.episodesPath, 5000)
    const out = []
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const episode = all[i]
      if (episode?.reviewedAt) continue
      if (sessionId && episode.sessionId !== sessionId) continue
      out.push(episode)
    }
    return out
  }

  /** Mark episodes reviewed and link them to the records they produced. */
  markEpisodesReviewed(episodeIds, recordIds, when = nowIso()) {
    if (!Array.isArray(episodeIds) || episodeIds.length === 0) return 0
    const wanted = new Set(episodeIds)
    const all = readJsonlTail(this.episodesPath, 5000)
    let changed = 0
    const lines = []
    for (const episode of all) {
      if (wanted.has(episode.id) && !episode.reviewedAt) {
        episode.reviewedAt = when
        episode.recordIds = [...new Set([...(episode.recordIds ?? []), ...(recordIds ?? [])])]
        changed++
      }
      lines.push(JSON.stringify(episode))
    }
    if (changed === 0) return 0
    try {
      ensureDir(dirname(this.episodesPath))
      writeTextAtomic(this.episodesPath, `${lines.join('\n')}\n`)
    } catch (error) {
      this.logger?.warn?.('experience-loop: episode rewrite failed: %s', error?.message ?? error)
      return 0
    }
    return changed
  }

  // ── audit ──────────────────────────────────────────────────────────────────

  audit(entry) {
    try {
      appendJsonl(this.auditPath, { at: nowIso(), ...entry })
    } catch (error) {
      this.logger?.warn?.('experience-loop: audit append failed: %s', error?.message ?? error)
    }
  }

  recentAudit(limit = 40) {
    return readJsonlTail(this.auditPath, limit)
  }

  // ── maintenance ────────────────────────────────────────────────────────────

  /** Delete every project-scoped record for one project key; returns the count. */
  forgetProject(projectKey) {
    const count = this.loadScope('project', projectKey).records.size
    const state = this.scopeState('project', projectKey)
    state.records.clear()
    // Drop the pending write for this scope before removing its document, so a
    // later flush cannot resurrect the records we just deleted.
    this.dirty.delete(state.key)
    const path = this.fileFor('project', projectKey)
    if (existsSync(path)) {
      try {
        unlinkSync(path)
      } catch (error) {
        this.logger?.warn?.('experience-loop: could not remove %s: %s', path, error?.message ?? error)
      }
    } else {
      try {
        rmSync(this.projectDir(projectKey), { recursive: true, force: true })
      } catch {
        /* nothing to remove */
      }
    }
    return count
  }

  projects() {
    const out = []
    if (!existsSync(join(this.root, 'projects'))) return out
    for (const state of this.scopes.values()) {
      if (state.level === 'project' && state.records.size > 0) {
        out.push({ project: state.projectKey, count: state.records.size })
      }
    }
    return out
  }

  readRawProjectDocument(projectKey) {
    const path = this.fileFor('project', projectKey)
    if (!existsSync(path)) return undefined
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  }
}

export { truncate }
