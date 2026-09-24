/**
 * The polling pass: list sessions, group UE project sessions, place them by recency,
 * backfill `[router] …` titles, then report.
 *
 * Every constraint that made the previous implementation work is kept:
 *   - one pass at a time (`running` guard);
 *   - `titleFixPerPass` budget, so a single pass cannot take hold of every ACP session;
 *   - a session taken by an ACP child is left alone (`open` failure = `busy` = retry next
 *     pass, never a retry loop, never a wait);
 *   - an `inspected` set only after the title and its projection have settled;
 *   - a rotating cursor so busy sessions cannot monopolize every pass's budget.
 *
 * WHAT AN UNWRITABLE SESSION STILL NEEDS (added 2026-09-20)
 *
 * "Left alone" used to mean "left invisible". Aura drives DSH from its OWN host process, so
 * the conversation's session is held for writing by that process for as long as Aura has the
 * tab — and the Web GUI is a different host with its own projection cache, snapshotted at
 * boot. The two together produced the reported symptom: the session WAS in the right
 * workspace, but its sidebar row read as the bare directory name (`Test`), because a cold
 * row's title comes only from `sessionProjectionCache.cachedSnapshot(header)`
 * (`api-session-controller`) and that host had no record for it.
 *
 * The title is already in the log. Folding the log READ-ONLY
 * ({@link module:dsh-aura/lib/session/projector.refoldSession}) puts it in this host's cache
 * without writing a byte to a session another process owns, and without waiting for it. The
 * rename itself still waits for the holder to let go: the read-only path adds nothing to
 * `inspected`.
 *
 * The gate is the sidebar's own question — "does this host already have a TITLE for the
 * session?" — answered by the cache with no I/O. So a row that already reads correctly costs
 * nothing, and the fold happens only for the rows that would render nameless.
 *
 * @module dsh-aura/lib/pass
 */

import { emitPassReport } from './log.js'
import { collectUeProjectSessions, groupProject } from './session/grouping.js'
import { refoldSession } from './session/projector.js'
import { decideTitle, inspectLog, isRouterTitle, titleEvent } from './session/title-backfill.js'
import { createRecencyIndex } from './session/recency.js'
import { inspectPolicyStatus } from './policy-status.js'

/**
 * Create the pass runner for one plugin activation.
 * @param {object} options - runner inputs.
 * @param {object} options.services - the resolved services.
 * @param {object} options.services.persistence - `sessionPersistence`.
 * @param {object} options.services.registry - `workspaceRegistry`.
 * @param {object|undefined} options.services.projectionCache - `sessionProjectionCache`.
 * @param {(cwd: string) => Promise<boolean>} options.isUeProject - the UE probe.
 * @param {object} options.config - effective config.
 * @param {(message: string) => void} options.log - logger.
 * @param {(message: string) => void} [options.warn] - warning logger (console.warn).
 * @returns {(tag: string) => Promise<object>} the pass runner (never rejects).
 */
export function createPassRunner({ services, isUeProject, config, log, warn }) {
  const { persistence, registry, projectionCache } = services
  const recency = createRecencyIndex(projectionCache)
  /** Session ids whose title is already settled in this process. */
  const inspected = new Set()
  let running = false
  let nextTitleId
  let policyLastProbedAt = 0
  /** Unreal project directories seen by the last pass — exposed through the policy log line. */
  let lastProjectDirs = []

  /**
   * Whether this host can ALREADY show the session's title.
   *
   * This is the sidebar's own question, asked the same way `api-session-controller`'s
   * listing asks it — `cachedSnapshot(header)`. What matters is the `title` value in what comes back,
   * because a row WITHOUT one is exactly the row that renders as the bare directory name.
   * Two shapes reach that state, and both were observed: a cache that holds nothing at all
   * (the reported case — the owning host's checkpoint landed after this host booted), and a
   * cache holding a checkpoint written before the title existed (reproduced in the sandbox).
   * Answered from the cache domain's in-memory state, so it costs no I/O.
   * @param {object|undefined} header - the session's listed header.
   * @returns {boolean} true when the listing already carries a title for this session.
   */
  function listingHasTitle(header) {
    if (header === undefined || projectionCache === undefined || projectionCache === null) return false
    if (typeof projectionCache.cachedSnapshot !== 'function') return false
    try {
      const cut = projectionCache.cachedSnapshot(header)
      const title = cut === undefined || cut === null ? undefined : cut.values?.title
      return typeof title === 'string' && title !== '' && !isRouterTitle(title)
    } catch {
      return false
    }
  }

  /**
   * Fold a foreign session's stored log into THIS host's projection cache, read-only.
   *
   * Called only when the write path lost the session to another process AND this host has no
   * title for it, i.e. when its sidebar row would render as the bare directory name.
   * Nothing is appended and nothing is waited for: the log stays the truth, the holder keeps
   * exclusive write ownership, and a failure degrades to `busy` so the next pass retries.
   * @param {string} sessionId - the session to surface.
   * @param {object|undefined} header - the session's listed header (the cache's identity witness).
   * @returns {Promise<string>} `visible` (nothing to do), `surfaced(<events>)`, or `busy`.
   */
  async function surfaceStoredTitle(sessionId, header) {
    if (listingHasTitle(header)) return 'visible'
    let handle
    try {
      // `read` takes no ownership: it is the one open that succeeds while another process
      // holds the write lease, and while THIS process holds the in-process write claim.
      handle = await persistence.open(sessionId, 'read')
    } catch {
      return 'busy'
    }
    if (handle === undefined || handle === null || typeof handle.read !== 'function') {
      try {
        await handle?.close?.()
      } catch {
        /* already closed */
      }
      return 'busy'
    }
    try {
      const outcome = await refoldSession({ handle, projectionCache, log })
      // Current DSH returns the folded snapshot before its cache write completes.
      // The fold has been scheduled, but the sidebar may need another moment to see it.
      if (outcome.reason === 'cache-pending') return `surfaced-pending(${outcome.events})`
      if (!outcome.refolded) return 'busy'
      return `surfaced(${outcome.events})`
    } catch {
      return 'busy'
    } finally {
      try {
        await handle.close()
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * Settle one session's title.
   * @param {string} sessionId - the session id.
   * @param {object|undefined} header - the session's listed header.
   * @returns {Promise<string>} the outcome token (kept close to the previous plugin's).
   */
  async function settleTitle(sessionId, header) {
    if (inspected.has(sessionId)) return 'settled'
    let handle
    try {
      handle = await persistence.open(sessionId, 'write')
    } catch {
      // Held by an ACP child: its memory still owns the last seq, so writing now would
      // collide. Back off to the next pass; do NOT retry and do NOT wait. The title can
      // still be MADE VISIBLE here without writing — see `surfaceStoredTitle`.
      return await surfaceStoredTitle(sessionId, header)
    }
    if (handle === undefined || handle === null || typeof handle.read !== 'function') {
      try {
        await handle?.close?.()
      } catch {
        /* already closed */
      }
      return 'busy'
    }
    try {
      const res = await handle.read()
      const events = res && Array.isArray(res.events) ? res.events : []
      const facts = inspectLog(events)
      const decision = decideTitle(facts, config.titleMaxChars)
      if (decision.kind === 'keep') {
        // A prior append may have succeeded while its projection refresh failed,
        // including before this activation. Reconcile from the log before settling.
        const outcome = await refoldSession({ handle, projectionCache, log })
        if (!outcome.refolded) return 'projection-pending'
        inspected.add(sessionId)
        return 'keep'
      }
      if (decision.kind === 'empty') {
        // An empty session may receive its first prompt later.
        return 'empty'
      }
      await handle.append([titleEvent(decision.title, facts.lastSeq)])
      await handle.flush()
      const outcome = await refoldSession({ handle, projectionCache, log })
      if (outcome.refolded) inspected.add(sessionId)
      return `renamed(${facts.turns}t):${decision.title}`
    } catch (error) {
      return `failed:${String(error && error.message ? error.message : error).slice(0, 120)}`
    } finally {
      try {
        await handle.close()
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * Run one pass.
   * @param {string} tag - `initial` or `poll`.
   * @returns {Promise<object>} the report.
   */
  return async function pass(tag) {
    if (running) return { tag, skipped: 'already-running' }
    running = true
    const started = Date.now()
    const report = { tag, projects: [], attached: 0, renamed: 0, titles: [] }
    try {
      const snapshots = await persistence.list()
      recency.reset(snapshots)
      const headerById = new Map(snapshots.map((snapshot) => [String(snapshot?.header?.id ?? ''), snapshot?.header]))
      const byDir = await collectUeProjectSessions({ snapshots, isUeProject })
      lastProjectDirs = Array.from(byDir.keys())

      for (const [cwd, ids] of byDir) {
        const entry = await groupProject({ registry, cwd, ids, recencyOf: recency.recencyOf, log: warn ?? log })
        report.attached += entry.attached
        report.projects.push({ dir: entry.dir, sessions: entry.sessions, attached: entry.attached })
      }
      const candidates = [...new Set([...byDir.values()].flat())].filter((id) => !inspected.has(id))
      const start = Math.max(0, candidates.indexOf(nextTitleId))
      const count = Math.min(candidates.length, Math.max(0, Math.floor(config.titleFixPerPass)))
      for (let offset = 0; offset < count; offset += 1) {
        const id = candidates[(start + offset) % candidates.length]
        nextTitleId = candidates[(start + offset + 1) % candidates.length]
        const outcome = await settleTitle(id, headerById.get(id))
        if (outcome.startsWith('renamed')) report.renamed += 1
        // `visible` is the steady state of a session another host owns: the row already
        // reads correctly, so it is not an exception and must not be reported as one.
        if (outcome !== 'keep' && outcome !== 'settled' && outcome !== 'visible') {
          report.titles.push(`${id.slice(0, 8)} ${outcome}`)
        }
      }
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      log(`${tag} failed: ${message}`)
      report.error = message
    } finally {
      running = false
    }
    emitPassReport(tag, Date.now() - started, report, config.reportEnabled, log)
    if (config.policyProbeEnabled && config.reportEnabled) {
      const now = Date.now()
      if (now - policyLastProbedAt >= config.policyProbeMs) {
        policyLastProbedAt = now
        void inspectPolicyStatus({
          url: config.policyProbeUrl,
          timeoutMs: config.policyProbeTimeoutMs,
          ueProjectDirs: lastProjectDirs,
          log,
        })
      }
    }
    return report
  }
}
