#!/usr/bin/env node
/**
 * Sync-AuraMcp.mjs — the Channel A writer for the three Aura MCP loader rows.
 *
 * Successor of `Sync-AuraMcp.ps1`. It owns exactly one thing: the
 * `# >>> aura-mcp managed >>>` block inside a profile patch file. It never touches the
 * plugin's own row (`- id: dsh-aura`), never re-serializes the rest of the YAML, and
 * refuses to write when the file is not in a state it understands.
 *
 *   node scripts/Sync-AuraMcp.mjs                      # sync the web profile's block
 *   node scripts/Sync-AuraMcp.mjs --dry-run            # show the plan, write nothing
 *   node scripts/Sync-AuraMcp.mjs --check              # exit 1 when out of sync
 *   node scripts/Sync-AuraMcp.mjs --migrate            # also drop legacy hand-written rows
 *   node scripts/Sync-AuraMcp.mjs --remove             # delete the managed block
 *   node scripts/Sync-AuraMcp.mjs --emit-bundle-patch cordis.patch.yml
 *   node scripts/Sync-AuraMcp.mjs --emit-overlay out.yml
 *   node scripts/Sync-AuraMcp.mjs --channel            # report Channel A/B/none/conflict
 *
 * @module dsh-aura/scripts/Sync-AuraMcp
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { assertSingleOwner, collectRowIds, detectChannel } from '../lib/mcp/channels.js'
import { parsePatch } from '../lib/mcp/patch-yaml.js'
import {
  applyManagedBlock,
  duplicateServerNames,
  locateManagedBlock,
  normalizePatchText,
  removeManagedBlock,
  stripLegacyRows,
} from '../lib/mcp/managed-block.js'
import { renderBundlePatch, renderHeadlessOverlay, renderManagedBlock, renderManagedBlockBody } from '../lib/mcp/rows.js'
import { dshHome, readProfileManifest } from './lib/dsh-modules.mjs'

/** CLI help text. */
const USAGE = `Sync-AuraMcp.mjs -- the Channel A writer for the three Aura MCP loader rows.

  node scripts/Sync-AuraMcp.mjs                      sync the web profile's managed block
  node scripts/Sync-AuraMcp.mjs --dry-run            show the plan, write nothing
  node scripts/Sync-AuraMcp.mjs --check              exit 1 when out of sync (CI / verify)
  node scripts/Sync-AuraMcp.mjs --migrate            also drop legacy hand-written rows
  node scripts/Sync-AuraMcp.mjs --remove             delete the managed block
  node scripts/Sync-AuraMcp.mjs --channel            report Channel A/B/none/conflict
  node scripts/Sync-AuraMcp.mjs --emit-bundle-patch cordis.patch.yml
  node scripts/Sync-AuraMcp.mjs --emit-overlay out.yml

Options: --patch <file>  --profile <name=web>  --json
`

/** Default target: the `web` profile's user patch layer (the watched, hot one). */
export function defaultPatchPath(profileName = 'web') {
  return join(dshHome(), 'profiles', profileName, 'cordis.patch.yml')
}

/**
 * Build a `yyyyMMdd-HHmmss` local-time stamp for backup file names.
 * @param {Date} [now] - the timestamp.
 * @returns {string} the stamp.
 */
export function stamp(now = new Date()) {
  const p = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

/**
 * Write a file as LF without a BOM, backing the previous content up first.
 * @param {string} path - the target file.
 * @param {string} text - the content.
 * @param {object} [options] - write options.
 * @param {boolean} [options.backup] - create `<path>.bak-<stamp>` before writing.
 * @param {Date} [options.now] - timestamp for the backup name.
 * @returns {{backup: string|null}} the backup path when one was made.
 */
export function writePatchFile(path, text, options = {}) {
  parsePatch(text)
  assertSingleOwner([{ source: path, text }])
  let backup = null
  if (options.backup !== false && existsSync(path)) {
    backup = `${path}.bak-${stamp(options.now)}`
    copyFileSync(path, backup)
  }
  writeFileSync(path, normalizePatchText(text), { encoding: 'utf8' })
  return { backup }
}

/**
 * Resolve the channel of the current installation.
 * @param {object} options - inputs.
 * @param {string} options.patchPath - the profile patch path.
 * @param {string} [options.profile='web'] - the profile name.
 * @param {string} options.bundlePatch - this package's Channel B patch text.
 * @returns {{channel: string, inBundleList: boolean, conflicts: Array<{id: string, sources: string[]}>}} the decision.
 */
export function resolveInstallationChannel({ patchPath, profile = 'web', bundlePatch }) {
  const profilePatchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const manifest = readProfileManifest(profile)
  const bundles = manifest === null ? [] : (manifest.manifest?.dsh?.profile?.bundles ?? [])
  const inBundleList = Array.isArray(bundles) && bundles.includes('dsh-aura')
  const decision = detectChannel({ inBundleList, profilePatchText, bundlePatchText: bundlePatch })
  return { ...decision, inBundleList }
}

/**
 * Compute the sync plan for one patch file.
 * @param {object} options - plan inputs.
 * @param {string} options.text - the current patch text.
 * @param {boolean} [options.migrate] - strip legacy rows outside the block first.
 * @param {boolean} [options.remove] - remove the block instead of writing it.
 * @param {string} [options.bundlePatch] - Channel B patch text (for the mutual-exclusion check).
 * @param {boolean} [options.inBundleList] - is `dsh-aura` in `dsh.profile.bundles`?
 * @returns {{ok: boolean, reason?: string, action?: string, text?: string, removed?: string[]}} the plan.
 */
export function planSync({ text, migrate = false, remove = false, bundlePatch = '', inBundleList = false }) {
  try {
    const source = normalizePatchText(text)
    let working = source
    let removed = []
    if (migrate) {
      const stripped = stripLegacyRows(working)
      working = stripped.text
      removed = stripped.removed
    }

    if (remove) {
      const result = removeManagedBlock(working)
      if (!result.ok) return { ok: false, reason: result.reason }
      parsePatch(result.text)
      assertSingleOwner([{ source: 'profile-layer', text: result.text }])
      return { ok: true, action: result.removed > 0 ? 'removed' : 'already-absent', text: result.text, removed }
    }

    if (inBundleList) {
      return {
        ok: false,
        reason:
          'Channel B is active (dsh-aura is in dsh.profile.bundles) - refusing to also write the Channel A managed block; ' +
          'both providing the same row id makes the loader throw "TypeError: duplicate loader entry id" and the profile fails to boot',
      }
    }

    const result = applyManagedBlock({ text: working, body: renderManagedBlockBody(), fullBlock: renderManagedBlock() })
    if (!result.ok) return { ok: false, reason: result.reason }
    parsePatch(result.text)

    const duplicates = duplicateServerNames(result.text)
    if (duplicates.length > 0) {
      return {
        ok: false,
        reason:
          `serverName ${duplicates.join(', ')} would appear more than once - the second mcp-client row would throw ` +
          `'serverName "<name>" is already in use by another mcp-client instance'. Re-run with --migrate to drop the legacy hand-written row(s).`,
      }
    }
    assertSingleOwner([{ source: 'profile-layer', text: result.text }])
    return { ok: true, action: result.action, text: result.text, removed }
  } catch (error) {
    return { ok: false, reason: `invalid patch: ${error.message}` }
  }
}

/**
 * CLI entry point.
 * @returns {Promise<number>} the exit code.
 */
async function main() {
  const { values } = parseArgs({
    options: {
      patch: { type: 'string' },
      profile: { type: 'string', default: 'web' },
      'dry-run': { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      migrate: { type: 'boolean', default: false },
      remove: { type: 'boolean', default: false },
      channel: { type: 'boolean', default: false },
      'emit-bundle-patch': { type: 'string' },
      'emit-overlay': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  })

  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }

  const emitBundle = values['emit-bundle-patch']
  const emitOverlay = values['emit-overlay']
  const bundlePatch = renderBundlePatch()

  if (emitBundle !== undefined) {
    const target = resolve(emitBundle)
    const existing = existsSync(target) ? normalizePatchText(readFileSync(target, 'utf8')) : null
    if (existing === bundlePatch) {
      process.stdout.write(`Already in sync: ${target}\n`)
      return 0
    }
    writePatchFile(target, bundlePatch)
    process.stdout.write(`wrote ${target} (${bundlePatch.length} bytes)\n`)
    return 0
  }
  if (emitOverlay !== undefined) {
    const target = resolve(emitOverlay)
    writePatchFile(target, renderHeadlessOverlay())
    process.stdout.write(`wrote ${target}\n`)
    return 0
  }

  const patchPath = resolve(values.patch ?? defaultPatchPath(values.profile))
  const installation = resolveInstallationChannel({ patchPath, profile: values.profile, bundlePatch })

  if (values.channel) {
    const report = {
      patch: patchPath,
      inBundleList: installation.inBundleList,
      channel: installation.channel,
      auraRowInProfile: installation.auraRowInProfile,
      conflicts: installation.conflicts,
    }
    process.stdout.write(`${values.json ? JSON.stringify(report) : formatChannel(report)}\n`)
    return installation.channel === 'conflict' ? 1 : 0
  }

  if (!existsSync(patchPath)) {
    process.stderr.write(`dsh-aura: no patch file at ${patchPath}\n`)
    return 1
  }
  const current = normalizePatchText(readFileSync(patchPath, 'utf8'))
  const plan = planSync({
    text: current,
    migrate: values.migrate,
    remove: values.remove,
    bundlePatch,
    inBundleList: installation.inBundleList,
  })
  if (!plan.ok) {
    process.stderr.write(`dsh-aura: ${plan.reason}\n`)
    return 1
  }

  const changed = plan.text !== current
  const summary = {
    patch: patchPath,
    action: changed ? plan.action : 'unchanged',
    changed,
    removedLegacyRows: plan.removed ?? [],
    rowIdsBefore: collectRowIds(current),
    rowIdsAfter: collectRowIds(plan.text),
    managedBlock: locateManagedBlock(plan.text).state,
  }

  if (values.check) {
    process.stdout.write(`${values.json ? JSON.stringify(summary) : formatSummary(summary)}\n`)
    return changed ? 1 : 0
  }
  if (values['dry-run']) {
    process.stdout.write(`${values.json ? JSON.stringify(summary) : formatSummary(summary, 'dry-run: nothing written')}\n`)
    return 0
  }
  if (!changed) {
    process.stdout.write(`${values.json ? JSON.stringify(summary) : 'Already in sync'}\n`)
    return 0
  }
  const { backup } = writePatchFile(patchPath, plan.text)
  const report = { ...summary, backup }
  process.stdout.write(`${values.json ? JSON.stringify(report) : formatSummary(report)}\n`)
  return 0
}

/**
 * Human-readable form of the channel report.
 * @param {object} report - the report.
 * @returns {string} text.
 */
function formatChannel(report) {
  const lines = [
    `patch:            ${report.patch}`,
    `dsh.profile.bundles has dsh-aura: ${report.inBundleList}`,
    `profile patch has id: dsh-aura:    ${report.auraRowInProfile}`,
    `channel:          ${report.channel.toUpperCase()}`,
  ]
  if (report.conflicts.length > 0) {
    lines.push('conflicts:')
    for (const conflict of report.conflicts) lines.push(`  - ${conflict.id}: ${conflict.sources.join(' + ')}`)
  }
  return lines.join('\n')
}

/**
 * Human-readable form of the sync report.
 * @param {object} summary - the report.
 * @param {string} [note] - an extra note line.
 * @returns {string} text.
 */
function formatSummary(summary, note) {
  const lines = [
    `patch:   ${summary.patch}`,
    `action:  ${summary.action}`,
    `rows:    ${summary.rowIdsAfter.join(', ') || '(none)'}`,
    `block:   ${summary.managedBlock}`,
  ]
  if (summary.removedLegacyRows.length > 0) lines.push(`removed: ${summary.removedLegacyRows.join(', ')}`)
  if (summary.backup) lines.push(`backup:  ${summary.backup}`)
  if (note !== undefined) lines.push(`note:    ${note}`)
  return lines.join('\n')
}

const invokedDirectly =
  process.argv[1] !== undefined && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      process.stderr.write(`dsh-aura: ${String(error && error.stack ? error.stack : error)}\n`)
      process.exitCode = 1
    },
  )
}
