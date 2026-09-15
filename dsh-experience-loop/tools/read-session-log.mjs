/**
 * Decode a persisted DSH session log (zstd-framed JSONL) and search it.
 *
 * `session-persistence-jsonl` defaults to zstd compression, so the log cannot
 * be grepped in place. Worse, the file is a CONCATENATION of independent zstd
 * frames — one header frame followed by one frame per durable append batch —
 * and neither `zstdDecompressSync` on the whole file nor a single streaming
 * decoder walks past the first frame (both silently return just the session
 * header). Each frame is therefore located by its magic number and decoded
 * individually.
 *
 *   node tools/read-session-log.mjs <session-log.jsonl.zstd> [needle] [--events]
 */

import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const target = process.argv[2]
if (!target) {
  console.error('usage: node tools/read-session-log.mjs <session-log.jsonl.zstd> [needle] [--events]')
  process.exit(2)
}
const needle = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined
const showEvents = process.argv.includes('--events')

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Decode every zstd frame in a concatenated frame file. */
function decodeFrames(path) {
  const buffer = readFileSync(path)
  const offsets = []
  let cursor = 0
  while ((cursor = buffer.indexOf(ZSTD_MAGIC, cursor)) !== -1) {
    offsets.push(cursor)
    cursor += ZSTD_MAGIC.length
  }
  let text = ''
  let frames = 0
  for (const offset of offsets) {
    try {
      text += zstdDecompressSync(buffer.subarray(offset)).toString('utf8')
      frames += 1
    } catch {
      // A compressed payload can contain the magic bytes by coincidence.
    }
  }
  return { text, frames, bytes: buffer.length }
}

const { text, frames, bytes } = decodeFrames(target)

const lines = text.split('\n').filter((line) => line.trim() !== '')
console.log(`${target}\n  ${bytes} bytes, ${frames} zstd frame(s), ${lines.length} record(s)\n`)

const counts = new Map()
let matched = 0
for (const line of lines) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  const type = record.type ?? '(header)'
  counts.set(type, (counts.get(type) ?? 0) + 1)
  const hit = needle === undefined || line.includes(needle)
  if (!hit) continue
  matched += 1
  if (showEvents || needle !== undefined) {
    console.log(`--- ${type} seq=${record.seq ?? '-'} ---`)
    console.log(line.length > 4000 ? `${line.slice(0, 4000)}… [${line.length} bytes]` : line)
  }
}
if (needle !== undefined) console.log(`\n${matched} record(s) contain "${needle}"`)

console.log('\nevent type counts:')
for (const [type, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(5)}  ${type}`)
}

// Convenience: when handed a session directory or the sessions root, list logs.
if (statSync(target).isDirectory()) {
  console.log('\nsession logs found:')
  for (const entry of readdirSync(target)) console.log(`  ${join(target, entry)}`)
}

