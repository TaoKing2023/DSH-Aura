/**
 * The `# >>> aura-mcp managed >>>` block: locate it, replace it, or remove it — and refuse
 * to guess when the file is not in a known state.
 *
 * ALL OPERATIONS ARE LINE-BASED on purpose. The block is a slice of a hand-maintained
 * profile patch that contains unrelated rows, `!!js` overrides and a lot of explanatory
 * comments; re-serializing the YAML would rewrite all of it. Everything outside the block
 * is preserved byte for byte.
 *
 * Refusals (all inherited from `Sync-AuraMcp.ps1`, all covered by tests):
 *   - only ONE marker found            -> throw, never guess where the block ends;
 *   - a `serverName:` would appear twice -> refuse to write, point at `--migrate`;
 *   - the rendered content equals what is on disk -> `Already in sync`, no write.
 *
 * @module dsh-aura/lib/mcp/managed-block
 */

import { MANAGED_BEGIN, MANAGED_END } from './rows.js'

/**
 * The first `serverName:<name>` / `"serverName":"<name>"` occurrence in a line.
 *
 * Generated rows carry their serverName INSIDE the `!!js` expression (once in the fallback
 * literal and once per return branch), and hand-written rows carry it as a YAML key. Only
 * the first occurrence per ROW is used (see {@link countServerNames}); counting raw
 * occurrences would report every generated row as a duplicate of itself.
 */
const SERVER_NAME_FIRST = /serverName["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/

/** Matches a legacy hand-written MCP row id (what `--migrate` removes). */
const LEGACY_ROW_ID_LINE = /^\s*-\s+id:\s*(mcp-aura-[\w-]+|mcp-unreal-engine)\s*$/

/** Matches a top-level `- id: <x>` row id line. */
const ROW_ID_LINE = /^\s*-\s+id:\s*([^\s#]+)\s*$/

/**
 * Split text into lines without losing the information about a trailing newline.
 * @param {string} text - the file text.
 * @returns {{lines: string[], trailingNewline: boolean}} the split.
 */
function splitLines(text) {
  const source = typeof text === 'string' ? text : ''
  const trailingNewline = source.endsWith('\n')
  const body = trailingNewline ? source.slice(0, -1) : source
  return { lines: body.length === 0 ? [] : body.split('\n'), trailingNewline }
}

/**
 * Join lines back, preserving whether the file ended with a newline.
 * @param {string[]} lines - the lines.
 * @param {boolean} trailingNewline - whether to end with a newline.
 * @returns {string} the text.
 */
function joinLines(lines, trailingNewline) {
  const body = lines.join('\n')
  return trailingNewline ? `${body}\n` : body
}

/**
 * Strip a UTF-8 BOM and normalize line endings to LF (the file format the generator owns).
 * @param {string} text - the raw file text.
 * @returns {string} the normalized text.
 */
export function normalizePatchText(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
}

/**
 * Locate the managed block.
 * @param {string} text - the patch text.
 * @returns {{state: 'both'|'none'|'begin-only'|'end-only', begin: number, end: number}} the location.
 *   `begin` is the marker line index, `end` the index of the END marker line (-1 when absent).
 */
export function locateManagedBlock(text) {
  const { lines } = splitLines(normalizePatchText(text))
  const begin = lines.findIndex((line) => line.trim() === MANAGED_BEGIN)
  const end = lines.findIndex((line) => line.trim() === MANAGED_END)
  if (begin === -1 && end === -1) return { state: 'none', begin: -1, end: -1 }
  if (begin !== -1 && end === -1) return { state: 'begin-only', begin, end: -1 }
  if (begin === -1 && end !== -1) return { state: 'end-only', begin: -1, end }
  if (end < begin) return { state: 'end-only', begin: -1, end }
  return { state: 'both', begin, end }
}

/**
 * Count ROWS per `serverName` in a patch text.
 *
 * Two mcp-client rows using the same `serverName` make the second row's `apply` throw
 * (`serverName "x" is already in use by another mcp-client instance`), so the writer
 * refuses instead of producing a profile that half-works — the real hazard is a
 * hand-written legacy row duplicating a generated one.
 *
 * The count is per row, not per textual occurrence: a row begins at its `- id:` line and
 * its serverName is the first occurrence found inside it. Generated rows embed the
 * serverName in the `!!js` expression (fallback literal + one per return branch), so raw
 * occurrence counting would flag every generated row as a duplicate of itself.
 * @param {string} text - the patch text.
 * @returns {Map<string, number>} serverName -> number of rows using it.
 */
export function countServerNames(text) {
  const { lines } = splitLines(normalizePatchText(text))
  /** @type {Map<string, number>} */
  const counts = new Map()
  /** @type {{name: string|null}|null} */
  let row = null
  const flush = () => {
    if (row !== null && row.name !== null) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
  }
  for (const line of lines) {
    if (ROW_ID_LINE.test(line)) {
      flush()
      row = { name: null }
      continue
    }
    if (row === null || row.name !== null) continue
    const match = SERVER_NAME_FIRST.exec(line)
    if (match !== null) row.name = match[1]
  }
  flush()
  return counts
}

/**
 * Whether any serverName appears more than once.
 * @param {string} text - the patch text.
 * @returns {string[]} the duplicated serverNames.
 */
export function duplicateServerNames(text) {
  return Array.from(countServerNames(text))
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
}

/**
 * Remove the managed block (markers included).
 * @param {string} text - the patch text.
 * @returns {{ok: true, text: string, removed: number} | {ok: false, reason: string}} the result.
 */
export function removeManagedBlock(text) {
  const normalized = normalizePatchText(text)
  const { lines, trailingNewline } = splitLines(normalized)
  const at = locateManagedBlock(normalized)
  if (at.state === 'none') return { ok: true, text: normalized, removed: 0 }
  if (at.state !== 'both') {
    return { ok: false, reason: `managed block markers are incomplete (${at.state}) - refusing to guess; fix the markers by hand` }
  }
  const removed = at.end - at.begin + 1
  const kept = [...lines.slice(0, at.begin), ...lines.slice(at.end + 1)]
  return { ok: true, text: joinLines(kept, trailingNewline), removed }
}

/**
 * Replace (or create) the managed block with `body`.
 * @param {object} options - inputs.
 * @param {string} options.text - the current patch text.
 * @param {string} options.body - the block body (rows only, no markers), must end with '\n'.
 * @param {string} options.fullBlock - the complete block text (markers + body).
 * @returns {{ok: true, text: string, changed: boolean, action: 'replaced'|'inserted'|'unchanged'} | {ok: false, reason: string}} the result.
 */
export function applyManagedBlock({ text, body, fullBlock }) {
  const normalized = normalizePatchText(text)
  const { lines, trailingNewline } = splitLines(normalized)
  const at = locateManagedBlock(normalized)
  const blockLines = splitLines(fullBlock).lines
  if (at.state === 'none') {
    // Append the block in its own top-level insert list, independent of previous entries.
    //
    // BUT only when the existing body is actually a block sequence. Appending `- insert:`
    // after anything else produces a file no YAML parser accepts, and the loader MUST parse
    // this file to boot the profile. Measured 2026-09-20 against the shipped DSH profile
    // template (a comment header plus a bare `[]`): this function returned
    // `ok: true, action: 'inserted'` and wrote `[]` immediately followed by `- insert:`,
    // which js-yaml rejects with
    //   `end of the stream or a document separator is expected (5:1)`.
    // The unit tests never caught it because their inputs were all `# empty` or an existing
    // `- insert:` list -- never the `[]` template the product itself ships.
    const bodyLines = lines.filter((line) => {
      const trimmed = line.trim()
      return trimmed !== '' && !trimmed.startsWith('#')
    })
    const isSequence = bodyLines.length === 0 || bodyLines.some((line) => /^\s*-\s/.test(line))
    // A bare `[]` means "an empty list", which is exactly what this function is about to
    // make non-empty -- so it is safe to replace, and the two are semantically identical.
    const isEmptyFlowArray = bodyLines.length === 1 && bodyLines[0].replace(/\s+/g, '') === '[]'
    if (!isSequence && !isEmptyFlowArray) {
      return {
        ok: false,
        reason:
          `the patch body is not a block sequence (starts with ${JSON.stringify(bodyLines[0].slice(0, 40))}) - ` +
          'refusing to append, because the result would not parse; rewrite it as a `- insert:` list by hand first',
      }
    }
    const base = isEmptyFlowArray ? lines.filter((line) => line.replace(/\s+/g, '') !== '[]') : lines
    // The last entry may be an override even when an earlier insert exists.
    // Always append a separate top-level insert, never children of that last entry.
    const prefix = ['- insert:', '']
    const next = joinLines([...base, ...prefix, ...blockLines], true)
    return { ok: true, text: next, changed: next !== normalized, action: 'inserted' }
  }
  if (at.state !== 'both') {
    return { ok: false, reason: `managed block markers are incomplete (${at.state}) - refusing to guess; fix the markers by hand` }
  }
  const currentBody = lines.slice(at.begin + 1, at.end)
  const same = currentBody.length === blockLines.length - 2 && currentBody.every((line, i) => line === blockLines[i + 1])
  if (same) return { ok: true, text: normalized, changed: false, action: 'unchanged' }
  const next = joinLines([...lines.slice(0, at.begin), ...blockLines, ...lines.slice(at.end + 1)], trailingNewline)
  return { ok: true, text: next, changed: next !== normalized, action: 'replaced' }
}

/**
 * Remove legacy hand-written MCP rows that live OUTSIDE the managed block.
 *
 * This is the `-Migrate` behaviour: an older hand-edit used the same ids (`mcp-aura-*`,
 * `mcp-unreal-engine`) somewhere else in the file, and leaving it in place means either a
 * duplicate row id (profile does not boot) or a duplicate `serverName` (the second row's
 * apply throws). Only the matched row and its deeper-indented continuation lines are
 * removed; nothing else moves.
 * @param {string} text - the patch text.
 * @returns {{text: string, removed: string[]}} the migrated text and the removed row ids.
 */
export function stripLegacyRows(text) {
  const normalized = normalizePatchText(text)
  const { lines, trailingNewline } = splitLines(normalized)
  const at = locateManagedBlock(normalized)
  const insideFrom = at.state === 'both' ? at.begin : Number.POSITIVE_INFINITY
  const insideTo = at.state === 'both' ? at.end : Number.NEGATIVE_INFINITY
  const kept = []
  const removed = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const inBlock = index > insideFrom && index < insideTo
    const match = inBlock ? null : LEGACY_ROW_ID_LINE.exec(line)
    if (match === null) {
      kept.push(line)
      continue
    }
    removed.push(match[1])
    const indent = line.length - line.trimStart().length
    let cursor = index + 1
    while (cursor < lines.length) {
      const next = lines[cursor]
      if (next.trim().length === 0) {
        // A blank line only belongs to the removed row when a deeper line follows it.
        const after = lines[cursor + 1]
        if (after !== undefined && after.trim().length > 0 && after.length - after.trimStart().length > indent) {
          cursor += 1
          continue
        }
        break
      }
      if (next.length - next.trimStart().length > indent) {
        cursor += 1
        continue
      }
      break
    }
    index = cursor - 1
  }
  return { text: joinLines(kept, trailingNewline), removed }
}

/**
 * Row ids present in a patch text (raw count includes repeats).
 * @param {string} text - the patch text.
 * @returns {string[]} row ids.
 */
export function rowIdsIn(text) {
  const { lines } = splitLines(normalizePatchText(text))
  const ids = []
  for (const line of lines) {
    const match = ROW_ID_LINE.exec(line)
    if (match !== null) ids.push(match[1])
  }
  return ids
}
