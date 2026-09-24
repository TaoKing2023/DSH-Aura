/**
 * Projection re-fold after a title backfill.
 *
 * WHY THIS EXISTS (measured, 2026-09-19): the sidebar list never folds a cold session's
 * log. `api-session-controller`'s `projectionsFor()` serves
 * `sessionProjectionCache.cachedSnapshot(header)`, and a stored checkpoint is accepted
 * on identity alone — it is never compared against the log for freshness. A title that
 * reaches only the log therefore stays invisible forever: 8 rows kept reading
 * `[router] …` while their logs already held the user's question.
 *
 * Rules:
 *   - `inheritedEventCount` is taken VERBATIM from `handle.inheritedEventCount`. Never
 *     recompute it and never substitute 0: for a forked/seeded session a wrong cut point
 *     folds the wrong log range.
 *   - Re-READ the log before folding. Folding "the events read before the append plus the
 *     event we just wrote" would miss concurrent appends.
 *   - Best-effort: a failure is logged and swallowed. The log is still the truth and the
 *     next pass retries.
 *
 * @module dsh-aura/lib/session/projector
 */

/**
 * Re-fold one session's log into the projection cache.
 * @param {object} options - refold inputs.
 * @param {object} options.handle - the open persistence handle (already written + flushed).
 * @param {object|undefined} options.projectionCache - the `sessionProjectionCache` service.
 * @param {(message: string) => void} [options.log] - logger for the degraded path.
 * @returns {Promise<{refolded: boolean, events: number, reason?: string}>} the outcome.
 */
export async function refoldSession({ handle, projectionCache, log }) {
  if (projectionCache === undefined || projectionCache === null || typeof projectionCache.coldSnapshot !== 'function') {
    return { refolded: false, events: 0, reason: 'no-projection-cache' }
  }
  try {
    const after = await handle.read()
    const all = after && Array.isArray(after.events) ? after.events : []
    if (all.length === 0) return { refolded: false, events: 0, reason: 'empty-log' }
    const inherited = Number(handle.inheritedEventCount) || 0
    const folded = await projectionCache.coldSnapshot(handle.header, inherited, all)
    const title = folded?.values?.title
    if (typeof title === 'string' && title !== '' && typeof projectionCache.cachedSnapshot === 'function') {
      const visible = projectionCache.cachedSnapshot(handle.header)?.values?.title
      if (visible !== title) return { refolded: false, events: all.length, reason: 'cache-pending' }
    }
    return { refolded: true, events: all.length }
  } catch (error) {
    const reason = String(error && error.message ? error.message : error)
    if (typeof log === 'function') {
      log(`projection refold failed (log stays authoritative, retried next pass): ${reason}`)
    }
    return { refolded: false, events: 0, reason }
  }
}
