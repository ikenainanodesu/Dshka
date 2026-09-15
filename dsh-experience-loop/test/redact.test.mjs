import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanField, isMostlySecret, redactText } from '../lib/redact.mjs'

test('redacts every credential shape the plugin promises never to store', () => {
  const cases = [
    ['sk-abcdefghijklmnopqrstuvwxyz012345', 'openai-style-key'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github-token'],
    ['AKIAIOSFODNN7EXAMPLE', 'aws-access-key'],
    ['password=hunter2secret', 'credential-assignment'],
    ['API_TOKEN=abcdef1234567890', 'env-secret'],
    ['Authorization: Bearer abcdefghijklmnopqrst', 'authorization-header'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij', 'jwt'],
    ['Set-Cookie: session=abcdef1234567890; Path=/', 'cookie'],
    ['postgres://user:sup3rsecret@db.internal:5432/app', 'connection-string'],
  ]
  for (const [input, rule] of cases) {
    const { text, hits } = redactText(input)
    assert.ok(hits.includes(rule), `expected rule ${rule} for ${input}, got ${hits.join(',') || 'none'}`)
    assert.ok(!text.includes('hunter2secret'), `raw secret survived: ${text}`)
  }
})

test('redacts a private key block wholesale', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----'
  const { text, hits } = redactText(`here it is: ${pem}`)
  assert.ok(hits.includes('private-key'))
  assert.ok(!text.includes('MIIEowIBAAKCAQEA1234'))
})

test('redacts a one-time code only in its own context', () => {
  const { hits } = redactText('你的验证码是 823194，五分钟内有效')
  assert.ok(hits.includes('otp'))
  const benign = redactText('the build produced 823194 lines of output')
  assert.ok(!benign.hits.includes('otp'))
})

test('rejects a payload that is nothing but credentials', () => {
  const raw = 'sk-abcdefghijklmnopqrstuvwxyz012345'
  const { text } = redactText(raw)
  assert.equal(isMostlySecret(raw, text), true)
  const field = cleanField(raw, 1000)
  assert.equal(field.rejected, true)
})

test('keeps a useful lesson that merely mentions a credential', () => {
  const raw = 'The deploy failed because DEEPSEEK_API_KEY=sk-abcdefghijklmnopqrstuv was exported in the wrong shell; use the repo .env instead.'
  const field = cleanField(raw, 1000)
  assert.equal(field.rejected, false)
  assert.ok(field.hits.length > 0)
  assert.ok(field.text.includes('use the repo .env instead'))
  assert.ok(!field.text.includes('sk-abcdefghijklmnopqrstuv'))
})

test('leaves ordinary technical prose untouched', () => {
  const raw = 'pnpm install then pnpm dev; the server listens on 127.0.0.1:3080'
  const field = cleanField(raw, 1000)
  assert.equal(field.hits.length, 0)
  assert.equal(field.text, raw)
})
