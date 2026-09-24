/**
 * First-step prompt injection: the UE workspace constraints, as one durable
 * plugin-sourced user message.
 *
 * Shape follows `%LOCALAPPDATA%\DSH\plugins\dsh-session-title-local\index.js` exactly:
 * an `agent/pre-step` waterfall, `createUserMessage({ content, source: { kind:
 * 'plugin:dsh-aura' } })`, spliced in after the last already-claimed message, respecting
 * a `reject` decision. (Session format V4: the source kind is producer-owned.)
 *
 * Three invariants:
 *   1. **First step only.** A session that already carries an `assistant/message` is left
 *      alone, so an ongoing conversation is never interrupted.
 *   2. **Durable dedup.** A session that already carries a `user/message` whose
 *      `source.kind === 'plugin:dsh-aura'` is never injected
 *      twice — this survives resume and replay because it is read from the log.
 *   3. **UE project gate, not an AGENTS.md gate.** The condition is "the session cwd
 *      contains a `*.uproject`", never "an AGENTS.md exists there". See the body module
 *      for why that distinction is the whole point.
 *
 * The plugin identity is fixed to `dsh-aura`. It must NOT be either of the title plugin's
 * names: `dsh-session-title-local` treats those two as "I already injected", so reusing
 * one would silently drop the session-title naming rules.
 *
 * @module dsh-aura/lib/prompt/inject
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AURA_WORKSPACE_BODY } from './bodies/aura-workspace.js'
import { UE_WORKSPACE_BODY } from './bodies/ue-workspace.js'

/**
 * This plugin's producer identity. Session format V4 retired the `{ kind: 'plugin',
 * plugin: <name> }` wrapper: every message source must carry a producer-owned `kind`,
 * and the V3->V4 migration renames third-party plugin sources to `plugin:<name>`.
 * Never reuse another plugin's name.
 */
export const INJECTION_SOURCE_PLUGIN = 'dsh-aura'

/** This plugin's V4 producer-owned source kind (matches migrated V3 logs). */
export const INJECTION_SOURCE_KIND = `plugin:${INJECTION_SOURCE_PLUGIN}`

/**
 * Plugin identities that own the session-title naming rules. Exported so a test can assert
 * this plugin is not one of them (that would silently suppress the other injection).
 */
export const FOREIGN_INSTRUCTION_SOURCE_PLUGINS = ['dsh-session-title-format', 'dsh-session-title-local']

/** Reminder frame, matching the convention used by the title plugin and agent-instructions. */
export const REMINDER_OPEN = '<system-reminder>'
export const REMINDER_CLOSE = '</system-reminder>'

/**
 * Compose the injected text: one message, two sections, so the relative order inside the
 * message is fixed (two separate messages would have an unspecified order).
 * @returns {string} the framed reminder text.
 */
export function injectionText() {
  return [REMINDER_OPEN, UE_WORKSPACE_BODY, '', AURA_WORKSPACE_BODY, REMINDER_CLOSE].join('\n')
}

/**
 * Read a live session's event log across DSH versions: 0.1.5-alpha.1 removed the `events`
 * getter in favour of `snapshotEvents()`; older builds expose the getter.
 * @param {object} session - the live session.
 * @returns {readonly any[]} the events (possibly empty).
 */
export function sessionEventsOf(session) {
  if (session === null || typeof session !== 'object') return []
  if (typeof session.snapshotEvents === 'function') {
    const events = session.snapshotEvents()
    return Array.isArray(events) ? events : []
  }
  if (Array.isArray(session.events)) return session.events
  return []
}

/**
 * Whether the session already produced an assistant message (its first round is over).
 * @param {object} session - the live session.
 * @returns {boolean} true when any assistant message is logged.
 */
export function hasAssistantMessage(session) {
  return sessionEventsOf(session).some((event) => event.type === 'assistant/message')
}

/**
 * Whether this plugin already injected its reminder into the session (durable dedup).
 * @param {object} session - the live session.
 * @param {string} [pluginName] - the identity to look for.
 * @returns {boolean} true when this plugin already injected.
 */
export function hasOwnInstruction(session, pluginName = INJECTION_SOURCE_PLUGIN) {
  const kind = `plugin:${pluginName}`
  return sessionEventsOf(session).some((event) => {
    if (event.type !== 'user/message') return false
    const source = event.data && event.data.source
    return typeof source === 'object' && source !== null && source.kind === kind
  })
}

/**
 * Register the injection on the `agent/pre-step` waterfall.
 * @param {object} ctx - the plugin context.
 * @param {object} options - registration inputs.
 * @param {(cwd: string) => Promise<boolean>} options.isUeProject - the UE project probe.
 * @param {(message: string) => void} options.log - logger.
 * @returns {(dispose: Function) => void} nothing; the handler lives on the fiber.
 */
export function registerPromptInjection(ctx, { isUeProject, log }) {
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    if (decision === undefined || decision === null) return decision
    // ① Respect a rejected step: never resurrect it.
    if (decision.kind === 'reject') return decision
    const session = agent === null || agent === undefined ? undefined : agent.session
    const body = Array.isArray(decision.messages) ? decision.messages : null
    if (session === undefined || session === null || body === null || body.length === 0) return decision
    // ② First step only + durable dedup.
    if (hasAssistantMessage(session) || hasOwnInstruction(session)) return decision
    const header = session.header
    const cwd = header !== null && typeof header === 'object' && typeof header.cwd === 'string' ? header.cwd : ''
    if (cwd.length === 0) return decision
    // ③ Never inject into a subagent's own session. The grouping pass already skips
    // `origin === 'subagent'`; without the same gate here, a subagent spawned inside an
    // Unreal project would receive the whole workspace contract as a plugin message --
    // noise it was not started to act on. (2026-09-20 audit.)
    if (header !== null && typeof header === 'object' && header.origin === 'subagent') return decision
    // ④ UE project gate (a *.uproject on disk), NOT an AGENTS.md gate.
    if (!(await isUeProject(cwd))) return decision
    const reminder = createUserMessage({
      content: [{ type: 'text', text: injectionText() }],
      source: { kind: INJECTION_SOURCE_KIND },
    })
    const claimed = Array.isArray(messages) ? messages : []
    const lastClaimedIndex = body.findLastIndex((message) => claimed.includes(message))
    const insertAt = lastClaimedIndex < 0 ? body.length : lastClaimedIndex + 1
    log(`prompt injected into ${String(header.id ?? '').slice(0, 8)} (cwd=${cwd})`)
    return { ...decision, messages: body.toSpliced(insertAt, 0, reminder) }
  })
  return undefined
}
