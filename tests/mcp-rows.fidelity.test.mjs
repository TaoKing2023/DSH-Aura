/**
 * Fidelity test for the three Aura MCP loader rows.
 *
 * This is the check that proves the wiring is still accepted by the real stack — it uses
 * the loader's own YAML dialect, the loader's own evaluator, and the mcp-client's own
 * `Config` schema. Nothing about the expected result is hand-written.
 *
 * The three scenarios the contract names:
 *   A. nothing configured        -> the baked-in fallback literal is used
 *   B. only `aura-mcp.json`      -> that file is used (candidate 2)
 *   C. Aura's own app config too -> that file wins (candidate 1)
 *
 * Plus the two historical regressions, which must stay fixed:
 *   - `pathIsLiteral`  — the candidate paths contain `\\`, never a raw control character
 *   - `bomTolerated`   — a Notepad-saved (BOM-prefixed) JSON file still parses
 *
 * @module dsh-aura/tests/mcp-rows.fidelity.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'

import { FALLBACKS, ownedRowIds, renderBundlePatch, SERVER_NAMES } from '../lib/mcp/rows.js'
import { collectRowIds } from '../lib/mcp/channels.js'
import { createEnvSandbox, mcpServersPayload } from './helpers/env-sandbox.mjs'
import { evaluateRowConfigs, parsePatchFile, validateWithMcpClient } from './helpers/yaml-loader.mjs'

const BUNDLE_PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const sandbox = createEnvSandbox()
after(() => sandbox.restore())

/**
 * Parse the shipped patch file and evaluate every `config` expression under the CURRENT
 * environment.
 * @returns {Promise<Array<{id: string, kind: string, value: any, error?: string}>>} per-row results.
 */
async function resolveShippedRows() {
  const { patches } = await parsePatchFile(BUNDLE_PATCH)
  const evaluated = evaluateRowConfigs(patches)
  for (const row of evaluated) {
    assert.equal(row.error, undefined, `row ${row.id}: the !!js expression threw: ${row.error}`)
  }
  return evaluated
}

/**
 * Validate every resolved row with the mcp-client's own schema.
 * @param {Array<{id: string, value: any}>} rows - resolved rows.
 * @returns {Promise<Map<string, any>>} id -> validated config.
 */
async function validateAll(rows) {
  const validated = new Map()
  for (const row of rows) {
    const outcome = await validateWithMcpClient(row.value)
    assert.equal(outcome.ok, true, `row ${row.id}: mcp-client schema rejected the resolved config: ${outcome.message ?? ''}`)
    validated.set(row.id, outcome.value)
  }
  return validated
}

describe('cordis.patch.yml: shape', () => {
  test('is the renderer output, byte for byte (no hand-edited drift)', () => {
    const onDisk = readFileSync(BUNDLE_PATCH, 'utf8').replace(/\r\n/g, '\n')
    assert.equal(onDisk, renderBundlePatch(), 'cordis.patch.yml drifted from lib/mcp/rows.js — regenerate with: npm run mcp:emit-bundle-patch')
  })

  test('provides exactly the four ids this package owns, each once', () => {
    const text = readFileSync(BUNDLE_PATCH, 'utf8')
    const ids = collectRowIds(text)
    assert.deepEqual([...ids].sort(), [...ownedRowIds()].sort())
    assert.equal(new Set(ids).size, ids.length, 'a row id appears more than once')
  })

  test('generic fallback literals are the ones the expressions bake in', async () => {
    const { patches } = await parsePatchFile(BUNDLE_PATCH)
    const exprs = (Array.isArray(patches) ? patches : [])
      .flatMap((patch) => (Array.isArray(patch.insert) ? patch.insert : []))
      .map((row) => (row && row.config instanceof Object && '__jsExpr' in row.config ? row.config.__jsExpr : ''))
      .join('\n')
    for (const serverName of SERVER_NAMES) {
      const literal = JSON.stringify(FALLBACKS[serverName])
      assert.ok(exprs.includes(literal), `fallback literal for ${serverName} is missing from the patch`)
    }
  })
})

describe('scenario A: no config file at all', () => {
  test('every row falls back to its baked-in literal and validates', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    const rows = await resolveShippedRows()
    const validated = await validateAll(rows)
    // The `dsh-aura` row is a plain plugin row with no `config`, so exactly the three MCP
    // rows carry one.
    assert.equal(validated.size, 3)
    for (const serverName of SERVER_NAMES) {
      const id = serverName === 'unreal_mcp' ? 'mcp-unreal-engine' : `mcp-aura-${serverName.replace(/_/g, '-')}`
      const config = validated.get(id)
      assert.deepEqual(
        {
          serverName: config.serverName,
          transport: config.transport,
          command: config.command,
          args: config.args,
          url: config.url,
        },
        {
          serverName: FALLBACKS[serverName].serverName,
          transport: FALLBACKS[serverName].transport,
          command: FALLBACKS[serverName].command,
          args: FALLBACKS[serverName].args,
          url: FALLBACKS[serverName].url,
        },
        `${serverName}: the fallback literal was not used`,
      )
      assert.equal(config.toolCallTimeoutMs, FALLBACKS[serverName].toolCallTimeoutMs)
      assert.equal(config.failOnStartupError, false)
    }
  })
})

describe('scenario B: only %USERPROFILE%\\.dsh\\aura-mcp.json exists', () => {
  before(() => { process.env.DSH_AURA_ALLOW_ANY_COMMAND = '1' })
  after(() => { delete process.env.DSH_AURA_ALLOW_ANY_COMMAND })
  test('candidate 2 is used for all three servers', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    sandbox.writeConfig(
      'aura',
      mcpServersPayload({
        unreal_inspector: { command: 'C:/sandbox/aura/only-python.exe', args: ['C:/sandbox/aura/inspector.py'] },
        unreal_editor: { command: 'C:/sandbox/aura/only-python.exe', args: ['C:/sandbox/aura/editor.py'] },
        unreal_mcp: { url: 'http://127.0.0.1:8001/mcp' },
      }),
    )
    const rows = await resolveShippedRows()
    const validated = await validateAll(rows)
    assert.equal(validated.get('mcp-aura-unreal-inspector').command, 'C:/sandbox/aura/only-python.exe')
    assert.deepEqual(validated.get('mcp-aura-unreal-inspector').args, ['C:/sandbox/aura/inspector.py'])
    assert.equal(validated.get('mcp-aura-unreal-editor').command, 'C:/sandbox/aura/only-python.exe')
    assert.deepEqual(validated.get('mcp-aura-unreal-editor').args, ['C:/sandbox/aura/editor.py'])
    assert.equal(validated.get('mcp-unreal-engine').url, 'http://127.0.0.1:8001/mcp')
    assert.equal(validated.get('mcp-unreal-engine').transport, 'streamable-http')
  })

  test('the editor row keeps its longer per-call budget', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    sandbox.writeConfig('aura', mcpServersPayload())
    const rows = await resolveShippedRows()
    const validated = await validateAll(rows)
    assert.equal(validated.get('mcp-aura-unreal-editor').toolCallTimeoutMs, 900000)
    assert.equal(validated.get('mcp-aura-unreal-inspector').toolCallTimeoutMs, 300000)
  })
})

describe("scenario C: Aura's own app config wins", () => {
  before(() => { process.env.DSH_AURA_ALLOW_ANY_COMMAND = '1' })
  after(() => { delete process.env.DSH_AURA_ALLOW_ANY_COMMAND })
  test('candidate 1 (LOCALAPPDATA) takes priority over candidate 2', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    sandbox.writeConfig(
      'aura',
      mcpServersPayload({
        unreal_inspector: { command: 'C:/sandbox/aura/loser-python.exe' },
        unreal_editor: { command: 'C:/sandbox/aura/loser-python.exe' },
        unreal_mcp: { url: 'http://127.0.0.1:8002/loser' },
      }),
    )
    sandbox.writeConfig(
      'app',
      mcpServersPayload({
        unreal_inspector: { command: 'C:/sandbox/app/winner-python.exe', args: ['C:/sandbox/app/winner_inspector.py'] },
        unreal_editor: { command: 'C:/sandbox/app/winner-python.exe', args: ['C:/sandbox/app/winner_editor.py'] },
        unreal_mcp: { url: 'http://127.0.0.1:8003/winner' },
      }),
    )
    const rows = await resolveShippedRows()
    const validated = await validateAll(rows)
    assert.equal(validated.get('mcp-aura-unreal-inspector').command, 'C:/sandbox/app/winner-python.exe')
    assert.deepEqual(validated.get('mcp-aura-unreal-inspector').args, ['C:/sandbox/app/winner_inspector.py'])
    assert.equal(validated.get('mcp-aura-unreal-editor').command, 'C:/sandbox/app/winner-python.exe')
    assert.equal(validated.get('mcp-unreal-engine').url, 'http://127.0.0.1:8003/winner')
  })

  test('a server missing from the app file still resolves from candidate 2', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    sandbox.writeConfig('app', { mcpServers: { unreal_inspector: { command: 'C:/sandbox/aura/from-app-file/python.exe', args: ['C:/sandbox/aura/from-app-file/inspector.py'] } } })
    sandbox.writeConfig('aura', mcpServersPayload({ unreal_mcp: { url: 'http://127.0.0.1:8004/aura' } }))
    const rows = await resolveShippedRows()
    const validated = await validateAll(rows)
    assert.equal(validated.get('mcp-aura-unreal-inspector').command, 'C:/sandbox/aura/from-app-file/python.exe')
    assert.equal(validated.get('mcp-aura-unreal-editor').command, 'C:/sandbox/app/python.exe')
    assert.equal(validated.get('mcp-unreal-engine').url, 'http://127.0.0.1:8004/aura')
  })

  test('a bare mcpServers map (no wrapper) is accepted', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    sandbox.writeConfig('app', mcpServersPayload().mcpServers)
    const rows = await resolveShippedRows()
    const validated = await validateAll(rows)
    assert.equal(validated.get('mcp-unreal-engine').url, 'http://127.0.0.1:9999/mcp')
  })
})

describe('regressions that must not come back', () => {
  test('pathIsLiteral: the candidate path survives evaluation as a real path', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    // Write the file at the exact path the expression derives and prove it is found.
    sandbox.writeConfig('aura', mcpServersPayload({ unreal_mcp: { url: 'http://127.0.0.1:8123/literal' } }))
    const rows = await resolveShippedRows()
    const validated = await validateAll(rows)
    assert.equal(
      validated.get('mcp-unreal-engine').url,
      'http://127.0.0.1:8123/literal',
      'the second candidate path did not resolve — a single-backslash escape would have eaten \\next or \\.dsh',
    )
  })

  test('bomTolerated: a BOM-prefixed JSON file is parsed, not silently ignored', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    sandbox.writeConfig('app', mcpServersPayload({ unreal_mcp: { url: 'http://127.0.0.1:8124/bom' } }), { bom: true })
    const rows = await resolveShippedRows()
    const validated = await validateAll(rows)
    assert.equal(validated.get('mcp-unreal-engine').url, 'http://127.0.0.1:8124/bom')
  })

  test('a corrupted JSON file falls back instead of taking the row down', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    sandbox.writeConfig('app', '{ this is not json')
    sandbox.writeConfig('aura', mcpServersPayload({ unreal_mcp: { url: 'http://127.0.0.1:8125/fallback' } }))
    const rows = await resolveShippedRows()
    const validated = await validateAll(rows)
    assert.equal(validated.get('mcp-unreal-engine').url, 'http://127.0.0.1:8125/fallback')
  })

  test('an entry with neither url nor command is skipped, not returned malformed', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    sandbox.writeConfig('app', { mcpServers: { unreal_mcp: { transport: 'streamable-http' } } })
    const rows = await resolveShippedRows()
    const validated = await validateAll(rows)
    assert.equal(validated.get('mcp-unreal-engine').url, FALLBACKS.unreal_mcp.url)
  })
})

describe('untrusted config content (audit F7)', () => {
  // The `!!js` expression turns the CONTENT of Aura's JSON into a command the MCP client
  // spawns, with no approval step in between. Whatever can write that file can therefore
  // ask DSH to run something at load time. These keep the obvious shapes out.
  test('a non-Python command is never spawned; the baked literal wins instead', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    sandbox.writeConfig('app', {
      mcpServers: { unreal_inspector: { command: 'C:/Windows/System32/cmd.exe', args: ['/c', 'calc'] } },
    })
    const validated = await validateAll(await resolveShippedRows())
    const config = validated.get('mcp-aura-unreal-inspector')
    assert.equal(config.command, FALLBACKS.unreal_inspector.command, 'the trusted literal must win')
    assert.notEqual(config.command, 'C:/Windows/System32/cmd.exe')
  })

  test('a script argument that is not a .py file is refused too', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    sandbox.writeConfig('app', {
      mcpServers: { unreal_inspector: { command: 'C:/sandbox/app/python.exe', args: ['C:/Windows/System32/calc.exe'] } },
    })
    const validated = await validateAll(await resolveShippedRows())
    assert.equal(validated.get('mcp-aura-unreal-inspector').command, FALLBACKS.unreal_inspector.command)
  })

  test('a non-loopback url is refused', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    sandbox.writeConfig('app', { mcpServers: { unreal_mcp: { url: 'http://198.51.100.7:8000/mcp' } } })
    const validated = await validateAll(await resolveShippedRows())
    assert.equal(validated.get('mcp-unreal-engine').url, FALLBACKS.unreal_mcp.url, 'must not point off-box')
  })

  test('DSH_AURA_ALLOW_ANY_COMMAND=1 is the documented escape hatch', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    sandbox.writeConfig('app', {
      mcpServers: { unreal_inspector: { command: 'C:/Windows/System32/cmd.exe', args: ['/c', 'calc'] } },
    })
    process.env.DSH_AURA_ALLOW_ANY_COMMAND = '1'
    try {
      const validated = await validateAll(await resolveShippedRows())
      assert.equal(validated.get('mcp-aura-unreal-inspector').command, 'C:/Windows/System32/cmd.exe')
    } finally {
      delete process.env.DSH_AURA_ALLOW_ANY_COMMAND
    }
  })
})

describe('portable Aura installation discovery', () => {
  test('an Aura-shaped path in app config needs an explicit installation pin', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    sandbox.publishBridge()
    const install = sandbox.installAuraFiles(join(sandbox.root, 'UE_5.8', 'Engine', 'Plugins', 'Marketplace', 'Aura'))
    sandbox.writeConfig('app', {
      mcpServers: {
        unreal_inspector: { command: install.command, args: [install.inspector] },
        unreal_editor: { command: install.command, args: [install.editor] },
      },
    })
    let validated = await validateAll(await resolveShippedRows())
    assert.equal(validated.get('mcp-aura-unreal-inspector').url, FALLBACKS.unreal_inspector.url)
    assert.equal(validated.get('mcp-aura-unreal-editor').url, FALLBACKS.unreal_editor.url)
    process.env.DSH_AURA_INSTALL_DIR = install.rootDir
    try {
      validated = await validateAll(await resolveShippedRows())
      assert.equal(validated.get('mcp-aura-unreal-inspector').command, install.command)
      assert.deepEqual(validated.get('mcp-aura-unreal-editor').args, [install.editor])
    } finally {
      delete process.env.DSH_AURA_INSTALL_DIR
    }
  })

  test('a configured installation outside the default directory is trusted', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    sandbox.publishBridge()
    const install = sandbox.installAuraFiles(join(sandbox.root, 'other-aura-install'))
    process.env.DSH_AURA_INSTALL_DIR = install.rootDir
    try {
      sandbox.writeConfig('app', {
        mcpServers: {
          unreal_inspector: { command: install.command, args: [install.inspector] },
          unreal_editor: { command: install.command, args: [install.editor] },
        },
      })
      const validated = await validateAll(await resolveShippedRows())
      assert.equal(validated.get('mcp-aura-unreal-inspector').command, install.command)
      assert.deepEqual(validated.get('mcp-aura-unreal-editor').args, [install.editor])
    } finally {
      delete process.env.DSH_AURA_INSTALL_DIR
    }
  })
})

describe('bridge guard: Aura is not running', () => {
  // Found 2026-09-20 in an isolated sandbox profile: with Aura absent, the two stdio servers
  // spawn, refuse to run, and RETRY ONCE A SECOND FOREVER. A two-word prompt took 67.3s and
  // stderr was nothing but that retry line. The guard is what stops that.
  test('the two stdio rows degrade to a dead endpoint instead of spawning Python', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    sandbox.clearBridge() // the exact condition the Python servers spin on
    const validated = await validateAll(await resolveShippedRows())

    for (const id of ['mcp-aura-unreal-inspector', 'mcp-aura-unreal-editor']) {
      const config = validated.get(id)
      assert.equal(config.transport, 'streamable-http', `${id} must not hand back a stdio transport`)
      assert.equal(config.command, undefined, `${id} must not carry a command — that is what spawns Python`)
      assert.equal(config.url, 'http://127.0.0.1:1/mcp', `${id} must aim at a closed port so it fails fast`)
      assert.equal(config.failOnStartupError, false)
    }

    // The engine's own server has no child process, so the guard must leave it alone.
    const engine = validated.get('mcp-unreal-engine')
    assert.equal(engine.transport, 'streamable-http')
    assert.equal(engine.url, 'http://127.0.0.1:8000/mcp')
  })

  test('publishing the bridge restores the stdio config', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    sandbox.publishBridge()
    const install = sandbox.installAuraFiles()
    const validated = await validateAll(await resolveShippedRows())
    const config = validated.get('mcp-aura-unreal-inspector')
    assert.equal(config.transport, 'stdio')
    assert.equal(config.command, install.command)
    assert.deepEqual(config.args, [install.inspector])
  })

  // Guards against the audit's F5: existence alone is not liveness. A leftover file from a
  // dead app used to sail straight through and bring the retry loop back.
  for (const [label, content] of [
    ['empty', ''],
    ['whitespace only', '   \n'],
    ['not a number', 'not-a-port\n'],
    ['zero', '0\n'],
    ['out of range', '70000\n'],
  ]) {
    test(`a bridge file that is ${label} reads as "not up"`, async () => {
      sandbox.activate()
      sandbox.clearConfigs()
      sandbox.writeBridge(content)
      const validated = await validateAll(await resolveShippedRows())
      const config = validated.get('mcp-aura-unreal-inspector')
      assert.equal(config.transport, 'streamable-http', `${label}: must not hand back stdio`)
      assert.equal(config.command, undefined, `${label}: must not carry a command`)
      assert.equal(config.url, 'http://127.0.0.1:1/mcp')
    })
  }

  // Guards against the audit's F4: the polarity used to be backwards. When the guard itself
  // cannot be evaluated the answer must be DEAF, never STDIO -- otherwise an older Node
  // (no `getBuiltinModule`) silently restores the 67.3 s retry loop.
  test('an unreadable bridge path fails CLOSED, not open', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    // A directory in place of the file: readFileSync throws EISDIR, i.e. "cannot tell".
    sandbox.clearBridge()
    mkdirSync(sandbox.bridgePath, { recursive: true })
    try {
      const validated = await validateAll(await resolveShippedRows())
      const config = validated.get('mcp-aura-unreal-inspector')
      assert.equal(config.transport, 'streamable-http', 'an exception must land on the dead endpoint')
      assert.equal(config.command, undefined)
    } finally {
      rmSync(sandbox.bridgePath, { recursive: true, force: true })
    }
  })

  // The escape hatch for an Aura this cannot locate (audit F6).
  test('DSH_AURA_FORCE_STDIO=1 skips the guard entirely', async () => {
    sandbox.activate()
    sandbox.clearConfigs()
    sandbox.clearBridge()
    const install = sandbox.installAuraFiles()
    process.env.DSH_AURA_FORCE_STDIO = '1'
    try {
      const validated = await validateAll(await resolveShippedRows())
      const config = validated.get('mcp-aura-unreal-inspector')
      assert.equal(config.transport, 'stdio')
      assert.equal(config.command, install.command)
    } finally {
      delete process.env.DSH_AURA_FORCE_STDIO
    }
  })
})
