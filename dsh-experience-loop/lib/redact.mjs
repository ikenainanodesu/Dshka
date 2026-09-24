/**
 * Best-effort sensitive-information filtering, not a universal safety boundary.
 *
 * Review payloads, episode text and imports use recognized-pattern redaction.
 * Useful lessons can survive after matching spans are replaced; detected
 * credential-only payloads can be rejected. Unknown secrets and identifying
 * text may remain, so inspect stored or exported material before sharing.
 */

/** Marker left in place of a redacted span; greppable and unmistakable. */
export function placeholder(rule) {
  return `«redacted:${rule}»`
}

const RULES = [
  {
    name: 'private-key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\b/g,
  },
  { name: 'authorization-header', re: /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  {
    name: 'credential-assignment',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|passphrase|credential)s?\b\s*[:=]\s*(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,;"']{4,})/gi,
  },
  {
    name: 'env-secret',
    re: /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIALS?)\s*=\s*[^\s"']{6,}/g,
  },
  { name: 'cookie', re: /\b(?:Set-Cookie|Cookie)\s*:\s*[^\n]{8,}/gi },
  {
    name: 'connection-string',
    re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{2,}:[^\s:@/]{2,}@/gi,
  },
  {
    name: 'otp',
    re: /(?:验证码|校验码|动态码|verification code|one[- ]?time (?:code|password)|\botp\b)[^\n]{0,24}?\b\d{4,8}\b/gi,
  },
]

/**
 * Redact every recognized secret shape.
 * @param {unknown} input - candidate text (non-strings are stringified).
 * @returns {{ text: string, hits: string[], redactedChars: number }}
 */
export function redactText(input) {
  const original = typeof input === 'string' ? input : input == null ? '' : String(input)
  let text = original
  const hits = []
  for (const rule of RULES) {
    rule.re.lastIndex = 0
    if (!rule.re.test(text)) continue
    rule.re.lastIndex = 0
    text = text.replace(rule.re, () => {
      hits.push(rule.name)
      return placeholder(rule.name)
    })
  }
  return {
    text,
    hits: [...new Set(hits)],
    redactedChars: Math.max(0, original.length - text.length),
  }
}

/**
 * Decide whether a payload is *only* credentials. Such a payload carries no
 * reusable lesson, so storing it would be pure liability.
 * @param {string} original - text before redaction.
 * @param {string} redacted - text after redaction.
 * @returns {boolean} true when almost nothing survives.
 */
export function isMostlySecret(original, redacted) {
  const before = original.replace(/\s+/g, '')
  if (before.length === 0) return false
  const after = redacted.replace(/«redacted:[a-z-]+»/g, '').replace(/\s+/g, '')
  return after.length < Math.max(8, before.length * 0.35)
}

/**
 * Redact one review payload field and report whether it survives.
 * @param {unknown} value - raw field text.
 * @param {number} max - truncation bound applied after redaction.
 * @returns {{ text: string, hits: string[], rejected: boolean }}
 */
export function cleanField(value, max = 2000) {
  const raw = typeof value === 'string' ? value : value == null ? '' : String(value)
  const { text, hits } = redactText(raw)
  const rejected = isMostlySecret(raw, text)
  const trimmed = text.length > max ? `${text.slice(0, max - 1)}…` : text
  return { text: trimmed, hits, rejected }
}
