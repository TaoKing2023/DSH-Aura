/**
 * The Channel A / Channel B guard (design §8.4 gate 1) and the "only insert my own rows"
 * assertion for this package's own patch file.
 *
 * NEGATIVE CASES ARE THE POINT. A guard that cannot be triggered is decoration: every
 * refusal below is exercised with the exact input that must make it fire.
 *
 * @module dsh-aura/tests/channels.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import {
  assertOnlyOwnInserts,
  assertSingleOwner,
  classifyPatchEntries,
  collectRowIds,
  detectChannel,
  findRowConflicts,
} from '../lib/mcp/channels.js'
import { ownedRowIds, renderBundlePatch, renderManagedBlock } from '../lib/mcp/rows.js'
import { parsePatchFile } from './helpers/yaml-loader.mjs'

const BUNDLE_PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

/** A profile patch in the pre-migration state: managed block + the old workspace-sync row. */
const LEGACY_PROFILE_PATCH = [
  '# profile patch',
  '- insert:',
  renderManagedBlock().trimEnd(),
  '',
  '- insert:',
  "    - id: aura-workspace-sync",
  "      name: 'D:/work/Aura/AuraWorkspaceSync.plugin.mjs'",
  '',
].join('\n')

/** A profile patch after a clean migration: the plugin row only, no managed block. */
const MIGRATED_PROFILE_PATCH = [
  '# profile patch',
  '- insert:',
  '    - id: dsh-aura',
  "      name: 'C:/Users/example/.dsh/profiles/web/node_modules/dsh-aura/index.js'",
  '',
].join('\n')

describe('collectRowIds / findRowConflicts', () => {
  test('row ids are counted raw, repeats included', () => {
    const text = '- insert:\n    - id: a\n    - id: b\n- insert:\n    - id: a\n'
    assert.deepEqual(collectRowIds(text), ['a', 'b', 'a'])
  })

  test('a repeated id across two layers is reported with both providers', () => {
    const conflicts = findRowConflicts([
      { source: 'profile-layer', text: '- insert:\n    - id: dsh-aura\n' },
      { source: 'bundle-layer', text: '- insert:\n    - id: dsh-aura\n    - id: mcp-unreal-engine\n' },
    ])
    assert.deepEqual(conflicts, [{ id: 'dsh-aura', sources: ['profile-layer', 'bundle-layer'] }])
  })
})

describe('detectChannel', () => {
  const bundlePatch = renderBundlePatch()

  test('profile patch only -> A', () => {
    assert.equal(detectChannel({ inBundleList: false, profilePatchText: MIGRATED_PROFILE_PATCH, bundlePatchText: bundlePatch }).channel, 'A')
  })

  test('bundle list only -> B (the profile patch must not repeat any row)', () => {
    assert.equal(detectChannel({ inBundleList: true, profilePatchText: '# empty\n', bundlePatchText: bundlePatch }).channel, 'B')
  })

  test('neither -> none', () => {
    assert.equal(detectChannel({ inBundleList: false, profilePatchText: '# empty\n', bundlePatchText: bundlePatch }).channel, 'none')
  })

  test('BOTH -> conflict, for the plugin row and for each MCP row', () => {
    const preMigration = LEGACY_PROFILE_PATCH.replace('aura-workspace-sync', 'dsh-aura')
    const decision = detectChannel({ inBundleList: true, profilePatchText: preMigration, bundlePatchText: bundlePatch })
    assert.equal(decision.channel, 'conflict')
    assert.deepEqual(
      decision.conflicts.map((entry) => entry.id).sort(),
      [...ownedRowIds()].sort(),
      'every id provided twice must be named',
    )
  })

  test('a bundle list entry with no row in the profile patch is still a conflict if the ids overlap', () => {
    const partial = ['- insert:', '    - id: dsh-aura', "      name: 'dsh-aura'", ''].join('\n')
    const decision = detectChannel({ inBundleList: true, profilePatchText: partial, bundlePatchText: bundlePatch })
    assert.equal(decision.channel, 'conflict')
    assert.deepEqual(decision.conflicts, [{ id: 'dsh-aura', sources: ['profile-layer', 'bundle-layer'] }])
  })

  test('assertSingleOwner throws on the conflict and returns clean for the migrated state', () => {
    const preMigration = LEGACY_PROFILE_PATCH.replace('aura-workspace-sync', 'dsh-aura')
    assert.throws(
      () =>
        assertSingleOwner([
          { source: 'profile-layer', text: preMigration },
          { source: 'bundle-layer', text: bundlePatch },
        ]),
      /duplicate loader row id/,
    )
    assert.deepEqual(assertSingleOwner([{ source: 'profile-layer', text: MIGRATED_PROFILE_PATCH }]), [])
  })
})

describe('cordis.patch.yml only inserts its own rows', () => {
  test('the shipped patch parses as inserts of owned ids only', async () => {
    const { patches } = await parsePatchFile(BUNDLE_PATCH)
    const { inserts, targets, foreignInsertIds } = classifyPatchEntries(patches)
    assert.equal(targets.length, 0, 'the bundle patch must not target any existing row id')
    assert.deepEqual(foreignInsertIds, [])
    assert.deepEqual(
      inserts.flatMap((entry) => entry.ids).sort(),
      [...ownedRowIds()].sort(),
    )
    assertOnlyOwnInserts(patches, 'cordis.patch.yml')
  })

  test('a patch that disables a foreign row is rejected', async () => {
    const hostile = ['- id: session-title-format', '  disabled: true', ''].join('\n')
    const { parsePatchText } = await import('./helpers/yaml-loader.mjs')
    const { patches } = await parsePatchText(hostile)
    assert.equal(classifyPatchEntries(patches).targets[0].id, 'session-title-format')
    assert.throws(() => assertOnlyOwnInserts(patches, 'hostile.yml'), /targets id "session-title-format"/)
  })

  test('a patch that inserts a foreign row id is rejected', () => {
    const patches = [{ insert: [{ id: 'someone-elses-row', name: 'other-plugin' }] }]
    assert.throws(() => assertOnlyOwnInserts(patches, 'hostile.yml'), /inserting foreign row id/)
  })

  test('an override of a foreign row config is rejected', () => {
    const patches = [{ id: 'mcp-playwright', config: { serverName: 'hijacked' } }]
    assert.throws(() => assertOnlyOwnInserts(patches, 'hostile.yml'), /targets id "mcp-playwright"/)
  })

  test('the shipped bundle patch never uses a bare (non-insert) entry', () => {
    const text = readFileSync(BUNDLE_PATCH, 'utf8')
    const bareRows = text.split('\n').filter((line) => /^- id: /.test(line))
    assert.deepEqual(bareRows, [], 'a bare new id fails with `patch: entry "<id>" not found`')
  })
})
