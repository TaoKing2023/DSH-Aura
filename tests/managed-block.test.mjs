/**
 * Managed-block surgery: locate, replace, remove, migrate — and every refusal.
 *
 * The block lives inside a hand-maintained profile patch full of unrelated rows and
 * explanatory comments, so the writer is line-based and must never re-serialize the file.
 * The refusals are the interesting part: guessing is how a profile ends up unable to boot.
 *
 * @module dsh-aura/tests/managed-block.test
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  applyManagedBlock,
  countServerNames,
  duplicateServerNames,
  locateManagedBlock,
  normalizePatchText,
  removeManagedBlock,
  stripLegacyRows,
} from '../lib/mcp/managed-block.js'
import { MANAGED_BEGIN, MANAGED_END, renderManagedBlock, renderManagedBlockBody } from '../lib/mcp/rows.js'

/** A realistic profile patch: unrelated rows, a legacy duplicate, and a managed block. */
const PROFILE_PATCH = [
  '# Your patch layer for this dsh profile.',
  '',
  '- insert:',
  renderManagedBlock().trimEnd(),
  '    # an unrelated comment that must survive',
  '    - id: mcp-playwright',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: playwright',
  '        transport: stdio',
  '',
  '- insert:',
  "    - id: aura-workspace-sync",
  "      name: 'D:/work/Aura/AuraWorkspaceSync.plugin.mjs'",
  '',
  '- id: session-title-format',
  '  disabled: true',
  '',
].join('\n')

/** A patch with one legacy hand-written MCP row OUTSIDE the managed block. */
const LEGACY_DUPLICATE = [
  '- insert:',
  '    - id: mcp-aura-unreal-inspector',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: unreal_inspector',
  '        transport: stdio',
  '        command: legacy-python.exe',
  '        # a deeper comment that belongs to the row',
  '        args: []',
  '',
  '- insert:',
  '    - id: keep-me',
  "      name: 'some-other-plugin'",
  '',
].join('\n')

describe('locateManagedBlock', () => {
  test('finds a complete block', () => {
    const at = locateManagedBlock(PROFILE_PATCH)
    assert.equal(at.state, 'both')
    assert.ok(at.begin > 0 && at.end > at.begin)
  })

  test('reports none, and each half-marker state, instead of guessing', () => {
    assert.equal(locateManagedBlock('- insert:\n').state, 'none')
    assert.equal(locateManagedBlock(`${MANAGED_BEGIN}\n    - id: x\n`).state, 'begin-only')
    assert.equal(locateManagedBlock(`    - id: x\n${MANAGED_END}\n`).state, 'end-only')
    assert.equal(locateManagedBlock(`${MANAGED_END}\n${MANAGED_BEGIN}\n`).state, 'end-only')
  })

  test('a CRLF file and a BOM are tolerated', () => {
    const crlf = `\uFEFF${PROFILE_PATCH.replace(/\n/g, '\r\n')}`
    assert.equal(locateManagedBlock(crlf).state, 'both')
    assert.equal(normalizePatchText(crlf).includes('\r'), false)
  })
})

describe('applyManagedBlock', () => {
  test('is a no-op when the content is already in sync, and the content is byte-identical', () => {
    const first = applyManagedBlock({ text: PROFILE_PATCH, body: renderManagedBlockBody(), fullBlock: renderManagedBlock() })
    assert.equal(first.ok, true)
    assert.equal(first.action, 'unchanged')
    assert.equal(first.changed, false)
    assert.equal(first.text, PROFILE_PATCH, 'an in-sync file must not be rewritten at all')
  })

  test('replaces only the block, leaving every other byte alone', () => {
    const stale = PROFILE_PATCH.replace('toolCallTimeoutMs":300000,"failOnStartupError', 'toolCallTimeoutMs":111111,"failOnStartupError')
    assert.notEqual(stale, PROFILE_PATCH)
    const result = applyManagedBlock({ text: stale, body: renderManagedBlockBody(), fullBlock: renderManagedBlock() })
    assert.equal(result.ok, true)
    assert.equal(result.action, 'replaced')
    assert.equal(result.text, PROFILE_PATCH, 'the rest of the file must come back unchanged')
  })

  test('inserts a block (with its own - insert: list) when none exists', () => {
    const bare = '# empty profile patch\n'
    const result = applyManagedBlock({ text: bare, body: renderManagedBlockBody(), fullBlock: renderManagedBlock() })
    assert.equal(result.ok, true)
    assert.equal(result.action, 'inserted')
    assert.ok(result.text.startsWith(bare))
    assert.ok(result.text.includes('- insert:'))
    assert.equal(locateManagedBlock(result.text).state, 'both')
  })

  test('refuses a half-marked file instead of guessing', () => {
    const broken = `${MANAGED_BEGIN}\n    - id: x\n`
    const result = applyManagedBlock({ text: broken, body: renderManagedBlockBody(), fullBlock: renderManagedBlock() })
    assert.equal(result.ok, false)
    assert.match(result.reason, /markers are incomplete \(begin-only\)/)
  })

  test('applying twice in a row reports unchanged the second time (idempotent)', () => {
    const once = applyManagedBlock({ text: '# empty\n', body: renderManagedBlockBody(), fullBlock: renderManagedBlock() })
    const twice = applyManagedBlock({ text: once.text, body: renderManagedBlockBody(), fullBlock: renderManagedBlock() })
    assert.equal(twice.action, 'unchanged')
    assert.equal(twice.changed, false)
    assert.equal(twice.text, once.text)
  })
})

describe('removeManagedBlock', () => {
  test('removes the block and nothing else', () => {
    const blockLines = renderManagedBlock().trimEnd().split('\n').length
    const result = removeManagedBlock(PROFILE_PATCH)
    assert.equal(result.ok, true)
    assert.equal(result.removed, blockLines)
    assert.equal(result.text.includes(MANAGED_BEGIN), false)
    assert.equal(result.text.includes('mcp-playwright'), true, 'unrelated rows must survive')
    assert.equal(result.text.includes('aura-workspace-sync'), true)
  })

  test('is a no-op on a file without a block', () => {
    const result = removeManagedBlock('- insert:\n    - id: keep-me\n')
    assert.equal(result.ok, true)
    assert.equal(result.removed, 0)
  })

  test('refuses a half-marked file', () => {
    assert.equal(removeManagedBlock(`${MANAGED_END}\n`).ok, false)
  })
})

describe('duplicate serverName refusal', () => {
  test('a legacy duplicate row is detected', () => {
    const combined = `${LEGACY_DUPLICATE}${renderManagedBlock()}`
    const duplicates = duplicateServerNames(combined)
    assert.deepEqual(duplicates, ['unreal_inspector'])
    assert.equal(countServerNames(combined).get('unreal_inspector'), 2)
  })

  test('the shipped block alone has exactly one of each', () => {
    const counts = countServerNames(renderManagedBlock())
    assert.deepEqual([...counts.keys()].sort(), ['unreal_editor', 'unreal_inspector', 'unreal_mcp'])
    for (const count of counts.values()) assert.equal(count, 1)
  })
})

describe('stripLegacyRows (--migrate)', () => {
  test('removes a legacy row with its continuation lines and touches nothing else', () => {
    const { text, removed } = stripLegacyRows(LEGACY_DUPLICATE)
    assert.deepEqual(removed, ['mcp-aura-unreal-inspector'])
    assert.equal(text.includes('legacy-python.exe'), false)
    assert.equal(text.includes('a deeper comment that belongs to the row'), false)
    assert.equal(text.includes('keep-me'), true, 'the unrelated row must survive')
    assert.equal(text.includes('some-other-plugin'), true)
  })

  test('never touches rows inside the managed block', () => {
    const { text, removed } = stripLegacyRows(PROFILE_PATCH)
    assert.deepEqual(removed, [])
    assert.equal(text, PROFILE_PATCH)
  })

  test('migrate then apply leaves exactly one of each serverName', () => {
    const combined = `${LEGACY_DUPLICATE}${renderManagedBlock()}`
    const migrated = stripLegacyRows(combined)
    assert.deepEqual(duplicateServerNames(migrated.text), [])
    assert.deepEqual(migrated.removed, ['mcp-aura-unreal-inspector'])
  })
})

describe('the body this product actually ships (a bare `[]`)', () => {
  // REGRESSION, found 2026-09-20 by an independent audit and reproduced by hand.
  //
  // Every input in this file used to be `# empty` or a file that already carried a
  // `- insert:` list. The SHIPPED DSH profile patch is neither: it is a comment header
  // followed by a bare `[]`. Appending `- insert:` after that produced
  //   `PARSE FAILED: end of the stream or a document separator is expected (5:1)`
  // while the function still returned `ok: true, action: 'inserted'` -- a silent way to
  // write a profile that cannot boot.
  const SHIPPED_TEMPLATE = [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries (id-targeted config',
    '# overrides, disables, and insert lists; `!!js` expressions allowed).',
    '[]',
    '',
  ].join('\n')

  test('replaces `[]` instead of appending after it', () => {
    const result = applyManagedBlock({
      text: SHIPPED_TEMPLATE,
      body: renderManagedBlockBody(),
      fullBlock: renderManagedBlock(),
    })
    assert.equal(result.ok, true)
    assert.equal(result.action, 'inserted')
    const body = result.text
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    assert.equal(body[0], '- insert:', 'the `[]` must be REPLACED, not left in front of the list')
    assert.equal(
      body.some((line) => line.trim() === '[]'),
      false,
      'a leftover `[]` before the list is exactly what breaks the parse',
    )
    assert.equal((result.text.match(/^\s*-\s+insert:\s*$/gm) ?? []).length, 1)
    assert.ok(result.text.includes(MANAGED_BEGIN) && result.text.includes(MANAGED_END))
  })

  test('refuses to append to a body that is not a block sequence', () => {
    const result = applyManagedBlock({
      text: '# header\nfoo: bar\n',
      body: renderManagedBlockBody(),
      fullBlock: renderManagedBlock(),
    })
    assert.equal(result.ok, false, 'appending after a mapping would produce unparseable YAML')
    assert.match(result.reason, /not a block sequence/)
  })
})
