// Builds the fixtures used for manual end-to-end verification:
// two minimal real plugins (package.json + cordis.patch.yml + index.mjs) and a
// DSH home with two initialized profiles.
//
// Usage: node test/make-fixture.mjs <dsh-home> [plugin-root]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.argv[2];
const pluginRoot = process.argv[3];
if (!home || !pluginRoot) throw new Error('usage: node make-fixture.mjs <dsh-home> <plugin-root>');

/** A minimal plugin that declares a bundle layer, like a real published one. */
function writePlugin(dir, name, id) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name,
        version: '0.0.1',
        private: true,
        type: 'module',
        main: 'index.mjs',
        dsh: { bundle: { patch: './cordis.patch.yml' } }
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(dir, 'cordis.patch.yml'),
    `# Fixture bundle layer for ${name}.\n- insert:\n    - id: ${id}\n      name: ${name}\n`
  );
  writeFileSync(
    join(dir, 'index.mjs'),
    `/** Fixture plugin ${name}: registers nothing, only proves the layer loads. */\nexport function apply() {}\n`
  );
}

writePlugin(join(pluginRoot, 'fixture-plugin-a'), 'fixture-plugin-a', 'fixture-a');
writePlugin(join(pluginRoot, 'fixture-plugin-b'), 'fixture-plugin-b', 'fixture-b');

const profiles = join(home, 'profiles');
const manifests = {
  alpha: {
    name: 'dsh-profile-alpha',
    private: true,
    dependencies: { 'fixture-plugin-a': `link:${join(pluginRoot, 'fixture-plugin-a')}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'fixture-plugin-a'], patchReload: 'live' } }
  },
  beta: {
    name: 'dsh-profile-beta',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' } }
  }
};
for (const [dir, manifest] of Object.entries(manifests)) {
  mkdirSync(join(profiles, dir), { recursive: true });
  writeFileSync(join(profiles, dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`fixtures written: ${join(pluginRoot, 'fixture-plugin-a')}, ${join(pluginRoot, 'fixture-plugin-b')}`);
console.log(`dsh home written: ${home} (profiles: alpha, beta)`);
