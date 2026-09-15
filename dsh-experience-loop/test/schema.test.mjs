/**
 * Guard against the host rejecting a tool schema.
 *
 * The registry asserts `output.schema` against a deliberately small JSON
 * Schema subset and refuses to register the tool otherwise — and because this
 * plugin registers raw schemas (it cannot import `defineTool`), nothing else
 * would catch a stray keyword. These tests walk both the parameter and the
 * output schema of every tool and enforce the host's actual rules.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SCHEMAS } from '../lib/surface.mjs'
import { validateValue } from '../lib/validate.mjs'

const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples'])
const CONSTRAINTS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])

function walk(node, path, violations) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(`${path} is not a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!CONSTRAINTS.has(key) && !ANNOTATIONS.has(key)) {
      violations.push(`${path}.${key} is not a supported keyword`)
    }
  }
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) violations.push(`${path} declares both type and oneOf`)
  if (hasType && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(node.type)) {
    violations.push(`${path}.type "${node.type}" is not a JSON Schema type`)
  }
  if (Array.isArray(node.oneOf)) {
    if (node.oneOf.length < 2) violations.push(`${path}.oneOf needs at least two branches`)
    node.oneOf.forEach((branch, index) => walk(branch, `${path}.oneOf[${index}]`, violations))
  }
  if (node.type === 'object' || (node.properties && !hasType)) {
    if (typeof node.additionalProperties !== 'boolean') {
      violations.push(`${path} is an explicit object node and must declare additionalProperties`)
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      walk(child, `${path}.properties.${key}`, violations)
    }
  }
  if (node.type === 'array' && node.items) walk(node.items, `${path}.items`, violations)
}

test('every declared schema stays inside the host-supported subset', () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    const violations = []
    walk(schema, name, violations)
    assert.deepEqual(violations, [], `${name}: ${violations.join('; ')}`)
  }
})

test('parameter roots are strong enough for the model to use them', () => {
  assert.equal(SCHEMAS.REVIEW_PARAMETERS.additionalProperties, false)
  assert.deepEqual(SCHEMAS.REVIEW_PARAMETERS.required, ['experiences'])
  assert.deepEqual(SCHEMAS.QUERY_PARAMETERS.required, ['action'])
  const actions = SCHEMAS.QUERY_PARAMETERS.properties.action.enum
  for (const action of ['search', 'show', 'stats', 'conflicts', 'pending', 'metric']) {
    assert.ok(actions.includes(action), `action ${action} must remain addressable`)
  }
})

test('the validator accepts a good value and names every bad one', () => {
  assert.deepEqual(validateValue(SCHEMAS.QUERY_PARAMETERS, { action: 'stats' }, '', []), [])
  const violations = validateValue(
    SCHEMAS.QUERY_PARAMETERS,
    { action: 'nope', limit: 'big', unexpected: 1 },
    '',
    [],
  )
  assert.ok(violations.some((line) => line.includes('action')))
  assert.ok(violations.some((line) => line.includes('limit')))
  assert.ok(violations.some((line) => line.includes('unexpected')))
})

test('nested review entries are validated field by field', () => {
  const good = {
    experiences: [{ type: 'memory', title: 't', summary: 's' }],
    outcomes: [{ id: 'exp_1', outcome: 'success' }],
  }
  assert.deepEqual(validateValue(SCHEMAS.REVIEW_PARAMETERS, good, '', []), [])
  const bad = {
    experiences: [{ type: 'guess', title: 't' }],
    outcomes: [{ id: 'exp_1', outcome: 'maybe' }],
  }
  const violations = validateValue(SCHEMAS.REVIEW_PARAMETERS, bad, '', [])
  assert.ok(violations.some((line) => line.includes('experiences[0].type')))
  assert.ok(violations.some((line) => line.includes('experiences[0].summary')))
  assert.ok(violations.some((line) => line.includes('outcomes[0].outcome')))
})
