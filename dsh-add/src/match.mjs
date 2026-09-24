/**
 * Name resolution for `dsh-add`.
 *
 * Registry entries are keyed by a display `name` that is not unique: 186 name
 * collisions existed on 2026-09-24, including ten different plugins all called
 * `dsh-memory`. A resolver that silently installs the first hit therefore
 * installs the wrong plugin with a straight face. This module makes every step
 * of that decision explicit and testable: classification (exact vs fuzzy),
 * ranking (deterministic, evidence-based), and whether the winner is decisive
 * enough to install without asking.
 *
 * @module dsh-add/match
 */

/**
 * Normalize a plugin name for comparison: registry names may carry a subpath or
 * flavour suffix after `#` (`dsh-trail#bundle`, `OpenViking#examples/dsh-memory-plugin`),
 * which never matters for matching the plugin itself.
 * @param value - raw name.
 * @returns lowercase, suffix-stripped, trimmed name.
 */
export function normalizeName(value) {
  return String(value ?? '')
    .split('#')[0]
    .trim()
    .toLowerCase();
}

/**
 * The GitHub `owner/repo` tail of a registry `url`, lowercased.
 * @param url - plugin repository or page URL.
 * @returns `owner/repo`, or undefined when the URL has no such tail.
 */
export function repoSlug(url) {
  const match = /github\.com\/([^/]+)\/([^/#?]+)/i.exec(String(url ?? ''));
  if (!match) return undefined;
  return `${match[1]}/${match[2].replace(/\.git$/i, '')}`.toLowerCase();
}

/**
 * Popularity evidence, largest first. Missing numbers sort last rather than as
 * zero, so an entry with unknown downloads never outranks a measured one.
 * @param plugin - registry entry.
 * @returns a comparable tuple of numbers.
 */
function popularity(plugin) {
  const measured = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : -1);
  return [measured(plugin.downloads), measured(plugin.stars)];
}

/**
 * Rank candidates: exact classification first, then popularity, then a stable
 * tiebreak on the full spec so equal entries never swap between runs.
 * @param candidates - matched entries, each `{ plugin, exact }`.
 * @returns a new array sorted best-first.
 */
export function rankMatches(candidates) {
  return [...candidates].sort((left, right) => {
    if (left.exact !== right.exact) return left.exact ? -1 : 1;
    const a = popularity(left.plugin);
    const b = popularity(right.plugin);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return b[index] - a[index];
    }
    return specOf(left.plugin).localeCompare(specOf(right.plugin));
  });
}

/**
 * The install spec an entry declares. The registry is authoritative: its
 * `install` field is the command the author intends, and it already encodes
 * npm-vs-github and subpath choices that cannot be recomputed from `npm` alone.
 * @param plugin - registry entry.
 * @returns the spec, or undefined when the entry carries no install command.
 */
export function specOf(plugin) {
  const command = String(plugin?.install ?? '').trim();
  if (command === '') return plugin?.npm ? String(plugin.npm) : undefined;
  const match = /^dsh\s+plugin\b.*?\badd\s+(.+)$/.exec(command);
  return match ? match[1].trim() : command;
}

/**
 * Resolve a user-supplied query against registry entries.
 *
 * Exact means the query names the plugin unambiguously as written: the display
 * name, the npm package, the `owner/repo` slug, or `owner/name`. Fuzzy is a
 * last resort so `dsh-add engram` finds something without pretending it was
 * exact.
 * @param plugins - registry entries.
 * @param query - what the user typed.
 * @returns `{ exact, fuzzy, query }`, each an array of `{ plugin, exact, reason }`.
 */
export function resolveQuery(plugins, query) {
  const wanted = normalizeName(query);
  const raw = String(query ?? '').trim().toLowerCase();
  const exact = [];
  const fuzzy = [];

  for (const plugin of plugins) {
    if (!specOf(plugin)) continue;
    const name = normalizeName(plugin.name);
    const npm = String(plugin.npm ?? '').toLowerCase();
    const slug = repoSlug(plugin.url);

    if (name === wanted || raw === npm || raw === slug) {
      exact.push({ plugin, exact: true, reason: name === wanted ? 'name' : raw === npm ? 'npm' : 'repo' });
      continue;
    }
    // `owner/name` disambiguation, e.g. `kenz1117/dsh-engram`.
    if (slug === raw.replace(/^github:/, '')) {
      exact.push({ plugin, exact: true, reason: 'owner' });
      continue;
    }
    if (fuzzyScore(wanted, name) > 0 || fuzzyScore(wanted, npm) > 0) {
      fuzzy.push({ plugin, exact: false, reason: 'fuzzy' });
    }
  }

  return { exact: rankMatches(exact), fuzzy: rankMatches(fuzzy).slice(0, 10), query: raw };
}

/**
 * Cheap relevance score for substring queries; `0` means no match.
 * @param wanted - normalized query.
 * @param candidate - normalized candidate name or package name.
 * @returns 2 for a token-boundary hit, 1 for a plain substring, 0 for none.
 */
function fuzzyScore(wanted, candidate) {
  if (wanted === '' || candidate === '') return 0;
  if (!candidate.includes(wanted)) return 0;
  const boundary = candidate.startsWith(wanted) || /[/\-_.]/.test(candidate[candidate.indexOf(wanted) - 1] ?? '');
  return boundary ? 2 : 1;
}

/**
 * Decide whether the ranked winner may be installed without asking.
 *
 * The rule is evidence-based and deliberately conservative: a sole candidate is
 * always decisive; among several exact hits the leader must dominate on
 * measured downloads. A near tie, or two entries with no download data at all,
 * is reported as ambiguous so the caller can ask instead of guessing.
 * @param ranked - output of {@link resolveQuery} (or any ranked candidate list).
 * @returns `{ decisive, winner, reason, margin }`.
 */
export function decide(ranked) {
  const pool = ranked.exact.length > 0 ? ranked.exact : ranked.fuzzy;
  if (pool.length === 0) return { decisive: false, winner: undefined, reason: 'none', margin: 0 };
  const [winner, runnerUp] = pool;
  if (pool.length === 1) {
    // A fuzzy winner may only stand alone when the query names it at a token
    // boundary, so `dsh-add` finds `dsh-add-to-chat` but a bare `engram` does
    // not silently become `engramory`.
    return winner.exact
      ? { decisive: true, winner, reason: 'sole match', margin: 1 }
      : { decisive: false, winner, reason: 'only a partial match', margin: 0 };
  }
  if (!winner.exact) {
    return { decisive: false, winner, reason: 'several partial matches and nothing exact', margin: 0 };
  }
  const downloads = (entry) => (typeof entry?.plugin?.downloads === 'number' ? entry.plugin.downloads : -1);
  const top = downloads(winner);
  const next = downloads(runnerUp);
  if (top <= 0 || next < 0) {
    return { decisive: false, winner, reason: 'several exact matches with no comparable download counts', margin: 0 };
  }
  const margin = next === 0 ? Number.POSITIVE_INFINITY : top / next;
  if (margin >= 2) return { decisive: true, winner, reason: `most downloaded match (${top} vs ${next})`, margin };
  return {
    decisive: false,
    winner,
    reason: `top two exact matches are close (${top} vs ${next} downloads)`,
    margin
  };
}

/**
 * A compact one-line description for candidate lists.
 * @param plugin - registry entry.
 * @param locale - `zh` selects the Chinese description when present.
 * @returns a single-line summary.
 */
export function describe(plugin, locale = 'en') {
  const description = plugin?.description;
  const text = typeof description === 'string' ? description : (description?.[locale] ?? description?.en ?? '');
  return String(text).replace(/\s+/g, ' ').trim();
}
