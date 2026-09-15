/**
 * Edit one row of a DSH profile patch file safely.
 *
 * Purpose: recovery. When a profile patch row breaks `dsh` at boot, the first
 * move is to neutralise THAT row only — not to hand-edit YAML under pressure and
 * not to throw away the whole patch file. This edits exactly the top-level
 * `- insert:` entry that contains the given id, takes a timestamped backup
 * first, preserves the file's existing newline style and trailing newline, and
 * refuses to write anything if the anchor is ambiguous.
 *
 *   node tools/profile-row.mjs show    [--file <patch>] [--id <row-id>]
 *   node tools/profile-row.mjs disable [--file <patch>] [--id <row-id>]   # config.enabled = false
 *   node tools/profile-row.mjs enable  [--file <patch>] [--id <row-id>]   # config.enabled = true
 *   node tools/profile-row.mjs remove  [--file <patch>] [--id <row-id>]   # delete the entry
 *
 * Defaults: --file = <DSH_HOME>/profiles/web/cordis.patch.yml, --id = experience-loop
 *
 * After any of these, re-check the composed result with
 * `node tools/validate-profile-row.mjs`, which uses the harness's OWN patch
 * parser and needs no dsh boot. Do NOT use `dsh --dump-config` for that: it
 * rewrites cordis.yml inside the profile directory and fails with EPERM under a
 * confined sandbox, which misreports the problem.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const command = process.argv[2]
if (!['show', 'disable', 'enable', 'remove'].includes(command)) {
  console.error('usage: node tools/profile-row.mjs show|disable|enable|remove [--file <patch>] [--id <row-id>]')
  process.exit(2)
}

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.cwd(), '.dsh')
const file = argOf('file', join(dshHome, 'profiles', 'web', 'cordis.patch.yml'))
const rowId = argOf('id', 'experience-loop')

if (!existsSync(file)) {
  console.error(`patch file not found: ${file}`)
  process.exit(2)
}

const original = readFileSync(file, 'utf8')
const eol = original.includes('\r\n') ? '\r\n' : '\n'
const lines = original.split(/\r?\n/)

/** Locate the top-level `- insert:` entry whose text contains `id: <rowId>`. */
function locateEntry() {
  const starts = []
  for (let i = 0; i < lines.length; i++) {
    if (/^- /.test(lines[i])) starts.push(i)
  }
  starts.push(lines.length)
  const matches = []
  for (let s = 0; s < starts.length - 1; s++) {
    const from = starts[s]
    const to = starts[s + 1]
    const block = lines.slice(from, to)
    if (!block.some((line) => new RegExp(`^\\s*-?\\s*id:\\s*['"]?${rowId}['"]?\\s*$`).test(line))) continue
    matches.push({ from, to, block })
  }
  return matches
}

const matches = locateEntry()
if (matches.length === 0) {
  console.error(`no top-level entry with \`id: ${rowId}\` found in ${file}`)
  process.exit(1)
}
if (matches.length > 1) {
  console.error(`ambiguous: ${matches.length} entries declare \`id: ${rowId}\`; refusing to guess`)
  process.exit(1)
}

const entry = matches[0]
const blockText = entry.block.join(eol)

if (command === 'show') {
  console.log(`file   ${file}`)
  console.log(`rows   ${lines.filter((line) => /^- /.test(line)).length} top-level entries`)
  console.log(`entry  lines ${entry.from + 1}..${entry.to} (1-based)\n`)
  console.log(blockText)
  process.exit(0)
}

if (command === 'remove') {
  const backup = `${file}.bak-before-remove-${rowId}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  copyFileSync(file, backup)
  const kept = [...lines.slice(0, entry.from), ...lines.slice(entry.to)]
  writeFileSync(file, kept.join(eol), 'utf8')
  console.log(`backup ${backup}`)
  console.log(`removed the \`${rowId}\` entry (lines ${entry.from + 1}..${entry.to})`)
  console.log('now run: node tools/validate-profile-row.mjs')
  process.exit(0)
}

// disable / enable -> set config.enabled
const wantEnabled = command === 'enable'
const configIndex = entry.block.findIndex((line) => /^\s{6}config:\s*$/.test(line))
let nextBlock

if (configIndex === -1) {
  // No config: block — append one just after the row's `name:`/last key.
  const insertAfter = entry.block.reduce(
    (last, line, index) => (/^\s{6}\S/.test(line) ? index : last),
    0,
  )
  nextBlock = [
    ...entry.block.slice(0, insertAfter + 1),
    '      config:',
    `        enabled: ${wantEnabled}`,
    ...entry.block.slice(insertAfter + 1),
  ]
} else {
  nextBlock = [...entry.block]
  const enabledIndex = nextBlock.findIndex((line, index) => index > configIndex && /^\s{8}enabled:\s*\S+\s*$/.test(line))
  if (enabledIndex === -1) {
    nextBlock.splice(configIndex + 1, 0, `        enabled: ${wantEnabled}`)
  } else {
    nextBlock[enabledIndex] = `        enabled: ${wantEnabled}`
  }
}

const backup = `${file}.bak-before-${command}-${rowId}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
copyFileSync(file, backup)
writeFileSync(file, [...lines.slice(0, entry.from), ...nextBlock, ...lines.slice(entry.to)].join(eol), 'utf8')

console.log(`backup ${backup}`)
console.log(`set config.enabled = ${wantEnabled} on the \`${rowId}\` entry\n`)
console.log(nextBlock.join(eol))
console.log('\nnow run: node tools/validate-profile-row.mjs')
