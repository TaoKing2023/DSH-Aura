import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planSync, writePatchFile } from '../scripts/Sync-AuraMcp.mjs'
import { parsePatch } from '../lib/mcp/patch-yaml.js'
import { assertSingleOwner, collectRowIds, detectChannel } from '../lib/mcp/channels.js'
import { renderBundlePatch, renderConfigExpr } from '../lib/mcp/rows.js'
import { createPassRunner } from '../lib/pass.js'
import { effectiveConfig } from '../lib/config.js'
import { createEnvSandbox } from './helpers/env-sandbox.mjs'
import { createFakePersistence, createFakeRegistry, createFakeProjectionCache, sessionFixture, userMessage, titleEventFixture } from './helpers/stub-dsh.mjs'

test('R1: sync after a trailing override remains valid and preserves the existing prefix', () => {
  const source = '- insert:\n    - id: unrelated\n      name: unrelated-package\n- id: unrelated\n  config:\n    enabled: true\n'
  const plan = planSync({ text: source })
  assert.equal(plan.ok, true, plan.reason)
  assert.ok(plan.text.startsWith(source))
  const patches = parsePatch(plan.text)
  assert.equal(patches.length, 3)
  assert.equal(patches[2].insert.length, 3)
  assert.equal(planSync({ text: plan.text }).action, 'unchanged')
})

test('R1/R2: malformed output and duplicate IDs are refused before the file is backed up or written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-aura-write-regression-'))
  const file = join(dir, 'patch.yml')
  writeFileSync(file, '# original\n')
  for (const text of ['- insert:\n  broken: [\n', '- insert: [{id: x}, {id: x}]\n']) {
    assert.throws(() => writePatchFile(file, text))
    assert.equal(readFileSync(file, 'utf8'), '# original\n')
    assert.equal(planSync({ text }).ok, false)
  }
})

test('R2: quoted/commented/flow/aliased inserts count, legitimate overrides and config IDs do not', () => {
  const text = `- insert:
    - &row {name: dsh-aura, id: "dsh-aura"} # comment
    - *row
- id: dsh-aura
  config:
    entries:
      - id: not-a-loader-row
    message: !!js 'throw new Error("must not execute")'
`
  assert.deepEqual(collectRowIds(text), ['dsh-aura', 'dsh-aura'])
  assert.throws(() => assertSingleOwner([{source: 'one-file', text}]), /duplicate loader row/)
  for (const id of ['dsh-aura # comment', '"dsh-aura"', "'dsh-aura'"]) {
    assert.equal(detectChannel({inBundleList: true, profilePatchText: `- insert:\n    - id: ${id}\n`, bundlePatchText: renderBundlePatch()}).channel, 'conflict')
  }
  assert.equal(detectChannel({inBundleList: true, profilePatchText: '- id: dsh-aura\n  config: {pollMs: 5000}\n', bundlePatchText: renderBundlePatch()}).channel, 'B')
  assert.deepEqual(collectRowIds('- insert:\n    - id: outer\n      group: true\n      config:\n        - id: inner\n'), ['outer', 'inner'])
})

function runner(sessions, cache, overrides = {}) {
  return createPassRunner({services: {persistence: createFakePersistence(sessions), registry: createFakeRegistry(), projectionCache: cache}, isUeProject: async () => true, config: effectiveConfig({policyProbeEnabled: false, reportEnabled: false, ...overrides}), log() {}})
}
function titled(id, options = {}) {
  return sessionFixture({id, cwd: '/project', events: [userMessage('[router] policy\n\nActual question', 1), titleEventFixture('[router] policy', 2)], ...options})
}

for (const restart of [false, true]) {
  test(`R4: failed projection retries without another append (restart=${restart})`, async () => {
    const session = titled('retry')
    const cache = createFakeProjectionCache()
    const cold = cache.coldSnapshot.bind(cache)
    let attempts = 0
    cache.coldSnapshot = async (...args) => { if (++attempts === 1) throw new Error('transient'); return cold(...args) }
    let run = runner([session], cache)
    assert.equal((await run('initial')).renamed, 1)
    assert.equal(session.appended.length, 1)
    if (restart) run = runner([session], cache)
    await run('poll')
    assert.equal(attempts, 2)
    assert.equal(cache.cachedSnapshot(session.header).values.title, 'Actual question')
    await run('poll')
    assert.equal(attempts, 2)
    assert.equal(session.appended.length, 1)
  })
}

test('R8: 60 held sessions cannot starve a writable session across projects', async () => {
  const held = Array.from({length: 60}, (_, i) => titled(`held${i}`, {busy: true}))
  const tail = titled('tail', {cwd: '/another-project'})
  const run = runner([...held, tail], createFakeProjectionCache())
  await run('initial')
  assert.equal(tail.reads, 0)
  await run('poll')
  assert.equal(tail.appended.length, 1)
  assert.equal(held.reduce((n, s) => n + s.appended.length, 0), 0)
})

test('a held session reports an asynchronous read-only projection write as pending', async () => {
  const session = titled('held-title', { busy: true })
  const cache = createFakeProjectionCache()
  cache.coldSnapshot = () => ({ values: { title: '[router] policy' } })
  const report = await runner([session], cache)('initial')
  assert.ok(report.titles.includes('held-tit surfaced-pending(2)'))
  assert.equal(session.appended.length, 0)
})

test('R5/R9: strict bridge and canonical installation paths gate stdio', () => {
  const sandbox = createEnvSandbox()
  const keys = ['DSH_AURA_INSTALL_DIR', 'DSH_AURA_FORCE_STDIO', 'DSH_AURA_ALLOW_ANY_COMMAND', 'DSH_AURA_BRIDGE']
  const saved = new Map(keys.map(k => [k, process.env[k]]))
  try {
    sandbox.activate()
    for (const k of keys) delete process.env[k]
    const root = join(sandbox.root, 'trusted', 'Aura')
    const python = join(root, 'PortablePython', 'Windows', 'python.exe')
    const script = join(root, 'MCP', 'unreal_inspector.py')
    mkdirSync(join(root, 'PortablePython', 'Windows'), {recursive: true})
    mkdirSync(join(root, 'MCP'), {recursive: true})
    writeFileSync(python, '')
    writeFileSync(script, '')
    process.env.DSH_AURA_INSTALL_DIR = root
    const evaluate = () => new Function(`return ${renderConfigExpr('unreal_inspector')}`)()
    const set = (command, args) => sandbox.writeConfig('app', {mcpServers: {unreal_inspector: {command, args}}})
    set(python, [script])
    assert.equal(evaluate().command, python)
    for (const garbage of ['41200garbage', '41200.5', '1e3', '+41200', '0x1234', '-1', '65536']) {
      sandbox.writeBridge(garbage)
      assert.equal(evaluate().transport, 'streamable-http', garbage)
    }
    sandbox.publishBridge()
    for (const [command, args] of [
      ['C:/untrusted/aura/cmd.exe', []], [python, []], [python, [script, '--extra']],
      [python, [join(root, 'MCP', 'other.py')]], ['python.exe', [script]],
    ]) {
      set(command, args)
      assert.equal(evaluate().command, python, 'an invalid candidate must fall back to the verified installation')
    }
    const outside = join(sandbox.root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'python.exe'), '')
    const alias = join(root, 'redirected')
    symlinkSync(outside, alias, 'junction')
    set(join(alias, 'python.exe'), [script])
    assert.equal(evaluate().command, python, 'a junction outside the trusted layout is refused')
    process.env.DSH_AURA_ALLOW_ANY_COMMAND = '1'
    set('custom-client.exe', [])
    assert.equal(evaluate().command, 'custom-client.exe')
  } finally {
    sandbox.restore()
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
})
