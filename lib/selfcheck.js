/**
 * Startup self-check: is this plugin the only owner of the wiring, and which channel
 * provides the rows?
 *
 * The loader is the only component that knows which rows are actually mounted, so it is
 * asked — opportunistically, via `ctx.get('loader')`. It is deliberately NOT declared in
 * `inject`: the self-check is optional, and declaring a service with no benefit can only
 * widen what has to resolve before the plugin may activate. When the loader is not
 * reachable the check says so instead of reporting "all good".
 *
 * Two things are checked:
 *   1. **Sole owner.** The old `aura-workspace-sync` row must be gone. If both the old
 *      plugin and this one run, every session is grouped twice and the old plugin appends
 *      a second `session/title` (its `inspected` set is per-process).
 *   2. **Row duplication.** Each row id this package owns must appear at most once. A
 *      second provider means the loader already threw
 *      `TypeError: duplicate loader entry id` — this branch exists for the
 *      partially-mounted / hand-recovered case.
 *
 * It also reports that `tools` was NOT touched, because the package must never register a
 * tool: a second `set_session_title` would shadow `dsh-session-title-local` depending on
 * load order.
 *
 * @module dsh-aura/lib/selfcheck
 */

import { AURA_PACKAGE_NAME, AURA_ROW_ID, ownedRowIds, rowIdFor, SERVER_NAMES } from './mcp/rows.js'

/** Row-name fragments of the plugin this package replaces. */
export const LEGACY_ROW_PATTERNS = ['AuraWorkspaceSync.plugin.mjs', 'aura-workspace-sync', 'Sync-DshWorkspaces']

/**
 * Read the loader's entries, or nothing when the service is unreachable.
 * @param {object} ctx - the plugin context.
 * @returns {{entries: any[]|null, reason?: string}} entries or a reason string.
 */
export function readLoaderEntries(ctx) {
  try {
    const loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined
    if (loader === undefined || loader === null) return { entries: null, reason: 'loader service absent' }
    if (typeof loader.entries !== 'function') return { entries: null, reason: 'loader has no entries()' }
    const entries = loader.entries()
    if (Array.isArray(entries)) return { entries }
    if (entries !== null && typeof entries === 'object' && typeof entries[Symbol.iterator] === 'function') {
      return { entries: Array.from(entries) }
    }
    return { entries: null, reason: 'loader entries() is not iterable' }
  } catch (error) {
    return { entries: null, reason: String(error && error.message ? error.message : error) }
  }
}

/**
 * Row name of one loader entry (the `name` option the loader resolves).
 * @param {any} entry - a loader entry.
 * @returns {string} the name, or '' when unknown.
 */
function entryName(entry) {
  const name = entry && entry.options && entry.options.name
  return typeof name === 'string' ? name : ''
}

/**
 * Row id of one loader entry.
 * @param {any} entry - a loader entry.
 * @returns {string} the id, or '' when unknown.
 */
function entryId(entry) {
  const id = entry && (entry.id ?? (entry.options && entry.options.id))
  return typeof id === 'string' ? id : ''
}

/**
 * Derive which channel provides this package's row, from the loader's own entries.
 *
 * Channel B points the row at the BARE package name (a bundle layer resolves through the
 * profile's module fallback); Channel A points it at an absolute path, which the loader
 * rewrites to a `file://` URL. No file IO is involved, so this works at apply time.
 * @param {object} ctx - the plugin context.
 * @returns {'A'|'B'|'none'|'conflict'|'unknown'} the channel.
 */
export function channelFromEntries(ctx) {
  const { entries } = readLoaderEntries(ctx)
  if (entries === null) return 'unknown'
  let bare = 0
  let path = 0
  for (const entry of entries) {
    if (entryId(entry) !== AURA_ROW_ID) continue
    const rowName = entryName(entry)
    if (rowName === AURA_PACKAGE_NAME) bare += 1
    else if (rowName.startsWith('file:')) path += 1
  }
  if (bare > 0 && path > 0) return 'conflict'
  if (bare > 0) return 'B'
  if (path > 0) return 'A'
  return 'none'
}

/**
 * Run the self-check and log one line.
 * @param {object} ctx - the plugin context.
 * @param {(message: string) => void} log - logger.
 * @param {object} [options] - check options.
 * @param {string} [options.channel] - the channel resolved by `lib/mcp/channels.js`.
 * @returns {{owner: 'sole'|'duplicate'|'unreachable', channel: string, duplicates: string[], legacy: string[], tools: string, reason?: string}} the conclusion.
 */
export function runSelfCheck(ctx, log, options = {}) {
  const channel = typeof options.channel === 'string' ? options.channel : 'unknown'
  const toolsService = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  const tools = toolsService === undefined ? 'absent' : 'present-not-used'
  const { entries, reason } = readLoaderEntries(ctx)
  if (entries === null) {
    // The exact contract string from the design: "could not tell" must never read as "passed".
    log(`selfcheck skipped: loader service not reachable from here (${reason ?? 'unknown reason'}; channel=${channel}, tools=${tools})`)
    return { owner: 'unreachable', channel, duplicates: [], legacy: [], tools, reason }
  }

  const legacy = []
  for (const entry of entries) {
    const name = entryName(entry)
    if (name.length === 0) continue
    for (const pattern of LEGACY_ROW_PATTERNS) {
      if (name.includes(pattern)) {
        legacy.push(name)
        break
      }
    }
  }

  const owned = new Set(ownedRowIds())
  const counts = new Map()
  for (const entry of entries) {
    const id = entryId(entry)
    if (id.length === 0 || !owned.has(id)) continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const duplicates = Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([id]) => id)

  const owner = legacy.length > 0 ? 'duplicate' : 'sole'
  if (owner === 'duplicate') {
    log(`selfcheck owner=DUPLICATE id=${legacy.join(',')} — 两个实例会双跑（归组重复 + 两条 session/title），先删掉旧行`)
  } else if (duplicates.length > 0) {
    log(`selfcheck owner=sole but row id duplicated: ${duplicates.join(',')} — profile 会起不来，用 Sync-AuraMcp.mjs --check 定位`)
  } else {
    const expected = [AURA_ROW_ID, ...SERVER_NAMES.map(rowIdFor)]
    const mounted = expected.filter((id) => counts.has(id))
    log(`selfcheck owner=sole channel=${channel} loader=ok rows=${mounted.length}/${expected.length} tools=${tools}`)
  }
  return { owner, channel, duplicates, legacy, tools }
}

/**
 * Which channel currently provides the four row ids, from the composition point of view.
 *
 * Kept here as a pure helper so the pass/self-check never needs the file system: the
 * file-level decision lives in `lib/mcp/channels.js` (with `Sync-AuraMcp.mjs`).
 * @param {object} options - inputs.
 * @param {boolean} options.inBundleList - is `dsh-aura` listed in `dsh.profile.bundles`?
 * @param {boolean} options.inProfilePatch - does the profile patch provide `id: dsh-aura`?
 * @returns {'A'|'B'|'none'|'conflict'} the channel.
 */
export function resolveChannel({ inBundleList, inProfilePatch }) {
  if (inBundleList && inProfilePatch) return 'conflict'
  if (inBundleList) return 'B'
  if (inProfilePatch) return 'A'
  return 'none'
}
