/**
 * Channel A / Channel B detection and the duplicate-row guard.
 *
 * THE RULE
 * --------
 * The four row ids (`dsh-aura`, `mcp-aura-unreal-inspector`, `mcp-aura-unreal-editor`,
 * `mcp-unreal-engine`) may be provided by exactly ONE channel at a time:
 *
 *   - **Channel A** — the profile's own patch layer
 *     (`~/.dsh/profiles/web/cordis.patch.yml`), which is watched while the harness runs,
 *     so a row inserted there takes effect without a restart. This is the default.
 *   - **Channel B** — this package's `cordis.patch.yml`, read only when `dsh-aura` is in
 *     `dsh.profile.bundles` AND the package declares `dsh.bundle.patch`. A bundle list is
 *     composed only at startup, so Channel B needs a restart.
 *
 * Both providing one id makes `Loader.update()` throw
 * `TypeError: duplicate loader entry id: <id>` and the WHOLE profile fails to boot — not
 * just this plugin. That is why the file-level guard exists in addition to the runtime
 * self-check: in a conflict the process never starts, so the self-check never runs.
 *
 * Parses YAML without evaluating any loader expressions.
 *
 * @module dsh-aura/lib/mcp/channels
 */

import { AURA_PACKAGE_NAME, AURA_ROW_ID, ownedRowIds } from './rows.js'
import { insertedRows } from './patch-yaml.js'

/** Channel names. */
export const CHANNELS = { A: 'A', B: 'B', NONE: 'none', CONFLICT: 'conflict' }

/**
 * Inserted row IDs in file order, with repeats preserved. YAML handles quoting,
 * comments and aliases; id-targeted overrides do not provide additional rows.
 *
 * `dsh --dump-config` cannot be used for this: `composeEntries` collapses rows into a
 * `Map` by id, so duplicates are silently folded and the dump looks clean.
 * @param {string} patchText - the patch file text.
 * @returns {string[]} the row ids, repeats included.
 */
export function collectRowIds(patchText) {
  return insertedRows(patchText).map((row) => row.id).filter((id) => typeof id === 'string')
}

/**
 * Whether one patch text provides a given row id.
 * @param {string} patchText - the patch file text.
 * @param {string} id - the row id.
 * @returns {boolean} true when present.
 */
export function patchProvides(patchText, id) {
  return collectRowIds(patchText).includes(id)
}

/**
 * Row IDs inserted more than once, within or across the given sources.
 * @param {Array<{source: string, text: string}>} sources - the patch sources.
 * @returns {Array<{id: string, sources: string[]}>} conflicting ids with their providers.
 */
export function findRowConflicts(sources) {
  /** @type {Map<string, string[]>} */
  const providers = new Map()
  for (const source of sources ?? []) {
    for (const id of collectRowIds(source.text)) {
      const list = providers.get(id)
      if (list === undefined) providers.set(id, [source.source])
      else list.push(source.source)
    }
  }
  const conflicts = []
  for (const [id, list] of providers) {
    if (list.length > 1) conflicts.push({ id, sources: list })
  }
  return conflicts
}

/**
 * Assert that no row id is provided twice.
 * @param {Array<{source: string, text: string}>} sources - the patch sources.
 * @returns {Array<{id: string, sources: string[]}>} the (empty) conflict list.
 * @throws {Error} when a row id has more than one provider.
 */
export function assertSingleOwner(sources) {
  const conflicts = findRowConflicts(sources)
  if (conflicts.length > 0) {
    const detail = conflicts.map((entry) => `${entry.id} (${entry.sources.join(' + ')})`).join(', ')
    throw new Error(
      `dsh-aura: duplicate loader row id(s): ${detail}. ` +
        `Providing the same id from two layers makes the loader throw "TypeError: duplicate loader entry id" and the whole profile fails to boot.`,
    )
  }
  return conflicts
}

/**
 * Classify parsed patch entries: which ones only INSERT, which ones target an existing id.
 *
 * A patch entry that names an id OVERRIDES that row (and a `disabled: true` entry disables
 * it). Both are legitimate YAML, and both are forbidden for this package: it must only
 * ever add its own rows, never reach into somebody else's.
 * @param {Array<any>} patches - parsed patch entries (plain objects; `!!js` nodes may remain).
 * @returns {{inserts: Array<{index: number, ids: string[]}>, targets: Array<{index: number, id: string, keys: string[]}>, foreignInsertIds: string[]}} the classification.
 */
export function classifyPatchEntries(patches) {
  const inserts = []
  const targets = []
  const foreignInsertIds = []
  const owned = new Set(ownedRowIds())
  const list = Array.isArray(patches) ? patches : []
  list.forEach((patch, index) => {
    if (patch === null || typeof patch !== 'object') return
    if (Array.isArray(patch.insert)) {
      const ids = []
      for (const row of patch.insert) {
        if (row === null || typeof row !== 'object') continue
        const id = typeof row.id === 'string' ? row.id : ''
        if (id.length === 0) continue
        ids.push(id)
        if (!owned.has(id)) foreignInsertIds.push(id)
      }
      inserts.push({ index, ids })
      return
    }
    if (typeof patch.id === 'string') {
      const keys = Object.keys(patch).filter((key) => key !== 'id')
      /**
       * Inserting into an existing GROUP by id is not an override of that row's own
       * config — it appends children. The package never does it, but the classifier
       * distinguishes the two so the assertion can stay honest.
       */
      targets.push({ index, id: patch.id, keys: Array.isArray(patch.insert) ? ['insert(group)'] : keys })
    }
  })
  return { inserts, targets, foreignInsertIds }
}

/**
 * GATE 1 (file level): assert a patch list only INSERTS this package's own rows.
 *
 * This is the assertion the package makes about its own `cordis.patch.yml`: it may only
 * add rows, never override or disable an id it does not own. Overrides are legitimate
 * for a user's profile; this bundle deliberately limits its scope to its own inserts.
 * @param {Array<any>} patches - parsed patch entries.
 * @param {string} [where] - label used in the error message.
 * @returns {void}
 * @throws {Error} when an entry targets another id, inserts a foreign id, or disables something.
 */
export function assertOnlyOwnInserts(patches, where = 'patch') {
  const { targets, foreignInsertIds } = classifyPatchEntries(patches)
  const problems = []
  for (const target of targets) {
    problems.push(`entry #${target.index + 1} targets id "${target.id}" (${target.keys.join(', ') || 'no keys'})`)
  }
  if (foreignInsertIds.length > 0) {
    problems.push(`inserting foreign row id(s): ${foreignInsertIds.join(', ')}`)
  }
  for (const [index, patch] of (Array.isArray(patches) ? patches : []).entries()) {
    if (patch !== null && typeof patch === 'object' && 'disabled' in patch) problems.push(`entry #${index + 1} sets "disabled"`)
  }
  if (problems.length > 0) {
    throw new Error(
      `${where}: this package may only insert its own rows — ${problems.join('; ')}. ` +
        `Overriding or disabling another source's id changes another plugin's behaviour.`,
    )
  }
}

/**
 * Decide which channel currently provides this package's rows.
 * @param {object} options - inputs.
 * @param {boolean} options.inBundleList - `dsh-aura` listed in `dsh.profile.bundles`.
 * @param {string} options.profilePatchText - the profile's `cordis.patch.yml` text.
 * @param {string} [options.bundlePatchText] - this package's `cordis.patch.yml` text.
 * @returns {{channel: 'A'|'B'|'none'|'conflict', auraRowInProfile: boolean, auraRowInBundle: boolean, conflicts: Array<{id: string, sources: string[]}>}} the decision.
 */
export function detectChannel({ inBundleList, profilePatchText, bundlePatchText = '' }) {
  const auraRowInProfile = patchProvides(profilePatchText, AURA_ROW_ID)
  const auraRowInBundle = patchProvides(bundlePatchText, AURA_ROW_ID)
  const sources = []
  if (typeof profilePatchText === 'string' && profilePatchText.length > 0) sources.push({ source: 'profile-layer', text: profilePatchText })
  if (inBundleList && typeof bundlePatchText === 'string' && bundlePatchText.length > 0) {
    sources.push({ source: 'bundle-layer', text: bundlePatchText })
  }
  const conflicts = findRowConflicts(sources)
  if (conflicts.length > 0) return { channel: CHANNELS.CONFLICT, auraRowInProfile, auraRowInBundle, conflicts }
  if (auraRowInProfile && inBundleList) return { channel: CHANNELS.CONFLICT, auraRowInProfile, auraRowInBundle, conflicts }
  if (inBundleList) return { channel: CHANNELS.B, auraRowInProfile, auraRowInBundle, conflicts }
  if (auraRowInProfile) return { channel: CHANNELS.A, auraRowInProfile, auraRowInBundle, conflicts }
  return { channel: CHANNELS.NONE, auraRowInProfile, auraRowInBundle, conflicts }
}

/** Bare package name of this package (re-exported for callers that only import this module). */
export const PACKAGE_NAME = AURA_PACKAGE_NAME
