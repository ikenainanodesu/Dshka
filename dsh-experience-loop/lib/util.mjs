/**
 * Small dependency-free helpers: ids, tokenization, similarity, atomic file IO.
 *
 * The plugin deliberately imports no `@deepseek-ai/*` package. A locally
 * developed DSH plugin is installed as a symlink into the profile, and Node
 * resolves a symlinked module to its REAL path — from there the host packages
 * (hoisted under the profile's own node_modules) are no longer reachable. Code
 * that must run under every install shape (symlink, copy, file:// URL, npm)
 * therefore has to stay on Node builtins only. The two host helpers that would
 * otherwise be convenient are trivially replaceable, and both replacement
 * contracts are verified against the real host:
 *   - `createUserMessage` only mints `{ id: <uuid brand>, role: 'user', ... }`.
 *   - `defineTool` only compiles an author schema into raw JSON Schema, which
 *     is exactly what the registry takes (`ToolSchema.parameters`).
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export const MS_MINUTE = 60_000
export const MS_DAY = 86_400_000

/** Monotonic-ish, sortable, human-readable record id. */
export function newId(prefix = 'exp') {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}

/** Short stable hash, used for slugs and evidence digests. */
export function shortHash(value, length = 8) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length)
}

export function nowIso() {
  return new Date().toISOString()
}

export function clamp(value, lo, hi) {
  if (!Number.isFinite(value)) return lo
  return value < lo ? lo : value > hi ? hi : value
}

export function truncate(value, max, ellipsis = '…') {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  if (text.length <= max) return text
  if (max <= ellipsis.length) return text.slice(0, max)
  return `${text.slice(0, max - ellipsis.length)}${ellipsis}`
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
  return path
}

/** Read JSON tolerantly: a missing or malformed file yields `fallback`. */
export function readJson(path, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * Atomically publish a JSON document: write a sibling temp file, then rename.
 * A reader therefore never observes a half-written document, and a crashed
 * write leaves the previous document intact.
 */
export function writeJsonAtomic(path, value) {
  ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      /* the temp file may not exist; nothing to clean */
    }
    throw error
  }
}

export function writeTextAtomic(path, text) {
  ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      /* see above */
    }
    throw error
  }
}

export function appendJsonl(path, value) {
  ensureDir(dirname(path))
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8')
}

/** Read the last `limit` JSONL records, skipping any line that fails to parse. */
export function readJsonlTail(path, limit) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n')
  const out = []
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim()
    if (line === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* a torn final line is possible after a hard kill; skip it */
    }
  }
  return out.reverse()
}

/** Count non-empty lines without materializing the parse. */
export function countJsonl(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    let count = 0
    for (const line of raw.split('\n')) if (line.trim() !== '') count++
    return count
  } catch {
    return 0
  }
}

/** Sanitize an arbitrary string into a filesystem-safe single path segment. */
export function pathSlug(value, max = 80) {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (cleaned === '') return `x-${shortHash(value)}`
  const sliced = cleaned.slice(0, max).replace(/-+$/g, '')
  return sliced === '' ? `x-${shortHash(value)}` : sliced
}

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The harness's public skill-name grammar (`isSkillName`). */
export function isKebabName(value) {
  return typeof value === 'string' && KEBAB_RE.test(value)
}

/**
 * Build a valid kebab-case name from free text. Non-ASCII text (Chinese task
 * titles, for example) has no ASCII skeleton, so it falls back to a stable
 * hash-derived stem rather than producing an empty or colliding name.
 *
 * Truncation backs off to the last whole word: a name the model must type
 * should not end mid-word (`…-plugin-witho`).
 */
export function kebabFrom(text, max = 48) {
  const ascii = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (ascii.length >= 3) {
    let sliced = ascii.slice(0, max)
    if (sliced.length < ascii.length) {
      const cut = sliced.lastIndexOf('-')
      // Only give up trailing characters when the word boundary keeps most of
      // the stem; otherwise a single very long word is simply cut.
      if (cut >= Math.floor(max * 0.6)) sliced = sliced.slice(0, cut)
    }
    sliced = sliced.replace(/-+$/g, '')
    // A title whose only ASCII skeleton is one short word ("Docker 服务…")
    // would otherwise produce a name that collides with every sibling; keep the
    // word and pin it with a short source hash.
    if (sliced.length < 8) return `${sliced}-x${shortHash(text, 6)}`
    if (isKebabName(sliced)) return sliced
  }
  return `x${shortHash(text, 10)}`
}

/** Nearest ancestor directory containing `.git`; falls back to `startDir`. */
export function projectRootOf(startDir) {
  if (typeof startDir !== 'string' || startDir === '') return undefined
  let dir = resolve(startDir)
  for (let depth = 0; depth < 40; depth++) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir || parent === '') break
    dir = parent
  }
  return resolve(startDir)
}

/** Stable identifier for a project root, used as the project store directory. */
export function projectKeyOf(rootPath) {
  if (!rootPath) return undefined
  const normalized = resolve(rootPath).split(sep).join('-')
  return pathSlug(normalized, 96)
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having', 'to', 'of',
  'in', 'on', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through', 'during', 'before',
  'after', 'above', 'below', 'from', 'up', 'down', 'out', 'off', 'over', 'under', 'again', 'further', 'once',
  'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'too', 'very', 'can', 'will', 'just', 'should',
  'now', 'please', 'help', 'want', 'need', 'use', 'using', 'used', 'make', 'made', 'get', 'got', 'let', 'also',
  'it', 'its', 'as', 'my', 'me', 'we', 'our', 'you', 'your', 'i', 'he', 'she', 'they', 'them', 'his', 'her',
])

/**
 * Tokenize for keyword scoring. Latin words of length >= 2 (stopwords removed)
 * plus CJK bigrams, because a Chinese task description carries no spaces.
 */
export function tokenize(text) {
  const out = new Set()
  const raw = String(text ?? '').toLowerCase()
  for (const word of raw.match(/[a-z0-9][a-z0-9_+.#/-]*/g) ?? []) {
    const trimmed = word.replace(/^[-./]+|[-./]+$/g, '')
    if (trimmed.length < 2) continue
    if (STOPWORDS.has(trimmed)) continue
    out.add(trimmed)
  }
  const cjk = raw.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? []
  for (const run of cjk) {
    if (run.length === 1) {
      out.add(run)
      continue
    }
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2))
  }
  return out
}

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const item of small) if (large.has(item)) intersection++
  return intersection / (a.size + b.size - intersection)
}

/** Weighted overlap: how much of `query` the candidate covers (0..1). */
export function coverage(query, candidate) {
  if (query.size === 0) return 0
  let hits = 0
  for (const token of query) if (candidate.has(token)) hits++
  return hits / query.size
}

/** Decay factor for recency; `halfLifeMs` is where the factor reaches 0.5. */
export function recencyFactor(timestampMs, nowMs, halfLifeMs) {
  const age = Math.max(0, nowMs - (Number.isFinite(timestampMs) ? timestampMs : nowMs))
  return Math.pow(0.5, age / halfLifeMs)
}

export function uniqueStrings(values, max = 200) {
  const out = []
  const seen = new Set()
  for (const value of values ?? []) {
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= max) break
  }
  return out
}

/** Depth-limited plain-JSON sanitizer: drops functions, symbols, cycles. */
export function toJsonValue(value, depth = 0) {
  if (depth > 8) return undefined
  if (value === null) return null
  const type = typeof value
  if (type === 'string') return value
  if (type === 'number') return Number.isFinite(value) ? value : undefined
  if (type === 'boolean') return value
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') return undefined
  if (Array.isArray(value)) {
    const out = []
    for (const item of value.slice(0, 200)) {
      const converted = toJsonValue(item, depth + 1)
      if (converted !== undefined) out.push(converted)
    }
    return out
  }
  if (type === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      const converted = toJsonValue(item, depth + 1)
      if (converted !== undefined) out[key] = converted
    }
    return out
  }
  return undefined
}

export { dirname, join, resolve }
