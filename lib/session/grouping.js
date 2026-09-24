/**
 * Workspace grouping and in-workspace ordering.
 *
 * Ported from `AuraWorkspaceSync.plugin.mjs` with the behaviour kept intact:
 *
 *   1. `registry.create(cwd, baseName(cwd))` is idempotent — an existing row for the
 *      directory is reused.
 *   2. `ws.attachSession(id)` PREPENDS. The sidebar renders `sessionIds` in stored order,
 *      so a bulk pass would stack a whole batch at the top in `list()` order. Every
 *      freshly attached session is therefore re-placed by recency.
 *   3. `insertSessionBefore(id, anchor)` puts it back where its recency belongs.
 *
 * @module dsh-aura/lib/session/grouping
 */

/**
 * Last path segment of a directory path (works with `\` and `/`).
 * @param {string} p - the path.
 * @returns {string} the base name.
 */
export function baseName(p) {
  const parts = String(p).split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : String(p)
}

/**
 * Place one session where its recency belongs inside a workspace row.
 *
 * The anchor is the first sibling that is OLDER than this session; when none is older the
 * session is appended by omitting the anchor, as supported by WorkspaceEntity.
 * @param {object} ws - the workspace entity.
 * @param {string} sessionId - the session to place.
 * @param {(id: string) => number} recencyOf - recency in epoch ms.
 * @param {(message: string) => void} [log] - logger for non-fatal placement failures.
 * @returns {Promise<{moved: boolean, anchor: string|null, reason?: string}>} the outcome.
 */
export async function placeByRecency(ws, sessionId, recencyOf, log) {
  try {
    const order = Array.from(ws.sessionIds).map(String)
    if (order.length < 2) return { moved: false, anchor: null, reason: 'sole-session' }
    const rest = order.filter((id) => id !== sessionId)
    if (rest.length === 0) return { moved: false, anchor: null, reason: 'sole-session' }
    const mine = recencyOf(sessionId)
    let anchor
    for (const id of rest) {
      if (recencyOf(id) < mine) {
        anchor = id
        break
      }
    }
    const targetIndex = anchor === undefined ? rest.length : rest.indexOf(anchor)
    if (order.indexOf(sessionId) === targetIndex) return { moved: false, anchor: anchor ?? null, reason: 'already-placed' }
    await ws.insertSessionBefore(sessionId, anchor)
    return { moved: true, anchor: anchor ?? null }
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    if (typeof log === 'function') log(`place failed for ${sessionId}: ${message}`)
    return { moved: false, anchor: null, reason: message }
  }
}

/**
 * Attach every given session of one project directory to its workspace row, then place
 * each one by recency.
 * @param {object} options - grouping inputs.
 * @param {object} options.registry - the `workspaceRegistry` service.
 * @param {string} options.cwd - the Unreal project directory.
 * @param {string[]} options.ids - session ids belonging to that directory.
 * @param {(id: string) => number} options.recencyOf - recency in epoch ms.
 * @param {(message: string) => void} [options.log] - logger.
 * @returns {Promise<{dir: string, sessions: number, attached: number, placed: number, workspace: object}>} the report entry.
 */
export async function groupProject({ registry, cwd, ids, recencyOf, log }) {
  const ws = await registry.create(cwd, baseName(cwd))
  const owned = new Set(Array.from(ws.sessionIds ?? []).map(String))
  let attached = 0
  let placed = 0
  for (const id of ids) {
    if (!owned.has(id)) {
      await ws.attachSession(id)
      attached += 1
    }
    const outcome = await placeByRecency(ws, id, recencyOf, log)
    if (outcome.moved) placed += 1
  }
  return { dir: cwd, sessions: ids.length, attached, placed, workspace: ws }
}

/**
 * Partition session snapshots into `cwd -> [sessionId]`, keeping only UE project sessions.
 *
 * Subagent-origin sessions and sessions without a `cwd` are skipped, exactly as the
 * previous implementation did.
 * @param {object} options - scan inputs.
 * @param {Array<any>} options.snapshots - `persistence.list()` output.
 * @param {(cwd: string) => Promise<boolean>} options.isUeProject - the UE probe.
 * @returns {Promise<Map<string, string[]>>} the grouping map.
 */
export async function collectUeProjectSessions({ snapshots, isUeProject }) {
  /** @type {Map<string, string[]>} */
  const byDir = new Map()
  for (const snapshot of snapshots ?? []) {
    const header = snapshot && snapshot.header
    if (!header) continue
    if (header.origin === 'subagent') continue
    const cwd = typeof header.cwd === 'string' ? header.cwd : ''
    if (cwd.length === 0) continue
    const id = String(header.id ?? '')
    if (id.length === 0) continue
    if (!(await isUeProject(cwd))) continue
    const list = byDir.get(cwd)
    if (list === undefined) byDir.set(cwd, [id])
    else list.push(id)
  }
  return byDir
}
