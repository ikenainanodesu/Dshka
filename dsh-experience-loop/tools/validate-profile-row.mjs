/**
 * Validate a profile patch row with the HARNESS'S OWN patch parser.
 *
 * `dsh --dump-config` is the documented way to check a layer, but it rewrites
 * `cordis.yml` inside the profile directory and therefore fails with EPERM
 * under a confined sandbox. This does the same job without booting anything: it
 * calls the real `loadProfileDirectory` + `composeEntries`, then reports the
 * effective row — including whether an absolute `insert[].name` was anchored to
 * a `file://` URL and whether that target actually exists on disk.
 *
 * That anchoring step is the one that matters for a locally developed plugin,
 * because a raw Windows absolute path handed to `import()` elsewhere fails with
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
 *
 *   node tools/validate-profile-row.mjs [--profile web] [--id experience-loop]
 *                                       [--dsh-home <dir>] [--file <candidate patch>]
 *
 * `--file` validates a CANDIDATE patch file in place of the profile's own
 * `cordis.patch.yml`, so a recovery edit can be checked against the harness's
 * real parser BEFORE it is installed. Without it, the profile's own file is used.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const dshHome = argOf('dsh-home', process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.cwd(), '.dsh'))
const profileName = argOf('profile', 'web')
const rowId = argOf('id', 'experience-loop')
const candidateFile = argOf('file', undefined)

const profilesModules = join(dshHome, 'profiles', 'node_modules')
const appBootEntry = join(profilesModules, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
const dshAnchor = join(profilesModules, '@deepseek-ai', 'dsh', 'package.json')

if (!existsSync(appBootEntry) || !existsSync(dshAnchor)) {
  console.error(
    `cannot find the dsh install through ${profilesModules}; pass --dsh-home <dir> or run \`dsh\` once so it heals the profile module fallback`,
  )
  process.exit(2)
}

const { loadProfileDirectory, composeEntries, loadOptionalPatches } = await import(pathToFileURL(appBootEntry).href)

const profileDir = join(dshHome, 'profiles', profileName)
let profile
try {
  profile = loadProfileDirectory('dsh', profileDir, dshAnchor)
} catch (error) {
  console.log(JSON.stringify({ stage: 'loadProfileDirectory', ok: false, error: String(error) }, null, 2))
  process.exit(1)
}

console.log(`profile            ${profile.name} (${profileDir})`)
console.log(`patchReload        ${profile.patchReload}`)
console.log(`user patch file    ${profile.patchPath}`)
if (candidateFile) console.log(`CANDIDATE file     ${candidateFile}`)
console.log(`bundle layers      ${profile.layers.map((layer) => layer.packageName).join(' -> ')}`)

let userPatches = profile.patches
if (candidateFile) {
  if (!existsSync(candidateFile)) {
    console.error(`candidate patch file not found: ${candidateFile}`)
    process.exit(2)
  }
  try {
    userPatches = loadOptionalPatches('dsh', candidateFile) ?? []
  } catch (error) {
    // A parse failure here is exactly what breaks boot, so report it as the
    // finding rather than crashing with a stack trace.
    console.log(`\nFAIL: the candidate file does not parse as a patch list:\n  ${error?.message ?? error}`)
    process.exit(1)
  }
}
console.log(`user layer rows    ${userPatches.length}`)
console.log(`looking for row    ${rowId}`)
console.log()

const warnings = []
const composed = composeEntries(
  [...profile.layers.map((layer) => layer.patches), userPatches],
  (line) => warnings.push(line),
)
console.log('applyEntryPatches warnings:')
console.log(warnings.length > 0 ? warnings.map((line) => `  ${line}`).join('\n') : '  (none)')
console.log()

function findRows(entries, id, out = []) {
  for (const entry of entries ?? []) {
    if (entry?.id === id) out.push(entry)
    if (entry?.group && Array.isArray(entry.config)) findRows(entry.config, id, out)
  }
  return out
}

const rows = findRows(composed, rowId)
if (rows.length === 0) {
  console.log(`row "${rowId}" is NOT present in the composed tree.`)
  process.exit(1)
}
if (rows.length > 1) console.log(`WARNING: ${rows.length} rows share the id "${rowId}".`)

for (const row of rows) {
  const name = typeof row.name === 'string' ? row.name : ''
  const isFileUrl = name.startsWith('file://')
  // Only an anchored file URL is a real path to check. A bare specifier is
  // resolved by the loader through node_modules, not by this tool.
  let targetExists = null
  if (isFileUrl) {
    try {
      targetExists = existsSync(fileURLToPath(name))
    } catch {
      targetExists = false
    }
  }
  console.log(`effective row:`)
  console.log(`  name            ${name}`)
  console.log(`  anchored        ${isFileUrl ? 'yes (file:// URL, produced by anchorInsertedPluginNames)' : 'no (a module specifier the loader resolves)'}`)
  console.log(`  target exists   ${targetExists === null ? 'n/a (module specifier)' : targetExists}`)
  console.log(`  disabled        ${row.disabled === true}`)
  console.log(`  config          ${row.config === undefined ? '(none)' : JSON.stringify(row.config)}`)
  console.log()
  if (targetExists === false) {
    console.log('FAIL: the row points at a path that does not exist; the loader will reject it at boot.')
    process.exit(1)
  }
}
console.log('OK: the row composes cleanly.')
