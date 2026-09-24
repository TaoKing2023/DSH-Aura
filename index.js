/**
 * dsh-aura — one DSH plugin package for the local DSH x UE5/Aura wiring.
 *
 * WHAT IT OWNS
 *   1. The three Aura MCP loader rows (rendered by `lib/mcp/rows.js`; the shipped
 *      `cordis.patch.yml` is the Channel B form, the profile patch is the Channel A form).
 *   2. Aura session grouping + `[router] …` title backfill + projection re-fold.
 *   3. The UE workspace prompt constraints, injected once per session as a plugin-sourced
 *      user message.
 *   4. Host-side visibility for the policy state (router project gate / permission pools)
 *      and for its own channel/ownership self-check.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - It registers NO tools and injects NEITHER `tools` NOR `sessionTitle`. A second
 *     `set_session_title` would shadow `dsh-session-title-local` depending on load order;
 *     that ownership stays where it is.
 *   - It offers no client half: every capability above is host-side, and a client bundle
 *     would add an approval surface without changing any wiring.
 *
 * NAMED EXPORTS ONLY (`name` / `inject` / `Config` / `apply`), no default export, per the
 * loader's `unwrapExports` contract.
 *
 * @module dsh-aura
 */

import { effectiveConfig } from './lib/config.js'
import { createLogger } from './lib/log.js'
import { createPassRunner } from './lib/pass.js'
import { registerPromptInjection } from './lib/prompt/inject.js'
import { AURA_ROW_ID } from './lib/mcp/rows.js'
import { channelFromEntries, runSelfCheck } from './lib/selfcheck.js'
import { createUeProjectProbe } from './lib/session/ue-project.js'

export { Config } from './lib/config.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-aura'

/**
 * Every service `apply` touches is declared here.
 *
 * This is not stylistic. Measured 2026-09-19 on the previous half of this wiring: with
 * only `timer` declared, `apply` ran during boot before the web app had registered
 * `workspaceRegistry`, hit its own guard and returned — and Cordis never re-applies a
 * plugin whose *undeclared* dependency shows up later, so that row stayed dead for the
 * whole process lifetime. Declaring them makes Cordis hold the fiber until every one
 * exists and re-activate on replacement.
 */
export const inject = ['timer', 'fs', 'sessionPersistence', 'workspaceRegistry', 'sessionProjectionCache']

/**
 * Apply the plugin.
 *
 * NOT guarded by an "already applied" set. Measured 2026-09-20 against the shipped
 * cordis: a fiber's `ctx` is created ONCE and reused across `update()` / `restart()` —
 * cordis calls `runtime.callback(this.ctx, …)` again on the same context — while every
 * `ctx.effect` / `ctx.on` the previous activation registered is disposed on unload. An
 * applied-once guard keyed on `ctx` therefore turned the second apply into a no-op that
 * armed nothing, leaving the fiber reporting `state: 2` (active) with zero timers and
 * zero handlers: silently dead, and it did not recover on a later edit.
 *
 * Re-applying is naturally idempotent without the guard: effects live in the fiber's
 * scope and are torn down with it, so each activation registers exactly one set.
 *
 * @param {object} ctx - the Cordis plugin context.
 * @param {unknown} config - the loader row's `config` (may be absent).
 * @returns {void}
 */
export function apply(ctx, config) {
  const cfg = effectiveConfig(config)
  const log = createLogger()
  const warn = (message) => {
    try {
      console.warn(`[dsh-aura] ${String(message)}`)
    } catch {
      /* never let logging take the plugin down */
    }
  }

  const timer = ctx.get('timer')
  const fs = ctx.get('fs')
  const persistence = ctx.get('sessionPersistence')
  const registry = ctx.get('workspaceRegistry')
  const projectionCache = ctx.get('sessionProjectionCache')

  const missing = []
  if (timer === undefined) missing.push('timer')
  if (fs === undefined) missing.push('fs')
  if (persistence === undefined) missing.push('sessionPersistence')
  if (registry === undefined) missing.push('workspaceRegistry')
  if (projectionCache === undefined) missing.push('sessionProjectionCache')
  if (missing.length > 0) {
    // Only reachable when a declared service is torn down again; keep it loud.
    log(`declared service(s) missing at apply: ${missing.join(', ')} -- nothing armed`)
    return
  }

  const channel = channelFromEntries(ctx)
  runSelfCheck(ctx, log, { channel })

  const isUeProject = createUeProjectProbe(fs, { cacheMs: cfg.ueProbeCacheMs })

  if (cfg.injectionEnabled) {
    registerPromptInjection(ctx, { isUeProject, log })
  } else {
    log('prompt injection disabled by config (injectionEnabled=false)')
  }

  const runPass = createPassRunner({
    services: { persistence, registry, projectionCache },
    isUeProject,
    config: cfg,
    log,
    warn,
  })

  // First-run delay is part of the previous implementation's observable behaviour: the web
  // app registers its services slightly after boot and the first pass should see them.
  ctx.effect(() => timer.timeout(() => runPass('initial'), cfg.initialDelayMs), 'dsh-aura-initial')
  ctx.effect(() => timer.interval(() => runPass('poll'), cfg.pollMs), 'dsh-aura-poll')

  log(
    `armed row=${AURA_ROW_ID} channel=${channel} pollMs=${cfg.pollMs} initialDelayMs=${cfg.initialDelayMs} ` +
      `titleFixPerPass=${cfg.titleFixPerPass} titleMaxChars=${cfg.titleMaxChars} injection=${cfg.injectionEnabled}`,
  )
}
