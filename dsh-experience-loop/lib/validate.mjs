/**
 * A deliberately tiny validator for the raw JSON Schema subset the host tool
 * registry supports (`type` / `oneOf` / `properties` / `required` /
 * `additionalProperties` / `items` / `enum` / `const`).
 *
 * Raw-schema tools are not argument-validated by the registry — `defineTool`
 * does that, and this plugin cannot import it — so the tool bodies validate
 * their own input here. Violations are returned rather than thrown so a tool
 * can report a precise, model-actionable error instead of a stack trace.
 */

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function matchesType(node, value) {
  const type = node.type
  if (type === undefined) return true
  const actual = typeOf(value)
  if (type === 'number') return actual === 'number' || actual === 'integer'
  if (type === 'integer') return actual === 'integer'
  if (type === 'object') return actual === 'object'
  return actual === type
}

function equalLiteral(a, b) {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b)
  return false
}

/**
 * Validate a value against a supported JSON Schema node.
 * @param {Record<string, any>} node - schema node.
 * @param {unknown} value - candidate value.
 * @param {string} path - JSON-ish path used in messages ('' for the root).
 * @param {string[]} violations - accumulator.
 * @returns {string[]} the same accumulator.
 */
export function validateValue(node, value, path = '', violations = []) {
  if (!node || typeof node !== 'object') return violations
  const at = path === '' ? 'arguments' : path

  if (Array.isArray(node.oneOf)) {
    let matched = 0
    for (const branch of node.oneOf) {
      if (validateValue(branch, value, path, []).length === 0) matched++
    }
    if (matched !== 1) violations.push(`${at} must match exactly one allowed shape (matched ${matched})`)
    return violations
  }

  if (node.const !== undefined && !equalLiteral(value, node.const)) {
    violations.push(`${at} must equal ${JSON.stringify(node.const)}`)
    return violations
  }

  if (Array.isArray(node.enum) && !node.enum.some((candidate) => equalLiteral(value, candidate))) {
    violations.push(`${at} must be one of ${node.enum.map((v) => JSON.stringify(v)).join(' | ')}`)
    return violations
  }

  if (!matchesType(node, value)) {
    violations.push(`${at} must be of type ${node.type} (got ${typeOf(value)})`)
    return violations
  }

  if (node.type === 'object' || (node.type === undefined && node.properties)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return violations
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) violations.push(`${at}.${key} is required`)
    }
    const properties = node.properties ?? {}
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue
      const spec = properties[key]
      if (spec === undefined) {
        if (node.additionalProperties === false) violations.push(`${at}.${key} is not an accepted property`)
        continue
      }
      validateValue(spec, child, path === '' ? key : `${path}.${key}`, violations)
    }
  }

  if (node.type === 'array' && Array.isArray(value) && node.items) {
    for (let i = 0; i < value.length; i++) {
      validateValue(node.items, value[i], `${at}[${i}]`, violations)
    }
  }

  return violations
}

/**
 * Convenience wrapper used by the tool bodies.
 * @param {Record<string, any>} schema - parameter schema.
 * @param {unknown} args - model-provided arguments.
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function checkArgs(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    // A malformed payload reaches here as the RAW string, because the harness
    // could not parse it. Say WHY rather than only that it was not an object:
    // report the syntax error so the caller can correct its payload. Never
    // repair malformed JSON here: guessing could accept unintended content.
    if (typeof args === 'string') {
      try {
        JSON.parse(args)
        return { ok: false, violations: ['arguments must be a JSON object (it arrived as a JSON string)'] }
      } catch (error) {
        return {
          ok: false,
          violations: [`arguments must be a JSON object; the JSON did not parse: ${error?.message ?? error}`],
        }
      }
    }
    return { ok: false, violations: ['arguments must be a JSON object'] }
  }
  const violations = validateValue(schema, args, '', [])
  return { ok: violations.length === 0, violations }
}
