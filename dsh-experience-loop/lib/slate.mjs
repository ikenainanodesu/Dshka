/**
 * Resolving a short reply to the option it selects.
 *
 * Background: a questionnaire answered with "C" is a COMPLETE request whose
 * meaning lives entirely in the question it answers. The first implementation
 * treated short asks as noise and dropped them, which disabled retrieval for
 * exactly the turns where a stored lesson matters most. The fix is not to guess
 * from shape (a token threshold) but to give the reply an explicit REFERENT:
 * when the agent actually posed a choice, the candidate set is known, so the
 * reply can be matched against it deterministically.
 *
 * Design follows the model used by NousResearch/hermes-agent for its native
 * `clarify` prompts (issue #96954), with two additions that fit this harness:
 * single-LETTER option markers (`A`/`B`/`C`, which is how the Web UI presents
 * them) and CJK ordinals.
 *
 * Deliberate properties, each of which the Hermes discussion insists on:
 *   - deterministic and testable: NO model call is involved;
 *   - an ambiguous reply is NEVER guessed — it fails closed;
 *   - the CANONICAL option label is returned, never the user's abbreviation;
 *   - arbitrary prose is not silently converted into a selection;
 *   - a reply matching nothing simply resolves to nothing (the caller then
 *     falls back to the conversation), so the feature can never lose a turn.
 */

/** Decoration such as "（推荐）" / "(recommended)" carries no identity. */
const DECORATION = /[（(【[][^）)】\]]*(?:推荐|建议|默认|recommended|recommend|default)[^）)】\]]*[）)】\]]/gi

/**
 * A leading enumeration marker: `1.`, `2)`, `(3)`, `4、`, `5：`, `A)`, `B -`.
 * Stripped only when something remains, so a label that IS "A" survives.
 */
const LEADING_MARKER = /^\s*[（(【[]?\s*(?:\d{1,2}|[a-z])\s*[）)】\].、:：\-–—]\s*/i

const WORD_ORDINALS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  // Korean
  첫: 1, 첫번째: 1, 첫째: 1, 두: 2, 두번째: 2, 둘째: 2, 세: 3, 세번째: 3, 셋째: 3,
  네: 4, 네번째: 4, 넷째: 4, 다섯: 5, 다섯번째: 5,
}

const CJK_NUMERALS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

/** Collapse a label or reply to comparable form. Never returns ''. */
export function normalizeForMatch(text) {
  const raw = String(text ?? '')
    .replace(DECORATION, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[*_`~"'“”‘’]/g, '')
    .toLowerCase()
  const stripped = raw.replace(LEADING_MARKER, '')
  return stripped === '' ? raw : stripped
}

/**
 * Build the matchable slate from one `user-questions/request` payload.
 * @param {Array<{id: string, question: string, options?: Array<{label: string}>, multiSelect?: boolean}>} questions
 * @returns {Array<{id: string, question: string, multiSelect: boolean, options: string[]}>}
 */
export function buildSlate(questions) {
  return (Array.isArray(questions) ? questions : [])
    .map((question) => ({
      id: String(question?.id ?? ''),
      question: String(question?.question ?? ''),
      multiSelect: question?.multiSelect === true,
      options: (Array.isArray(question?.options) ? question.options : [])
        .map((option) => (typeof option?.label === 'string' ? option.label : ''))
        .filter((label) => label !== ''),
    }))
    .filter((item) => item.options.length > 0)
}

function inRange(index, count) {
  return Number.isInteger(index) && index >= 1 && index <= count ? index : undefined
}

/**
 * Read a selection index out of an ordinal/letter/marker form.
 * @returns {number|undefined} 1-based index, or undefined when the reply is not
 *   an ordinal at all.
 */
function ordinalIndex(compact, count) {
  // Unwrap a marker: "(1)" · "1)" · "A)" · "C." — the wrapper carries no meaning.
  const bare = compact.replace(/^[（(【[]+/, '').replace(/[）)】\].、:：]+$/, '')

  // 1 · 1번 · 1번째 · 1st · 第1个 · 1号 · 第2项
  let match = /^(?:第)?(\d{1,2})(?:번|번째|st|nd|rd|th|号|个|项|条|番)?$/.exec(bare)
  if (match) return inRange(Number(match[1]), count)

  // A / B / C — how the Web UI labels choices in this harness.
  match = /^([a-z])$/.exec(bare)
  if (match) return inRange(match[1].charCodeAt(0) - 96, count)

  if (Object.hasOwn(WORD_ORDINALS, compact)) return inRange(WORD_ORDINALS[compact], count)
  if (Object.hasOwn(WORD_ORDINALS, bare)) return inRange(WORD_ORDINALS[bare], count)

  match = /^第?([一二两三四五六七八九十])(?:个|项|条|号|番)?$/.exec(bare)
  if (match) return inRange(CJK_NUMERALS[match[1]], count)

  return undefined
}

function decide(matches, multiSelect) {
  if (matches.length === 0) return { outcome: 'none', labels: [] }
  if (multiSelect) return { outcome: 'selected', labels: matches }
  // Fail closed: two plausible readings are not a reason to pick one.
  return matches.length === 1
    ? { outcome: 'selected', labels: matches }
    : { outcome: 'ambiguous', labels: [] }
}

/** Match one reply against one question's options. */
function matchQuestion(item, reply) {
  const options = item.options
  const compact = String(reply).replace(/[\s\u3000]+/g, '').toLowerCase()

  // Tier 1 + 2: an ordinal or letter naming a position.
  const index = ordinalIndex(compact, options.length)
  if (index !== undefined) return decide([options[index - 1]], item.multiSelect)

  const needle = normalizeForMatch(reply)
  if (needle === '') return { outcome: 'none', labels: [] }

  // Tier 3: the label itself, decorations and enumerations removed.
  const normalized = options.map((label) => normalizeForMatch(label))
  const exact = options.filter((_label, i) => normalized[i] === needle)
  if (exact.length > 0) return decide(exact, item.multiSelect)

  // Tier 4: a distinctive fragment — the reply is contained in the label, or
  // the reply quotes the label in full. Uniqueness is what makes it safe, so a
  // single character is never treated as a fragment: "e" is contained in almost
  // every label and would otherwise come back as a spurious ambiguity.
  if (needle.length < 2) return { outcome: 'none', labels: [] }
  const partial = options.filter((_label, i) => {
    const candidate = normalized[i]
    return candidate !== '' && (candidate.includes(needle) || needle.includes(candidate))
  })
  return decide(partial, item.multiSelect)
}

/**
 * Resolve a reply against a slate.
 * @param {ReturnType<typeof buildSlate>} slate
 * @param {string} reply - the user's raw words.
 * @returns {{ outcome: 'selected'|'ambiguous'|'none', labels: string[], questionId?: string, question?: string }}
 */
export function resolveReply(slate, reply) {
  if (typeof reply !== 'string' || reply.trim() === '') return { outcome: 'none', labels: [] }
  for (const item of Array.isArray(slate) ? slate : []) {
    const result = matchQuestion(item, reply.trim())
    if (result.outcome !== 'none') {
      return { ...result, questionId: item.id, question: item.question }
    }
  }
  return { outcome: 'none', labels: [] }
}

/**
 * Turn a resolved answer into a request string fit for retrieval.
 *
 * A UI that resolved the choice itself hands back canonical labels; one that did
 * not hands back the user's free text in `custom`. Both are usable, and taking
 * them from the ANSWER means the plugin does not have to re-parse anything for
 * the button path — the harness already did it.
 * @param {{answers?: Array<{id: string, selected?: string[], custom?: string}>}} answer
 * @param {ReturnType<typeof buildSlate>} slate
 * @returns {string} the request text, or '' when the answer carries nothing.
 */
export function answerToRequest(answer, slate) {
  const parts = []
  for (const item of Array.isArray(answer?.answers) ? answer.answers : []) {
    const question = (Array.isArray(slate) ? slate : []).find((entry) => entry.id === item?.id)
    const subject = question?.question ?? item?.id ?? ''
    const chosen = Array.isArray(item?.selected) ? item.selected.filter((l) => typeof l === 'string' && l !== '') : []
    if (chosen.length > 0) parts.push(`${subject}: ${chosen.join('; ')}`)
    else if (typeof item?.custom === 'string' && item.custom.trim() !== '') parts.push(`${subject}: ${item.custom.trim()}`)
  }
  return parts.join('\n')
}
