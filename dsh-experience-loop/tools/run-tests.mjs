/**
 * Run every test file in ONE process.
 *
 * `node --test test/` spawns a child per file, which needs piped stdio. Under a
 * confined sandbox (Windows named-pipe restrictions) that spawn fails with
 * EPERM, so this entry exists as the portable equivalent: it imports each test
 * file into the current process instead. `node --test test/` remains the
 * preferred runner wherever child processes are allowed.
 */

import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const testDir = join(here, '..', 'test')
const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

for (const name of files) {
  await import(new URL(`../test/${name}`, import.meta.url).href)
}
