/**
 * A minimal in-process stand-in for the parts of the harness the plugin talks
 * to. It exists so the loop can be exercised end to end — hooks, retrieval,
 * review, tools, command — without booting dsh or calling a model.
 *
 * The waterfall honours `{ prepend: true }` the way Cordis does (prepended
 * listeners run first and call `next()` to reach the rest), because the
 * plugin's correctness depends on seeing the batch every other contributor
 * already agreed on.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Scratch root for test stores. Resolved relative to this file (which lives at
 * `<repo>/dsh-experience-loop/test/harness.mjs`) so a checkout works from any
 * directory and on any drive; `DSH_TEST_TMP` overrides it outright. The
 * directory is covered by the repository `.gitignore`.
 */
export const TEST_TMP_ROOT = process.env.DSH_TEST_TMP
  ?? join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), '.tmp-test')

export function makeTempStoreRoot(label = 'store') {
  mkdirSync(TEST_TMP_ROOT, { recursive: true })
  return mkdtempSync(join(TEST_TMP_ROOT, `${label}-`))
}

export function cleanup(path) {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

export function makeLogger() {
  const lines = []
  const record = (level) => (format, ...params) => lines.push({ level, format, params })
  return {
    lines,
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    text: () => lines.map((line) => `${line.level}: ${line.format}`).join('\n'),
  }
}

/**
 * Build a fake host context plus an inspection surface.
 * @returns {{ ctx: object, host: object }}
 */
export function createFakeHost() {
  const tools = new Map()
  const commands = new Map()
  const promptSections = []
  /** @type {Map<string, Array<{handler: Function, prepend: boolean}>>} */
  const listeners = new Map()
  const provided = new Map()
  const effects = []
  let skillProvider
  let skillControl

  const ctx = {
    logger: makeLogger(),
    tools: { register: (tool) => tools.set(tool.name, tool) },
    commands: {
      register: (definition) => {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
    systemPrompt: { section: (section) => promptSections.push(section) },
    skills: {
      registerProvider: (create) => {
        skillControl = {
          aborted: false,
          invalidate: () => {
            skillControl.invalidated = (skillControl.invalidated ?? 0) + 1
          },
        }
        skillProvider = create(skillControl)
        return () => {
          skillProvider = undefined
        }
      },
    },
    on: (event, handler, options = {}) => {
      const list = listeners.get(event) ?? []
      const entry = { handler, prepend: options.prepend === true }
      // Cordis places a prepended listener at the front of the dispatch order.
      if (entry.prepend) list.unshift(entry)
      else list.push(entry)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(entry)
        if (index >= 0) current.splice(index, 1)
      }
    },
    effect: (body) => {
      const disposer = body()
      effects.push(disposer)
      return () => disposer?.()
    },
    provide: (nameValue, value) => provided.set(nameValue, value),
    get: (serviceName) => provided.get(serviceName),
  }

  const host = {
    tools,
    commands,
    promptSections,
    listeners,
    provided,
    effects,
    get skillProvider() {
      return skillProvider
    },
    get skillControl() {
      return skillControl
    },
    /** List every registered sync-resolvable skill through the provider. */
    async listSkills(options = {}) {
      return skillProvider ? skillProvider.list(options) : []
    },
    async getSkill(candidate) {
      return skillProvider ? skillProvider.get(candidate, {}) : undefined
    },
    emit(event, ...args) {
      for (const entry of listeners.get(event) ?? []) entry.handler(...args)
    },
    /** Run the `agent/pre-step` waterfall with a downstream contributor. */
    async preStep({ agent, turn, step, messages, downstream }) {
      const chain = [...(listeners.get('agent/pre-step') ?? [])]
      let index = -1
      const base = downstream ?? (async () => ({ kind: 'enter', messages }))
      const dispatch = async () => {
        index += 1
        const entry = chain[index]
        if (!entry) return base()
        return entry.handler({ agent, turn, step, messages, signal: new AbortController().signal }, dispatch)
      }
      return dispatch()
    },
    /**
     * Run the `user-questions/request` waterfall. `answer` is what the real
     * answerer would return; a listener that observes and delegates must hand
     * that value straight back.
     */
    async askUserQuestion(request, answer = { answers: [] }) {
      const chain = [...(listeners.get('user-questions/request') ?? [])]
      let index = -1
      const dispatch = async () => {
        index += 1
        const entry = chain[index]
        if (!entry) return answer
        return entry.handler(request, dispatch)
      }
      return dispatch()
    },
    async runTool(toolName, args, exec = {}) {
      const tool = tools.get(toolName)
      if (!tool) throw new Error(`tool ${toolName} is not registered`)
      const value = await tool.execute(args, { agent: exec.agent, signal: new AbortController().signal })
      const content = tool.output.render(args, value)
      return { value, content, text: content.map((block) => block.text ?? '').join('\n') }
    },
    async runCommand(name, rawInput, agent) {
      const command = commands.get(name)
      if (!command) throw new Error(`command ${name} is not registered`)
      return command.handler({ agent, rawInput, commandId: 'cmd-1', attachments: [], signal: new AbortController().signal })
    },
    disposeAll() {
      for (const disposer of [...effects].reverse()) disposer?.()
    },
  }

  return { ctx, host }
}

/** Minimal Agent stand-in. */
export function makeAgent({ sessionId = 'session-test', cwd = 'C:\\work\\example-project', origin } = {}) {
  const session = {
    id: sessionId,
    header: { cwd, origin, version: 3, id: sessionId, createdAt: Date.now(), isSeeded: false },
  }
  const agent = { session }
  agent.ctx = { effect: (body) => body() }
  return agent
}

export function userMessage(text) {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * Convenience: emit the event sequence of one turn through the plugin hooks.
 *
 * `endReason` is a `TurnEndReason` kind, and the event carries the REAL durable
 * shape — `reason: { kind }`, not a bare string. The harness used to emit
 * `reason: 'stop'`, which no version of the schema has ever produced; nothing
 * read it until observed outcome attribution did.
 */
export function playTurn(
  host,
  { session, turn, ask, toolCalls = [], failures = 0, assistantText = '', endReason = 'completed' },
) {
  host.emit('session/event', session, { type: 'turn/start', data: { turn }, seq: 0, time: Date.now() })
  if (ask) {
    host.emit('session/event', session, {
      type: 'user/message',
      data: userMessage(ask),
      seq: 0,
      time: Date.now(),
    })
  }
  let calls = 0
  for (const call of toolCalls) {
    calls += 1
    const callId = call.callId ?? `call-${turn}-${calls}`
    host.emit('session/event', session, {
      type: 'tool/call',
      data: { turn, step: 1, callId, name: call.name, arguments: call.arguments ?? '{}' },
      seq: 0,
      time: Date.now(),
    })
    const isError = calls <= failures
    host.emit('session/event', session, {
      type: 'tool/result',
      data: {
        turn,
        step: 1,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', callId, isError }],
          source: { kind: 'tool', callId },
        },
        ...(call.errorCode !== undefined ? { error: { name: call.name, code: call.errorCode } } : {}),
      },
      seq: 0,
      time: Date.now(),
    })
  }
  if (assistantText !== '') {
    host.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } },
      seq: 0,
      time: Date.now(),
    })
  }
  host.emit('session/event', session, {
    type: 'turn/end',
    data: { turn, reason: { kind: endReason } },
    seq: 0,
    time: Date.now(),
  })
}

/** Emit a user-invoked `/skill-name` gesture the way `dsh-tool-skill` does. */
export function playSkillGesture(host, { session, turn, skillName }) {
  host.emit('session/event', session, {
    type: 'user/message',
    data: {
      id: `msg-${Math.random().toString(36).slice(2)}`,
      role: 'user',
      content: [{ type: 'text', text: `/${skillName}` }],
      source: { kind: 'skill-invocation', name: skillName, form: 'instructions' },
    },
    seq: 0,
    time: Date.now(),
  })
}
