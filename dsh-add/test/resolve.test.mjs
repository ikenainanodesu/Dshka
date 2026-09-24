/**
 * Tests for the name resolver, the profile chooser and the build-script
 * allowlist editor.
 *
 * These are unit tests over pure functions: the registry is a fixture, not the
 * network, because the network's answer changes daily and a resolver test that
 * depends on it would fail for reasons unrelated to this code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decide, normalizeName, repoSlug, resolveQuery, specOf } from '../src/match.mjs';
import {
  addAllowBuild,
  blockedBuildKey,
  chooseProfile,
  diffProfile,
  installedAs,
  installedPackages,
  resolveInstalledName
} from '../src/install.mjs';

/** A registry shaped like the real one, including a name collision. */
const registry = [
  {
    name: 'dsh-engram',
    owner: 'kenz1117',
    npm: '@kenz1117/dsh-engram',
    url: 'https://github.com/kenz1117/dsh-engram',
    install: 'dsh plugin --profile web add @kenz1117/dsh-engram',
    downloads: 4400,
    stars: 7,
    description: { en: 'Memory palace', zh: '记忆宫殿' }
  },
  {
    name: 'dsh-engram',
    owner: 'skepsun',
    npm: 'dsh-engram',
    url: 'https://github.com/skepsun/dsh-engram',
    install: 'dsh plugin --profile web add dsh-engram',
    downloads: 1696,
    stars: 6
  },
  {
    name: 'engramory',
    owner: 'tinqiao-oss',
    npm: 'dsh-engramory',
    url: 'https://github.com/tinqiao-oss/engramory',
    install: 'dsh plugin --profile web add dsh-engramory',
    downloads: 856,
    stars: 191
  },
  {
    name: 'dsh-add-to-chat',
    owner: 'choco9527',
    npm: null,
    url: 'https://github.com/choco9527/dsh-add-to-chat',
    install: 'dsh plugin --profile web add github:choco9527/dsh-add-to-chat'
  },
  {
    name: 'dsh-memory',
    owner: 'FuRongJun-1999',
    npm: '@furongjun1999/dsh-memory',
    url: 'https://github.com/FuRongJun-1999/dsh-memory',
    install: 'dsh plugin --profile web add @furongjun1999/dsh-memory',
    downloads: 13602,
    stars: 244
  },
  {
    name: 'dsh-memory',
    owner: 'Max-Null',
    npm: '@max-null/dsh-memory',
    url: 'https://github.com/Max-Null/dsh-memory',
    install: 'dsh plugin --profile web add @max-null/dsh-memory',
    downloads: 2761,
    stars: 3
  },
  {
    name: 'dsh-trail#bundle',
    owner: 'ayahunter',
    npm: null,
    url: 'https://github.com/ayahunter/dsh-trail/tree/main/packages/bundle',
    install: 'dsh plugin --profile web add github:ayahunter/dsh-trail#path:/packages/bundle'
  }
];

test('normalizeName strips the flavour suffix', () => {
  assert.equal(normalizeName('dsh-trail#bundle'), 'dsh-trail');
  assert.equal(normalizeName('OpenViking#examples/dsh-memory-plugin'), 'openviking');
  assert.equal(normalizeName('  DSH-Engram '), 'dsh-engram');
});

test('repoSlug reads owner/repo out of a nested GitHub URL', () => {
  assert.equal(repoSlug('https://github.com/ayahunter/dsh-trail/tree/main/packages/bundle'), 'ayahunter/dsh-trail');
  assert.equal(repoSlug('https://github.com/a/b.git'), 'a/b');
  assert.equal(repoSlug('https://example.com/x'), undefined);
});

test('specOf prefers the registry install command', () => {
  assert.equal(specOf({ install: 'dsh plugin --profile web add @k/x', npm: 'ignored' }), '@k/x');
  assert.equal(specOf({ npm: 'fallback-name' }), 'fallback-name');
  assert.equal(specOf({}), undefined);
});

test('an ambiguous name resolves to both exact entries, ranked by downloads', () => {
  const ranked = resolveQuery(registry, 'dsh-engram');
  assert.equal(ranked.exact.length, 2);
  assert.equal(ranked.exact[0].plugin.owner, 'kenz1117');
  assert.equal(ranked.exact[1].plugin.owner, 'skepsun');
  assert.equal(ranked.fuzzy.length, 1);
  assert.equal(ranked.fuzzy[0].plugin.owner, 'tinqiao-oss');
});

test('a dominant leader is decisive, a near tie is not', () => {
  const dominant = decide(resolveQuery(registry, 'dsh-engram'));
  assert.equal(dominant.decisive, true);
  assert.equal(dominant.winner.plugin.owner, 'kenz1117');

  const near = decide({
    exact: [
      { plugin: { downloads: 300, name: 'a' }, exact: true },
      { plugin: { downloads: 280, name: 'b' }, exact: true }
    ],
    fuzzy: []
  });
  assert.equal(near.decisive, false);
});

test('two exact matches with no download evidence are never guessed', () => {
  const verdict = decide({
    exact: [
      { plugin: { name: 'a' }, exact: true },
      { plugin: { name: 'b' }, exact: true }
    ],
    fuzzy: []
  });
  assert.equal(verdict.decisive, false);
});

test('a sole partial match is reported, not installed', () => {
  // `dsh-add` is a prefix of `dsh-add-to-chat`; installing it silently was a
  // real bug this test pins down.
  const verdict = decide(resolveQuery(registry, 'dsh-add'));
  assert.equal(verdict.decisive, false);
  assert.equal(verdict.winner.plugin.owner, 'choco9527');
});

test('npm name and owner/repo both resolve exactly', () => {
  assert.equal(resolveQuery(registry, '@max-null/dsh-memory').exact.length, 1);
  assert.equal(resolveQuery(registry, 'Max-Null/dsh-memory').exact.length, 1);
  const byRepo = resolveQuery(registry, 'choco9527/dsh-add-to-chat');
  assert.equal(byRepo.exact.length, 1);
  assert.equal(byRepo.exact[0].exact, true);
});

test('an entry with no install spec is not a candidate', () => {
  const ranked = resolveQuery([{ name: 'ghost', npm: null, install: '' }], 'ghost');
  assert.equal(ranked.exact.length, 0);
  assert.equal(ranked.fuzzy.length, 0);
});

test('chooseProfile explains itself and honours explicitness', () => {
  const env = { DSH_HOME: mkdtempSync(join(tmpdir(), 'dsh-add-home-')) };
  assert.deepEqual(chooseProfile({ explicit: 'tui', env }), { profile: 'tui', reason: 'from --profile' });
  // No profiles at all yet.
  assert.equal(chooseProfile({ env }).profile, 'web');
  assert.equal(chooseProfile({ env: { ...env, DSH_PROFILE: 'headless' } }).profile, 'headless');
});

test('installedAs matches an npm name and an existing dependency', () => {
  const manifest = { dependencies: { '@kenz1117/dsh-engram': '^0.7.12' } };
  assert.equal(installedAs(manifest, '@kenz1117/dsh-engram'), '@kenz1117/dsh-engram');
  assert.equal(installedAs(manifest, 'dsh-engram'), undefined);
});

test('installedAs reduces a filesystem spec to the dependency name pnpm records', () => {
  // The regression this pins: a local-path install verification reported
  // "declares no dsh.bundle" because the path never became a candidate name.
  const manifest = { dependencies: { 'dsh-experience-loop': 'link:D:/work/dsh-experience-loop' } };
  assert.equal(installedAs(manifest, 'D:\\work\\dsh-experience-loop'), 'dsh-experience-loop');
  assert.equal(installedAs(manifest, 'D:/work/dsh-experience-loop'), 'dsh-experience-loop');
  assert.equal(installedAs(manifest, 'link:../../dsh-experience-loop'), 'dsh-experience-loop');
  assert.equal(installedAs(manifest, './plugins/dsh-experience-loop/'), 'dsh-experience-loop');
  assert.equal(installedAs(manifest, 'github:someone/dsh-experience-loop'), 'dsh-experience-loop');
});

test('resolveInstalledName reads the installed tree for a git subpath spec', () => {
  const manifest = {
    dependencies: { 'dsh-trail': 'github:ayahunter/dsh-trail' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-trail'] } }
  };
  assert.equal(resolveInstalledName('github:ayahunter/dsh-trail#path:/packages/bundle', manifest), 'dsh-trail');
});

test('installedPackages reads real names out of node_modules, including scopes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-add-profile-'));
  mkdirSync(join(dir, 'node_modules', 'plain-pkg'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '@scope', 'scoped-pkg'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'plain-pkg', 'package.json'), JSON.stringify({ name: 'plain-pkg' }));
  // A directory name that differs from the manifest name: the manifest wins.
  writeFileSync(join(dir, 'node_modules', '@scope', 'scoped-pkg', 'package.json'), JSON.stringify({ name: '@real/name' }));

  const found = installedPackages(dir);
  assert.equal(found.has('plain-pkg'), true);
  assert.equal(found.has('@scope/scoped-pkg'), true);
  assert.equal(found.has('@real/name'), true);
  assert.equal(found.has('.bin'), false);
});

test('the installed-tree fallback never credits a pre-existing package', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-add-profile-'));
  mkdirSync(join(dir, 'node_modules', 'other-plugin'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'other-plugin', 'package.json'), JSON.stringify({ name: 'other-plugin' }));
  const manifest = { dependencies: { 'other-plugin': '^1.0.0' } };
  const baseline = new Set(['other-plugin']);
  assert.equal(resolveInstalledName('github:someone/unrelated-repo', manifest, dir, baseline), undefined);
  assert.equal(resolveInstalledName('github:someone/other-plugin', manifest, dir, baseline), 'other-plugin');
});

test('diffProfile reports what an install actually changed', () => {
  const before = { dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } };
  const after = {
    dependencies: { 'dsh-engram': '^0.7.12' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-engram'] } }
  };
  assert.deepEqual(diffProfile(before, after), {
    addedDependencies: ['dsh-engram'],
    addedBundles: ['dsh-engram'],
    removedBundles: []
  });
});

test('blockedBuildKey reassembles the key pnpm folds across lines', () => {
  // Captured from a real pnpm 12.4.1 failure: the long codeload URL is folded,
  // so the printed text is not itself a usable key.
  const wrapped = [
    'Error: ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED',
    '  help: Add the package to "allowBuilds" in your project\'s pnpm-workspace.yaml',
    '        to allow it to run scripts. For example:',
    '        allowBuilds:',
    '          dsh-add-to-chat@https://codeload.github.com/choco9527/dsh-add-to-',
    '        chat/tar.gz/4d1237eb34eb6b3182475c74638fd83844218598: true',
    ''
  ].join('\n');
  assert.equal(
    blockedBuildKey(wrapped),
    'dsh-add-to-chat@https://codeload.github.com/choco9527/dsh-add-to-chat/tar.gz/4d1237eb34eb6b3182475c74638fd83844218598'
  );

  const unwrapped = wrapped.replace('dsh-add-to-\n        chat/', 'dsh-add-to-chat/');
  assert.equal(blockedBuildKey(unwrapped), blockedBuildKey(wrapped));
  assert.equal(blockedBuildKey('Error: something else'), undefined);
});

test('addAllowBuild creates the map, then appends to it, preserving comments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-add-ws-'));
  const file = join(dir, 'pnpm-workspace.yaml');
  writeFileSync(file, 'packages:\n  - .\n\n# keep me\nnodeLinker: hoisted\n');

  const first = addAllowBuild(file, 'pkg-a@https://codeload.github.com/a/b/tar.gz/1');
  assert.equal(first.changed, true);
  const afterFirst = readFileSync(file, 'utf8');
  assert.match(afterFirst, /^allowBuilds:\n {2}"pkg-a@https:\/\/codeload\.github\.com\/a\/b\/tar\.gz\/1": true$/m);
  assert.match(afterFirst, /# keep me/);

  const second = addAllowBuild(file, 'pkg-b');
  assert.equal(second.changed, true);
  const afterSecond = readFileSync(file, 'utf8');
  assert.match(afterSecond, /^allowBuilds:\n {2}"pkg-a[^\n]*\n {2}"pkg-b": true$/m);
  assert.match(afterSecond, /nodeLinker: hoisted/);

  assert.equal(addAllowBuild(file, 'pkg-b').changed, false);
});
