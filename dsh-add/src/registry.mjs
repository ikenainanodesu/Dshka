/**
 * Registry access for `dsh-add`.
 *
 * The community registry at awesome-dsh-plugin.com publishes one JSON document
 * in which every entry already carries the exact install command its author
 * intends (`dsh plugin --profile web add <spec>`). That field is the source of
 * truth for installing: this module never invents an install spec, it only
 * reads what the registry declares.
 *
 * Entries are large (4.4 MB / ~4.3k plugins as of 2026-09-24), so the raw
 * payload is cached on disk and reused until `maxAgeMs` elapses. A failed
 * refresh falls back to a stale cache rather than failing the command.
 *
 * @module dsh-add/registry
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Default registry document. */
export const REGISTRY_URL = 'https://awesome-dsh-plugin.com/plugins.json';

/** Default cache lifetime: 12 hours. */
export const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Cache directories this process found unwritable. */
const unwritable = new Set();

/**
 * Resolve the cache file path.
 *
 * Preference order: `$DSH_ADD_CACHE` (exact file), `$DSH_ADD_CACHE_DIR`,
 * `$DSH_HOME/cache/dsh-add`, `~/.dsh/cache/dsh-add`. A cache directory that
 * already proved unwritable in this session (a sandboxed home) drops to the
 * system temporary directory instead of failing on every run.
 * @param env - environment mapping.
 * @returns absolute cache file path.
 */
export function cachePath(env = process.env) {
  if (env.DSH_ADD_CACHE?.trim()) return env.DSH_ADD_CACHE;
  const base = env.DSH_ADD_CACHE_DIR?.trim()
    ? env.DSH_ADD_CACHE_DIR
    : join(env.DSH_HOME?.trim() ? env.DSH_HOME : join(homedir(), '.dsh'), 'cache', 'dsh-add');
  if (unwritable.has(base)) return join(tmpdir(), 'dsh-add', 'plugins.json');
  return join(base, 'plugins.json');
}

/**
 * Write the cache, remembering an unwritable directory.
 * @param file - cache file path.
 * @param document - the registry document.
 */
function saveCache(file, document) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(document));
  } catch {
    // Losing the cache costs one download, never correctness: remember the
    // directory and fall back to the temp dir on the next run.
    unwritable.add(dirname(file));
  }
}

/**
 * Read the cache file if it exists and is fresh enough.
 * @param file - cache file path.
 * @param maxAgeMs - maximum accepted age in milliseconds; `0` disables the age check.
 * @returns the parsed document, or undefined when absent/stale/unparsable.
 */
export function readCache(file, maxAgeMs) {
  try {
    const stat = statSync(file);
    if (maxAgeMs > 0 && Date.now() - stat.mtimeMs > maxAgeMs) return undefined;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.plugins) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch the registry document over HTTPS.
 * @param options - `url`, `timeoutMs`, and an optional `fetchImpl` for tests.
 * @returns the parsed document.
 * @throws when the response is not OK, times out, or is not the expected shape.
 */
export async function fetchRegistry({ url = REGISTRY_URL, timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'dsh-add', accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const document = await response.json();
    if (!Array.isArray(document?.plugins)) throw new Error('registry payload has no plugins array');
    return document;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load the registry, preferring a fresh cache and falling back to a stale one.
 *
 * Network failure is never fatal while a cache exists; the caller is told which
 * source it received so the decision is visible in the output.
 * @param options - `refresh` forces a network read, `maxAgeMs`, `url`, `env`, `log`, `fetchImpl`.
 * @returns the document plus `{ source: 'cache' | 'network', ageMs, stale }`.
 * @throws when there is no cache and the network read fails.
 */
export async function loadRegistry({
  refresh = false,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  url = REGISTRY_URL,
  env = process.env,
  log = () => {},
  fetchImpl = fetch
} = {}) {
  const file = cachePath(env);
  if (!refresh) {
    const cached = readCache(file, maxAgeMs);
    if (cached) {
      const ageMs = Date.now() - statSync(file).mtimeMs;
      return { document: cached, source: 'cache', ageMs, stale: false, file };
    }
  }
  try {
    const document = await fetchRegistry({ url, fetchImpl });
    saveCache(file, document);
    return { document, source: 'network', ageMs: 0, stale: false, file };
  } catch (error) {
    const stale = readCache(file, 0);
    if (stale) {
      log(`warning: registry refresh failed (${error.message}); using the cached copy`);
      return { document: stale, source: 'cache', ageMs: Date.now() - statSync(file).mtimeMs, stale: true, file };
    }
    throw new Error(`could not load the plugin registry from ${url}: ${error.message}`);
  }
}
