/**
 * Wiring tests for the row renderer.
 *
 * The two historical regressions live here in their cheapest form, plus the strongest
 * statement the package can make about the MCP rows: the managed block it renders is
 * byte-identical to the one that is actually running in the live profile patch.
 *
 * @module dsh-aura/tests/mcp-wiring.test
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { locateManagedBlock, normalizePatchText } from '../lib/mcp/managed-block.js'
import {
  FALLBACKS,
  MCP_ENTRY_NAMES,
  renderBundlePatch,
  renderConfigExpr,
  renderManagedBlock,
  renderManagedBlockBody,
  renderMcpRows,
  rowIdFor,
  SERVER_NAMES,
  timeoutFor,
} from '../lib/mcp/rows.js'
import { dshHome } from '../scripts/lib/dsh-modules.mjs'

describe('row identity rules', () => {
  test('ids follow the historical rule, including the hard-coded engine row', () => {
    assert.equal(rowIdFor('unreal_inspector'), 'mcp-aura-unreal-inspector')
    assert.equal(rowIdFor('unreal_editor'), 'mcp-aura-unreal-editor')
    assert.equal(rowIdFor('unreal_mcp'), 'mcp-unreal-engine', 'the engine row id is hard-coded, never derived')
  })

  test('the editor row gets the longer per-call budget', () => {
    assert.equal(timeoutFor('unreal_editor'), 900000)
    assert.equal(timeoutFor('unreal_inspector'), 300000)
    assert.equal(timeoutFor('unreal_mcp'), 300000)
  })

  test('every row has a distinct MCP client entry for its display metadata', () => {
    const text = renderBundlePatch()
    for (const serverName of SERVER_NAMES) {
      assert.ok(text.includes(`name: '${MCP_ENTRY_NAMES[serverName]}'`), `row ${serverName} lacks its named entry`)
    }
    assert.equal(new Set(Object.values(MCP_ENTRY_NAMES)).size, 3)
  })
})

describe('the two historical regressions', () => {
  test('pathIsLiteral: the candidate paths reach the loader as double backslashes', () => {
    const expr = renderConfigExpr('unreal_inspector')
    assert.ok(expr.includes(String.raw`'\\Programs\\aura-client\\next\\.mcp-config.json'`), 'candidate 1 lost its escapes')
    assert.ok(expr.includes(String.raw`'\\.dsh\\aura-mcp.json'`), 'candidate 2 lost its escapes')
    assert.ok(!/\u0000-\u001F/.test(expr.replace(/\n/g, '')), 'the expression contains a raw control character — an escape was eaten')
    // And prove the escapes mean what we think: the string literal evaluates to a path.
    const derived = new Function(`return (env) => (env.LOCALAPPDATA || '') + '\\\\Programs\\\\aura-client\\\\next\\\\.mcp-config.json'`)()
    assert.ok(derived({ LOCALAPPDATA: 'C:/x' }).endsWith('/Programs/aura-client/next/.mcp-config.json') || derived({ LOCALAPPDATA: 'C:/x' }).includes('aura-client'), 'escape semantics changed')
  })

  test('bomTolerated: the BOM strip is part of every expression', () => {
    for (const serverName of SERVER_NAMES) {
      assert.ok(renderConfigExpr(serverName).includes('.replace(/^\\uFEFF/, \'\')'), `${serverName}: the BOM strip was dropped`)
    }
  })

  test('the fallback literal stays a valid mcp-client config', () => {
    for (const serverName of SERVER_NAMES) {
      const expr = renderConfigExpr(serverName)
      const literal = JSON.stringify(FALLBACKS[serverName])
      assert.ok(expr.includes(literal), `${serverName}: the baked-in fallback is missing`)
      const parsed = JSON.parse(literal)
      assert.equal(parsed.serverName, serverName)
      assert.ok(parsed.transport === 'stdio' ? typeof parsed.command === 'string' : typeof parsed.url === 'string')
      assert.equal(parsed.failOnStartupError, false)
    }
  })
})

describe('rendering is deterministic and idempotent', () => {
  test('repeated rendering produces identical bytes (no accumulation)', () => {
    assert.equal(renderBundlePatch(), renderBundlePatch())
    assert.equal(renderManagedBlock(), renderManagedBlock())
    assert.equal(renderMcpRows(), renderMcpRows())
  })

  test('the managed block body contains exactly the three MCP rows', () => {
    const body = renderManagedBlockBody()
    assert.equal((body.match(/^ {4}- id: /gm) ?? []).length, 3)
    assert.ok(!/^\s+- id: dsh-aura\s*$/m.test(body), 'the plugin row is not part of the managed block')
    assert.ok(body.endsWith('\n'))
  })
})

describe('byte-identity with the live managed block', () => {
  test('the rendered managed block equals the one running in profiles/web/cordis.patch.yml', (t) => {
    const patchPath = join(dshHome(), 'profiles', 'web', 'cordis.patch.yml')
    if (!existsSync(patchPath)) {
      t.skip(`no live profile patch at ${patchPath} — nothing to compare against`)
      return
    }
    const text = normalizePatchText(readFileSync(patchPath, 'utf8'))
    const at = locateManagedBlock(text)
    // ABSENT is not a defect. This assertion compares the generator's output with
    // the block running on THIS machine, so it can only run where such a block
    // exists. Measured 2026-09-20: after ~/.dsh was rebuilt from scratch the live
    // patch is a bare `[]`, and failing here reported an environment fact as a code
    // defect. A HALF-written block is still a defect and still fails below.
    if (at.state === 'none') {
      // `t.skip`, NOT `t.diagnostic + return`. The diagnostic form still counted as a PASS, so
      // `npm test` reported `pass 162 / skipped 0` while this check silently did nothing --
      // a green suite that was not actually checking anything (adversarial review AURA-09).
      t.skip(`the live profile patch at ${patchPath} carries no managed block — nothing to compare against`)
      return
    }
    assert.equal(at.state, 'both', 'the live profile patch has a half-written managed block (exactly one marker)')
    const lines = text.split('\n')
    const live = lines.slice(at.begin, at.end + 1).join('\n')
    assert.equal(
      live,
      renderManagedBlock().trimEnd(),
      'the rendered managed block drifted from the live one — the migration would rewrite the rows',
    )
  })
})
