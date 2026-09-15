/**
 * Deterministic reply resolution against a posed question's option set.
 *
 * The ladder is deliberately ordered and fails closed, following the model used
 * by NousResearch/hermes-agent for native `clarify` prompts (issue #96954):
 * a reply resolves only when EXACTLY ONE option matches at the first tier that
 * matches at all; anything ambiguous resolves to nothing rather than a guess.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { answerToRequest, buildSlate, normalizeForMatch, resolveReply } from '../lib/slate.mjs'

const slate = buildSlate([
  {
    id: 'q1',
    question: 'Which recovery approach?',
    options: [
      { label: 'A) restart the container' },
      { label: 'B) read the docker logs' },
      { label: 'C) check the host port conflict, then restart and verify' },
      { label: 'D) do nothing (recommended)' },
    ],
  },
])

test('positional replies resolve: number, letter, ordinal, locale forms', () => {
  for (const reply of ['1', 'a', 'A', 'A)', '1st', 'first']) {
    assert.equal(resolveReply(slate, reply).labels[0], 'A) restart the container', `reply ${reply}`)
  }
  for (const reply of ['2', 'b', 'second', '2nd']) {
    assert.equal(resolveReply(slate, reply).labels[0], 'B) read the docker logs', `reply ${reply}`)
  }
  for (const reply of ['3', 'C', 'c', 'third', '3rd', '第三', '第三个', '第3项', '3번', '세번째']) {
    assert.equal(
      resolveReply(slate, reply).labels[0],
      'C) check the host port conflict, then restart and verify',
      `reply ${reply}`,
    )
  }
})

test('label replies resolve, with decorations and enumerations ignored', () => {
  assert.deepEqual(resolveReply(slate, 'read the docker logs').labels, ['B) read the docker logs'])
  assert.deepEqual(resolveReply(slate, 'Read  the docker LOGS').labels, ['B) read the docker logs'])
  // "D) do nothing (recommended)" — the marker and the decoration carry no identity.
  assert.deepEqual(resolveReply(slate, 'do nothing').labels, ['D) do nothing (recommended)'])
  assert.deepEqual(resolveReply(slate, 'do nothing (recommended)').labels, ['D) do nothing (recommended)'])
})

test('a distinctive fragment resolves; a shared one refuses to guess', () => {
  assert.deepEqual(resolveReply(slate, 'port conflict').labels, [
    'C) check the host port conflict, then restart and verify',
  ])
  // "restart" appears in both A and C: fail closed, exactly as Hermes requires.
  assert.equal(resolveReply(slate, 'restart').outcome, 'ambiguous')
  assert.deepEqual(resolveReply(slate, 'restart').labels, [])
})

test('unrelated prose and stray characters resolve to nothing', () => {
  for (const reply of ['', '   ', 'what is the weather like', 'e', 'z', '9', '#']) {
    assert.equal(resolveReply(slate, reply).outcome, 'none', `reply ${JSON.stringify(reply)}`)
  }
})

test('the canonical label is returned, never the abbreviation', () => {
  const result = resolveReply(slate, 'C')
  assert.deepEqual(result.labels, ['C) check the host port conflict, then restart and verify'])
  assert.equal(result.question, 'Which recovery approach?')
  assert.equal(result.questionId, 'q1')
})

test('a multi-select question may resolve to more than one option', () => {
  const multi = buildSlate([
    {
      id: 'm1',
      question: 'Which fixes?',
      multiSelect: true,
      options: [{ label: 'restart the container' }, { label: 'read the docker logs' }, { label: 'restart the service' }],
    },
  ])
  const result = resolveReply(multi, 'restart')
  assert.equal(result.outcome, 'selected')
  assert.equal(result.labels.length, 2)
})

test('a question without options is skipped rather than matched', () => {
  const bare = buildSlate([{ id: 'x', question: 'Anything else?' }])
  assert.deepEqual(bare, [])
  assert.equal(resolveReply(bare, '1').outcome, 'none')
})

test('normalisation strips markers and decorations but never empties a label', () => {
  assert.equal(normalizeForMatch('A) restart'), 'restart')
  assert.equal(normalizeForMatch('(3) third option'), 'thirdoption')
  assert.equal(normalizeForMatch('X (推荐)'), 'x')
  // A label that IS just a marker must survive: stripping it would erase the option.
  assert.notEqual(normalizeForMatch('A'), '')
})

test('a question answer becomes a request string', () => {
  assert.equal(
    answerToRequest({ answers: [{ id: 'q1', selected: ['B) read the docker logs'] }] }, slate),
    'Which recovery approach?: B) read the docker logs',
  )
  assert.equal(
    answerToRequest({ answers: [{ id: 'q1', custom: 'something else entirely' }] }, slate),
    'Which recovery approach?: something else entirely',
  )
  assert.equal(answerToRequest({ answers: [] }, slate), '')
  assert.equal(answerToRequest(undefined, slate), '')
})
