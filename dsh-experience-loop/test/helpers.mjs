/** Shared fixture builders for the tests. */

import { stampKeywords } from '../lib/rank.mjs'
import { makeRecord } from '../lib/store.mjs'

/**
 * Build a canonical record the way the write path would, so scoring and
 * similarity see the same keyword stamp they see in production.
 */
export function keywordRecord(overrides = {}) {
  const context = {
    scope: overrides.scopeLevel ?? 'global',
    projectKey: 'C-work-example-project',
    projectPath: 'C:\\work\\example-project',
    platform: 'win32',
    shell: 'pwsh',
    source: 'test',
    now: '2026-01-01T00:00:00.000Z',
  }
  const record = makeRecord(
    {
      id: overrides.id,
      type: overrides.type ?? 'memory',
      title: overrides.title ?? 'A fact',
      summary: overrides.summary ?? 'Something worth keeping.',
      body: overrides.body ?? { fact: overrides.summary ?? 'Something worth keeping.' },
      scope: overrides.scopeLevel ?? (overrides.scope === 'project' ? 'project' : 'global'),
      applies: overrides.applies ?? {},
      confidence: overrides.confidence ?? 0.5,
      status: overrides.status,
      evidence: [],
    },
    context,
  )
  stampKeywords(record)
  return record
}
