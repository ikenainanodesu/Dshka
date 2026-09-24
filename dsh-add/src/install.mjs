/**
 * Installation side of `dsh-add`: pick a profile, install through the official
 * CLI, and verify the result from the profile manifest rather than from a
 * console message.
 *
 * Two rules drive the design:
 *
 * 1. `dsh-add` never re-implements installation. Every install is delegated to
 *    `dsh plugin --profile <name> add <spec>`, so pnpm resolution, the
 *    `dsh.profile.bundles` reconciliation, and the git-`prepare` guidance all
 *    keep coming from the harness itself.
 * 2. An exit code is not proof. `dsh plugin` exits 0 after a successful `pnpm`
 *    run, so verification reads the profile manifest before and after and
 *    reports what actually changed.
 *
 * @module dsh-add/install
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve `$DSH_HOME` the way the harness does: an explicit `DSH_HOME`, else `~/.dsh`.
 * @param env - environment mapping.
 * @returns absolute DSH home path.
 */
export function dshHome(env = process.env) {
  return env.DSH_HOME?.trim() ? env.DSH_HOME : join(homedir(), '.dsh');
}

/**
 * List every initialized profile (a directory with its own `package.json`).
 * @param env - environment mapping.
 * @returns sorted profile names.
 */
export function listProfiles(env = process.env) {
  const dir = join(dshHome(env), 'profiles');
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .filter((entry) => existsSync(join(dir, entry.name, 'package.json')))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read a profile manifest.
 * @param profile - profile name.
 * @param env - environment mapping.
 * @returns `{ dir, manifest }`, or undefined when the profile has no manifest.
 */
export function readProfile(profile, env = process.env) {
  const dir = join(dshHome(env), 'profiles', profile);
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return undefined;
  try {
    return { dir, manifest: JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { dir, manifest: {} };
  }
}

/**
 * Choose the profile to install into, with the reason made explicit.
 *
 * Precedence: `--profile`, then `$DSH_PROFILE`, then the only initialized
 * profile, then the profile that already has plugins installed, then `web`.
 * The single-profile-with-plugins rule is checked before the `web` name on
 * purpose: `web` is the harness default, so favouring the name would send every
 * install into a profile the user may never boot.
 * @param options - `explicit`, `env`.
 * @returns `{ profile, reason }`.
 */
export function chooseProfile({ explicit, env = process.env } = {}) {
  if (explicit) return { profile: explicit, reason: 'from --profile' };
  if (env.DSH_PROFILE?.trim()) return { profile: env.DSH_PROFILE.trim(), reason: 'from $DSH_PROFILE' };
  const names = listProfiles(env);
  if (names.length === 0) return { profile: 'web', reason: 'the default web profile (no profile is initialized yet)' };
  if (names.length === 1) return { profile: names[0], reason: `the only initialized profile (${names[0]})` };
  const withPlugins = names.filter((name) =>
    Object.keys(readProfile(name, env)?.manifest?.dependencies ?? {}).length > 0
  );
  if (withPlugins.length === 1) {
    return { profile: withPlugins[0], reason: `the only profile with plugins installed (${withPlugins[0]})` };
  }
  if (withPlugins.length === 0) {
    if (names.includes('web')) return { profile: 'web', reason: 'the default web profile (no profile has plugins yet)' };
    return { profile: names[0], reason: `the first profile (of ${names.join(', ')})` };
  }
  if (withPlugins.includes('web')) {
    return { profile: 'web', reason: `the web profile, one of the profiles with plugins (${withPlugins.join(', ')})` };
  }
  return {
    profile: withPlugins[0],
    reason: `the first profile with plugins, of ${withPlugins.join(', ')} — use --profile to override`
  };
}

/**
 * Whether a profile manifest already declares a dependency.
 *
 * The spec may be anything pnpm accepts: an npm name, a git spec, or a local
 * path. pnpm records the *resolved package name*, so a spec has to be reduced
 * to its probable package name before it can be compared — a path install of
 * `D:\work\my-plugin` lands in `dependencies` as `my-plugin`.
 * @param names - the declared dependency names, or a `{ dependencies }` manifest.
 * @param spec - an npm name, a package name, or an install spec.
 * @returns the matching declared name, or undefined.
 */
export function installedAs(names, spec) {
  const declared = names instanceof Set ? names : new Set(Object.keys(names?.dependencies ?? {}));
  for (const candidate of dependencyNameCandidates(spec)) {
    if (declared.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The package names a spec could have been recorded as, most likely first.
 * @param spec - an install spec.
 * @returns candidate package names, without duplicates.
 */
export function dependencyNameCandidates(spec) {
  const raw = String(spec ?? '').trim();
  const candidates = [raw, raw.split('#')[0]];
  const github = /^github:([^/]+)\/([^#]+)/.exec(raw);
  if (github) {
    const repo = github[2].replace(/\.git$/, '');
    candidates.push(repo);
  }
  // A filesystem spec (`D:\a\b`, `/a/b`, `./b`, and their file:/link: forms):
  // pnpm names the dependency after the directory.
  const path = raw.replace(/^(?:file|link):/, '');
  if (/^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])/.test(path)) {
    const tail = path.split(/[\\/]/).filter(Boolean).pop();
    if (tail !== undefined && tail !== '') candidates.push(tail.replace(/\.git$/, ''));
  }
  return [...new Set(candidates.filter((candidate) => candidate !== ''))];
}

/**
 * Run `dsh plugin --profile <profile> add <spec>`.
 *
 * Two spawn strategies, in this order:
 *
 * 1. Direct (no shell) with piped output. Node resolves `dsh.cmd` on Windows by
 *    itself, so no shell is needed, and capturing output lets a blocked build
 *    script be detected and the install retried automatically.
 * 2. `shell: true` with `stdio: 'inherit'`. Needed for two independent reasons:
 *    a sandbox that forbids creating pipes (a real DSH workspace-write sandbox
 *    rejects the piped spawn with EPERM), and `dsh` being a `.cmd` shim that a
 *    bare `spawnSync('dsh')` does not resolve on Windows. Inheriting the
 *    parent's streams needs no pipe and still shows pnpm's own message.
 *    Capturing is an optimization, never a requirement.
 *
 * @param options - `profile`, `spec`, `cwd`, `spawnImpl`, `log`.
 * @returns `{ status, output, captured }`.
 */
export function runInstall({ profile, spec, cwd = process.cwd(), spawnImpl = spawnSync, log = () => {} }) {
  const args = ['plugin', '--profile', profile, 'add', spec];
  const piped = spawnImpl('dsh', args, { cwd, stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' });
  if (piped.error === undefined) {
    const output = `${piped.stdout ?? ''}${piped.stderr ?? ''}`;
    if (output !== '') log(output.replace(/\n?$/, '\n'));
    return { status: piped.status ?? 1, output, captured: true };
  }
  if (piped.error.code !== 'EPERM' && piped.error.code !== 'ENOENT') throw piped.error;

  // Quoting is the shell fallback's cost: a shell command is a string, so any
  // argument with spaces has to be quoted by hand.
  const line = ['plugin', '--profile', profile, 'add', spec].map(quoteForShell).join(' ');
  const inherited = spawnImpl(`dsh ${line}`, { cwd, stdio: 'inherit', shell: true });
  if (inherited.error) {
    if (inherited.error.code === 'ENOENT') {
      throw new Error('could not run `dsh` — is the DeepSeek Harness CLI on PATH?');
    }
    throw inherited.error;
  }
  return { status: inherited.status ?? 1, output: '', captured: false };
}

/**
 * Quote one shell argument for the platform's shell.
 * @param value - the raw argument.
 * @returns the argument, quoted when it contains characters the shell would split on.
 */
function quoteForShell(value) {
  const text = String(value);
  if (text === '' || !/[\s"'&|<>^()%]/.test(text)) return text;
  if (process.platform === 'win32') return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Detect pnpm's blocked-build-script failure and extract the allowlist key it
 * suggests.
 *
 * pnpm refuses to run a git-hosted package's `prepare` script until the exact
 * key it prints is listed under `allowBuilds`. That key embeds a commit tarball
 * URL, so it cannot be computed in advance — it has to be read out of the
 * failure. This turns "copy the key into pnpm-workspace.yaml, then re-run" into
 * one confirmation.
 *
 * The key is reassembled from its two stable parts (package name and codeload
 * URL) rather than copied as printed, because pnpm folds it across lines in a
 * terminal: the verbatim text is not a usable key.
 * @param output - the combined pnpm output.
 * @returns the suggested key, or undefined when this was a different failure.
 */
export function blockedBuildKey(output) {
  const text = String(output ?? '');
  if (!text.includes('allowBuilds')) return undefined;
  // The key is printed unquoted inside the `allowBuilds:` example; the URL body
  // may be folded across lines, and `: true` must stop it before the example's
  // trailing value. The sha is hexadecimal, so that cut is exact.
  const match = /"?([^"@\s]+)@(https:\/\/codeload\.github\.com\/[\s\S]*?):[ \t]*true(?=\s|$|")/.exec(text);
  if (!match) return undefined;
  return `${match[1]}@${match[2].replace(/\s+/g, '')}`;
}

/**
 * Escape a literal string for use inside a regular expression.
 * @param value - the literal text.
 * @returns the escaped text.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Add one key to the profile's `pnpm-workspace.yaml` `allowBuilds` map.
 *
 * The file is edited textually (append a line, or create the map) to preserve
 * the user's comments and key order; rewriting it from a parsed object would
 * silently drop both.
 * @param file - absolute `pnpm-workspace.yaml` path.
 * @param key - the allowlist key to add.
 * @returns `{ changed, reason }`.
 */
export function addAllowBuild(file, key) {
  const entry = `  ${JSON.stringify(key)}: true\n`;
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const present = new RegExp(`^[ \\t]+${escapeRegExp(JSON.stringify(key))}:`, 'm').test(existing);
  if (present) return { changed: false, reason: 'already allowed' };
  const block = /^(allowBuilds:[^\n]*\n)(?:[ \t]+[^\n]*\n)*/m.exec(existing);
  const updated =
    block === null
      ? `${existing.replace(/\n?$/, '\n')}allowBuilds:\n${entry}`
      : existing.slice(0, block.index) + block[0].replace(/\n?$/, '\n') + entry + existing.slice(block.index + block[0].length);
  try {
    writeFileSync(file, updated);
    return { changed: true, reason: block === null ? 'created the allowBuilds map' : 'added to allowBuilds' };
  } catch (error) {
    return { changed: false, reason: `could not write ${file}: ${error.message}` };
  }
}

/**
 * Compare a profile manifest before and after an install.
 * @param before - manifest read before the install.
 * @param after - manifest read after the install.
 * @returns `{ addedDependencies, addedBundles, removedBundles }`.
 */
export function diffProfile(before, after) {
  const beforeDeps = new Set(Object.keys(before?.dependencies ?? {}));
  const afterDeps = Object.keys(after?.dependencies ?? {});
  const beforeBundles = new Set(before?.dsh?.profile?.bundles ?? []);
  const afterBundles = after?.dsh?.profile?.bundles ?? [];
  return {
    addedDependencies: afterDeps.filter((name) => !beforeDeps.has(name)),
    addedBundles: afterBundles.filter((name) => !beforeBundles.has(name)),
    removedBundles: [...beforeBundles].filter((name) => !afterBundles.includes(name))
  };
}

/**
 * The real package names present in a profile's `node_modules`.
 *
 * A spec cannot always be reduced to the name pnpm records: a git subdirectory
 * spec installs a package whose directory name is unrelated to the URL tail.
 * The installed tree is the authority, so verification reads it instead of
 * guessing harder.
 * @param profileDir - the profile directory.
 * @returns every installed name, both the directory name and the manifest `name`.
 */
export function installedPackages(profileDir) {
  const root = join(profileDir, 'node_modules');
  const found = new Set();
  const readEntry = (dir, dirName) => {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      found.add(dirName);
      if (typeof manifest.name === 'string') found.add(manifest.name);
    } catch {
      // An unreadable entry is simply not evidence.
    }
  };
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(join(root, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) readEntry(join(root, entry.name, scoped.name), `${entry.name}/${scoped.name}`);
      }
    } else {
      readEntry(join(root, entry.name), entry.name);
    }
  }
  return found;
}

/**
 * Resolve the installed package name for an install spec.
 *
 * Fast path: reduce the spec to a dependency name and look it up in the
 * manifest. Fallback: read the installed tree, which is what actually decides
 * whether the install happened.
 *
 * `baseline` — the dependency names declared *before* the install — keeps the
 * fallback honest: a package that was already there is not this install's
 * result, so it cannot be reported as the thing that just got installed.
 * @param spec - the install spec that was used.
 * @param manifest - the profile manifest read after the install.
 * @param profileDir - the profile directory, for the installed-tree fallback.
 * @param baseline - dependency names declared before the install.
 * @returns the package name, or undefined when nothing can be attributed.
 */
export function resolveInstalledName(spec, manifest, profileDir, baseline = new Set()) {
  const declared = new Set(Object.keys(manifest?.dependencies ?? {}));
  const direct = installedAs(declared, spec);
  if (direct !== undefined) return direct;
  if (profileDir === undefined) return undefined;

  const fresh = installedPackages(profileDir);
  const wanted = dependencyNameCandidates(spec);
  for (const name of wanted) {
    if (fresh.has(name) && declared.has(name) && !baseline.has(name)) return name;
  }
  return undefined;
}
