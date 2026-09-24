/**
 * Session recency — the sort key the sidebar itself shows.
 *
 * `max(header.createdAt, projection.sessionListMetadata.lastPromptAt)`, memoized per
 * pass. `cachedSnapshot` is a zero-IO read of the persisted projection checkpoint, so
 * this never touches the session log.
 *
 * @module dsh-aura/lib/session/recency
 */

/**
 * Build a per-pass recency index.
 * @param {object|undefined} projectionCache - the `sessionProjectionCache` service, if any.
 * @returns {{ reset: (snapshots: Iterable<any>) => void, recencyOf: (id: string) => number, size: () => number }}
 *   the index.
 */
export function createRecencyIndex(projectionCache) {
  /** @type {Map<string, any>} */
  let snapshotById = new Map()
  /** @type {Map<string, number>} */
  const memo = new Map()

  function reset(snapshots) {
    snapshotById = new Map()
    memo.clear()
    for (const snapshot of snapshots ?? []) {
      const header = snapshot && snapshot.header
      if (header === undefined || header === null) continue
      const id = String(header.id ?? '')
      if (id.length === 0) continue
      snapshotById.set(id, snapshot)
    }
  }

  function recencyOf(id) {
    const key = String(id)
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    let at = 0
    try {
      const snapshot = snapshotById.get(key)
      const header = snapshot === undefined ? undefined : snapshot.header
      if (header !== undefined) {
        at = Number(header.createdAt) || 0
        if (projectionCache !== undefined && projectionCache !== null && typeof projectionCache.cachedSnapshot === 'function') {
          const view = projectionCache.cachedSnapshot(header)
          const values = view === undefined ? undefined : view.values
          const meta = values === undefined ? undefined : values.sessionListMetadata
          if (meta !== undefined && typeof meta.lastPromptAt === 'number' && meta.lastPromptAt > at) at = meta.lastPromptAt
        }
      }
    } catch {
      /* keep the createdAt fallback */
    }
    memo.set(key, at)
    return at
  }

  return { reset, recencyOf, size: () => snapshotById.size }
}
