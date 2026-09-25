import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = new URL('../../', import.meta.url)
const manifestUrl = new URL('package.json', root)
// Legacy subdirectory-only checkouts do not include the new repository wrapper.
const manifest = existsSync(manifestUrl) ? JSON.parse(readFileSync(manifestUrl, 'utf8')) : null
const hasRootLayout = existsSync(new URL('dsh-experience-loop/index.mjs', root))
const options = { skip: !hasRootLayout && 'Root bundle not present in this legacy subdirectory install' }

test('repository root and legacy entry describe the same experience-loop plugin', options, () => {
  const legacy = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.name, 'dsh-experience-loop')
  assert.equal(manifest.name, legacy.name)
  assert.equal(manifest.version, legacy.version)
  assert.deepEqual(manifest.engines, legacy.engines)
  assert.equal(manifest.main, manifest.exports['.'])
})

test('root package resolves to the existing plugin implementation', options, async () => {
  const require = createRequire(manifestUrl)
  assert.equal(require.resolve(manifest.name), fileURLToPath(new URL('dsh-experience-loop/index.mjs', root)))
  const plugin = await import(new URL(manifest.exports['.'], root))
  assert.equal(plugin.name, 'experience-loop')
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(plugin.inject.includes('tools'))
})

test('root bundle declares the existing patch and no replacement installer', options, () => {
  assert.equal(manifest.dsh.bundle.patch, './dsh-experience-loop/cordis.patch.yml')
  const patch = readFileSync(new URL(manifest.dsh.bundle.patch, root), 'utf8')
  assert.match(patch, /id: experience-loop/)
  assert.match(patch, /name: dsh-experience-loop/)
  assert.equal(manifest.bin, undefined)
  assert.equal(existsSync(new URL('dsh-add/', root)), false)
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(manifest.scripts?.[hook], undefined)
  }
})

test('both landing pages use official installation and the high-resolution waist portrait', options, () => {
  for (const name of ['README.md', 'README.zh-CN.md']) {
    const readme = readFileSync(new URL(name, root), 'utf8')
    assert.match(readme, /dsh plugin --profile web add github:ikenainanodesu\/Dshka/)
    assert.match(readme, /src="assets\/logo\/logo-waist.png"[^>]*width="420"/)
    assert.doesNotMatch(readme, /dsh-add/)
  }
  const png = readFileSync(new URL('assets/logo/logo-waist.png', root))
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  assert.equal(png.readUInt32BE(16), 768)
  assert.equal(png.readUInt32BE(20), 784)
})
