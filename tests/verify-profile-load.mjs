#!/usr/bin/env node
/**
 * Profile-load rehearsal driver for dsh-aura.
 *
 * Runs `dsh --profile <name> --dump-config` and reports, as JSON, the facts the
 * installation story actually rests on:
 *
 *   - the exit code of the dump (a CRASH prints nothing, so the exit code is the
 *     only signal that survives an unreadable tree),
 *   - how many times each of the four ids this package cares about appears,
 *   - whether ANY id appears more than once (the duplicate-row question),
 *   - the resolved `name:` of the dsh-aura loader row, if it is present.
 *
 * The dump is READ-ONLY: it composes the tree and exits. Nothing here writes to
 * the profile, and nothing here starts a server, so it is safe to point at a
 * profile whose `dsh web` is live.
 *
 * Usage:
 *   node tests/verify-profile-load.mjs --profile web-t3verify
 *   node tests/verify-profile-load.mjs --profile web-t3verify --expect mcp-once,plugin-present,exit-zero
 *
 * Expectations (`--expect a,b,c`):
 *   exit-zero                 the dump exits 0
 *   mcp-once                  each of the three Aura MCP ids appears exactly once
 *   no-duplicate-ids          no id anywhere in the dump appears twice
 *   plugin-present            a row with id `dsh-aura` exists
 *   plugin-absent             no row with id `dsh-aura` exists
 *   workspace-sync-absent     no row with id `aura-workspace-sync` exists
 *   workspace-sync-present    a row with id `aura-workspace-sync` exists
 *
 * Exits 0 when every expectation holds (or none was given), 1 otherwise.
 *
 * @module dsh-aura/tests/verify-profile-load
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The three Aura MCP loader ids this package owns, in the order the patch lists them. */
const MCP_IDS = ['mcp-aura-unreal-inspector', 'mcp-aura-unreal-editor', 'mcp-unreal-engine']

/**
 * Parse `--flag value` and `--flag=value` pairs.
 * @param {string[]} argv - process arguments after the script name.
 * @returns {Record<string, string|boolean>} the flags.
 */
function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const eq = token.indexOf('=')
    if (eq !== -1) flags[token.slice(2, eq)] = token.slice(eq + 1)
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      flags[token.slice(2)] = argv[i + 1]
      i += 1
    } else flags[token.slice(2)] = true
  }
  return flags
}

/**
 * Locate `@deepseek-ai/dsh/lib/bin.js`, the CLI entry both `dsh.ps1` and `dsh.cmd` wrap.
 *
 * Resolved through node instead of through the shell on purpose: launching `dsh`
 * through `cmd.exe`/`powershell` re-joins the argument list and silently mis-quotes
 * any path containing a space.
 * @returns {string} absolute path to the CLI entry.
 */
function resolveDshBin() {
  const explicit = process.env.DSH_BIN
  if (explicit !== undefined && explicit !== '') return explicit
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).trim()
    const candidate = join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(candidate)) return candidate
  } catch {
    /* fall through to the platform default below */
  }
  return join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/**
 * Run the dump for one profile.
 * @param {string} bin - path to the dsh CLI entry.
 * @param {string} profile - profile name under `$DSH_HOME/profiles`.
 * @returns {{status: number|null, stdout: string, stderr: string}} the raw result.
 */
function dumpConfig(bin, profile) {
  const result = spawnSync(process.execPath, [bin, '--profile', profile, '--dump-config'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Count `- id: <id>` rows (the dump's row form) and remember each row's resolved `name:`.
 * @param {string} text - the dump output.
 * @returns {{counts: Map<string, number>, order: string[], names: Map<string, string>, duplicates: string[]}} the analysis.
 */
function analyse(text) {
  const lines = text.split('\n')
  const counts = new Map()
  const order = []
  const names = new Map()
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^- id: (.+)$/.exec(lines[i])
    if (match === null) continue
    const id = match[1].trim()
    order.push(id)
    counts.set(id, (counts.get(id) ?? 0) + 1)
    const nameLine = /^\s+name: (.+)$/.exec(lines[i + 1] ?? '')
    if (nameLine !== null) names.set(id, nameLine[1].trim().replace(/^['"]|['"]$/g, ''))
  }
  const duplicates = [...counts.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`)
  return { counts, order, names, duplicates }
}

/**
 * The profile's patch file, for the record: the rehearsal's input is evidence too.
 *
 * Reports what the patch layer itself carries, because the dump cannot tell the
 * two channels apart once the tree is composed: a row coming from the profile's
 * own `insert:` and a row coming from an applied bundle patch look identical.
 * @param {string} profile - profile name.
 * @returns {{path: string, hasAuraRow: boolean, hasManagedBlock: boolean, hasLegacySyncRow: boolean}} patch provenance.
 */
function patchProvenance(profile) {
  const path = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'), 'profiles', profile, 'cordis.patch.yml')
  if (!existsSync(path)) return { path, hasAuraRow: false, hasManagedBlock: false, hasLegacySyncRow: false }
  const text = readFileSync(path, 'utf8')
  return {
    path,
    hasAuraRow: /^[ \t]*- id: dsh-aura[ \t]*$/m.test(text),
    hasManagedBlock: text.includes('# >>> aura-mcp managed'),
    hasLegacySyncRow: /^[ \t]*- id: aura-workspace-sync[ \t]*$/m.test(text),
  }
}

const flags = parseArgs(process.argv.slice(2))
const profile = typeof flags.profile === 'string' ? flags.profile : 'web'
const expectations = (typeof flags.expect === 'string' ? flags.expect : '').split(',').map((s) => s.trim()).filter((s) => s !== '')
const bin = resolveDshBin()

const dump = dumpConfig(bin, profile)
const analysis = analyse(dump.stdout)

const watched = Object.fromEntries(
  [...new Set([...MCP_IDS, 'dsh-aura', 'aura-workspace-sync'])].map((id) => [id, analysis.counts.get(id) ?? 0]),
)

/** @type {Array<{name: string, ok: boolean, detail: string}>} */
const checks = []
for (const name of expectations) {
  if (name === 'exit-zero') checks.push({ name, ok: dump.status === 0, detail: `exit=${dump.status}` })
  else if (name === 'mcp-once') {
    const bad = MCP_IDS.filter((id) => (analysis.counts.get(id) ?? 0) !== 1).map((id) => `${id}=${analysis.counts.get(id) ?? 0}`)
    checks.push({ name, ok: bad.length === 0, detail: bad.length === 0 ? MCP_IDS.map((id) => `${id}=1`).join(' ') : bad.join(' ') })
  } else if (name === 'no-duplicate-ids') checks.push({ name, ok: analysis.duplicates.length === 0, detail: analysis.duplicates.join(', ') || 'no id appears twice' })
  else if (name === 'plugin-present') checks.push({ name, ok: (analysis.counts.get('dsh-aura') ?? 0) >= 1, detail: `dsh-aura rows=${analysis.counts.get('dsh-aura') ?? 0}` })
  else if (name === 'plugin-absent') checks.push({ name, ok: (analysis.counts.get('dsh-aura') ?? 0) === 0, detail: `dsh-aura rows=${analysis.counts.get('dsh-aura') ?? 0}` })
  else if (name === 'workspace-sync-present') checks.push({ name, ok: (analysis.counts.get('aura-workspace-sync') ?? 0) >= 1, detail: `aura-workspace-sync rows=${analysis.counts.get('aura-workspace-sync') ?? 0}` })
  else if (name === 'workspace-sync-absent') checks.push({ name, ok: (analysis.counts.get('aura-workspace-sync') ?? 0) === 0, detail: `aura-workspace-sync rows=${analysis.counts.get('aura-workspace-sync') ?? 0}` })
  else checks.push({ name, ok: false, detail: 'unknown expectation' })
}

const report = {
  dshBin: bin,
  dshHome: process.env.DSH_HOME ?? null,
  profile,
  exitCode: dump.status,
  stdoutLines: dump.stdout === '' ? 0 : dump.stdout.split('\n').length - 1,
  rows: analysis.order.length,
  watched,
  duplicateIds: analysis.duplicates,
  pluginRowName: analysis.names.get('dsh-aura') ?? null,
  mcpRowNames: Object.fromEntries(MCP_IDS.map((id) => [id, analysis.names.get(id) ?? null])),
  stderrFirstLines: dump.stderr.split('\n').filter((l) => l.trim() !== '').slice(0, 3),
  patch: patchProvenance(profile),
  warnings: [],
  checks,
  verdict: checks.every((c) => c.ok) ? 'pass' : 'fail',
}

// A profile that has been re-initialized from the shipped template composes cleanly
// (exit 0, no duplicates) and would otherwise read as a pass. Say so loudly: on
// 2026-09-19 an emptied ~/.dsh was re-initialized as a blank `web` template, and a
// dump of it looks perfectly healthy while containing none of the real wiring.
const patch = report.patch
const auraRows = MCP_IDS.reduce((sum, id) => sum + (analysis.counts.get(id) ?? 0), (analysis.counts.get('dsh-aura') ?? 0) + (analysis.counts.get('aura-workspace-sync') ?? 0))
if (patch.hasManagedBlock === false && patch.hasAuraRow === false && auraRows === 0) {
  report.warnings.push(
    `no Aura wiring found in profile ${JSON.stringify(profile)} at all ` +
      `(no aura-mcp managed block, no dsh-aura row, none of the three MCP ids, no aura-workspace-sync); ` +
      `${report.rows} rows composed. A pass here says nothing about the real profile -- compare the five ` +
      'profile file hashes against the recorded baseline first',
  )
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.exit(report.verdict === 'pass' ? 0 : 1)
