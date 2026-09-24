/**
 * End-to-end smoke test: drive `apply()` with a stub host.
 *
 * Everything here runs offline — no `dsh` process, no network, no profile. The stub models
 * the parts of the host the plugin touches, with the behaviours that actually matter
 * modelled faithfully: `attachSession` prepends (which is why recency re-placement exists),
 * `open(id, 'write')` throws for a session an ACP child holds while `open(id, 'read')`
 * still succeeds, and a session's listing rows exist only after a fold.
 *
 * Covered: service wiring, idempotent apply, the grouping/ordering pass, title backfill
 * with the projection re-fold, the read-only surfacing of a held session's title, the report
 * shape, and the first-step-only prompt injection.
 *
 * @module dsh-aura/tests/apply-smoke.test
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { apply as applyPlugin, inject, name } from '../index.js'
import { INJECTION_SOURCE_KIND } from '../lib/prompt/inject.js'
import { createRecencyIndex } from '../lib/session/recency.js'
import { groupProject } from '../lib/session/grouping.js'
import {
  captureConsole,
  createFakePersistence,
  createFakeProjectionCache,
  createFakeRegistry,
  createFsFixture,
  createStubCtx,
  loaderEntries,
  sessionFixture,
  titleEventFixture,
  userMessage,
} from './helpers/stub-dsh.mjs'

// Stub-host tests must never probe the operator's real local router.
const apply = (ctx, config) => applyPlugin(ctx, { policyProbeEnabled: false, ...config })

/** On-disk fixture: one UE project directory and one plain directory. */
let tree
before(() => {
  tree = createFsFixture({
    'TestProject': ['Test.uproject', 'readme.txt'],
    'plain': ['notes.md'],
  })
})
after(() => tree.cleanup())

/**
 * Build a fully-wired stub host for one test.
 * @param {object} [options] - overrides.
 * @param {object[]} [options.sessions] - session fixtures.
 * @param {Array<any>} [options.entries] - loader entries.
 * @param {object} [options.config] - the plugin config.
 * @returns {object} the harness.
 */
async function buildHarness(options = {}) {
  const sessions = options.sessions ?? []
  const persistence = createFakePersistence(sessions)
  const registry = createFakeRegistry()
  const projectionCache = createFakeProjectionCache({ lastPromptAt: options.lastPromptAt ?? {}, titled: options.titled ?? {} })
  const stub = createStubCtx({
    services: {
      fs: tree.fs,
      sessionPersistence: persistence,
      workspaceRegistry: registry,
      sessionProjectionCache: projectionCache,
    },
    entries: options.entries ?? loaderEntries({ channel: 'A' }),
  })
  return { ...stub, persistence, registry, projectionCache }
}

describe('apply(): wiring', () => {
  test('named exports only, inject lists exactly the five services', () => {
    assert.equal(name, 'dsh-aura')
    assert.deepEqual(inject, ['timer', 'fs', 'sessionPersistence', 'workspaceRegistry', 'sessionProjectionCache'])
  })

  test('arms one delayed first pass, one interval, and one pre-step handler', async () => {
    const harness = await buildHarness()
    const { log } = await captureConsole(async () => apply(harness.ctx, undefined))
    assert.equal(harness.timers.length, 2)
    assert.deepEqual(
      harness.timers.map((timer) => [timer.kind, timer.delay]),
      [
        ['timeout', 1500],
        ['interval', 120000],
      ],
    )
    assert.equal(harness.handlers.get('agent/pre-step')?.length, 1)
    assert.ok(
      log.some((line) => line.includes('[dsh-aura] armed') && line.includes('channel=A')),
      `expected an armed line with channel=A, got: ${log.join(' | ')}`,
    )
    assert.ok(
      log.some((line) => line.includes('selfcheck owner=sole channel=A') && line.includes('rows=4/4')),
      `expected a sole-owner selfcheck line, got: ${log.join(' | ')}`,
    )
  })

  test('registers NO tool: the tools service is never touched', async () => {
    let registerCalls = 0
    const harness = await buildHarness()
    harness.services.tools = {
      register() {
        registerCalls += 1
      },
    }
    await captureConsole(async () => apply(harness.ctx, undefined))
    assert.equal(registerCalls, 0)
  })

  test('every service apply() asks for is either declared in inject or a documented existence probe', async () => {
    const harness = await buildHarness()
    await captureConsole(async () => apply(harness.ctx, undefined))
    await captureConsole(() => harness.runInitial())
    assert.ok(harness.requested.length > 0)
    // `loader` and `tools` are read ONLY to answer "does it exist?" — see lib/selfcheck.js.
    // They are deliberately not in `inject`: the self-check is optional, and declaring a
    // service with no benefit only widens what must resolve before the plugin may activate.
    const optionalProbes = new Set(['loader', 'tools'])
    const undeclared = harness.requested.filter((name) => !inject.includes(name) && !optionalProbes.has(name))
    assert.deepEqual(undeclared, [], 'a service that is not declared in inject must never be read')
  })

  test('a missing declared service is reported loudly and arms nothing', async () => {
    const stub = createStubCtx({ services: { fs: tree.fs } })
    const { log } = await captureConsole(async () => apply(stub.ctx, undefined))
    assert.equal(stub.timers.length, 0)
    assert.ok(log.some((line) => line.includes('declared service(s) missing at apply') && line.includes('sessionPersistence')))
  })

  // REGRESSION (found 2026-09-20 by adversarial review; fixed by deleting the
  // context-keyed `APPLIED` WeakSet).
  //
  // A Cordis fiber creates its `ctx` ONCE and reuses it across `update()` / `restart()`, and
  // every effect the previous activation registered is disposed on unload. An applied-once
  // guard keyed on `ctx` therefore made the second apply a no-op that armed nothing, while
  // the fiber still reported `state: 2` (active): silently dead, and it did not recover on a
  // later edit. Measured against the shipped cordis before the fix:
  //   after 1st apply       { applies: 1, armed: 1, state: 2 }
  //   after hot config edit { applies: 2, armed: 0, state: 2 }   <- dead
  //   after revert          { applies: 3, armed: 0, state: 2 }   <- still dead
  //
  // The assertion this replaces ("applying twice on the same context is idempotent") got the
  // contract backwards and pinned the defect, because the stub's `effect` never expired.
  test('re-applying after a fiber unload re-arms the timers and the handler', async () => {
    const harness = await buildHarness()
    await captureConsole(async () => apply(harness.ctx, undefined))
    assert.equal(harness.timers.length, 2)
    assert.equal(harness.handlers.get('agent/pre-step')?.length, 1)

    harness.unload() // what `fiber.update()` does before re-invoking apply
    assert.equal(harness.timers.length, 0)
    assert.equal(harness.handlers.get('agent/pre-step'), undefined)

    await captureConsole(async () => apply(harness.ctx, undefined))
    assert.equal(harness.timers.length, 2, 'the second activation must re-arm the poller')
    assert.equal(
      harness.handlers.get('agent/pre-step')?.length,
      1,
      'the second activation must re-register the pre-step handler',
    )
  })

  test('injectionEnabled=false skips the handler but keeps the pass', async () => {
    const harness = await buildHarness()
    const { log } = await captureConsole(async () => apply(harness.ctx, { injectionEnabled: false }))
    assert.equal(harness.handlers.get('agent/pre-step'), undefined)
    assert.equal(harness.timers.length, 2)
    assert.ok(log.some((line) => line.includes('prompt injection disabled by config')))
  })
})

describe('pass(): grouping and ordering', () => {
  test('reorders an attached session when its projection recency becomes available', async () => {
    const registry = createFakeRegistry()
    const cwd = tree.dir('TestProject')
    const at = { older: 100, newer: 500 }
    const options = { registry, cwd, ids: ['older', 'newer'], recencyOf: (id) => at[id], log() {} }
    await groupProject(options)
    const row = registry.rows.get(cwd)
    assert.deepEqual(row.sessionIds, ['newer', 'older'])
    at.older = 1000
    const result = await groupProject(options)
    assert.equal(result.attached, 0)
    assert.deepEqual(row.sessionIds, ['older', 'newer'])
  })
  test('groups UE project sessions, skips plain and subagent sessions, orders by recency', async () => {
    const projectDir = tree.dir('TestProject')
    const sessions = [
      sessionFixture({ id: 'aaa11111', cwd: projectDir, createdAt: 100 }),
      sessionFixture({ id: 'bbb22222', cwd: projectDir, createdAt: 300 }),
      sessionFixture({ id: 'ccc33333', cwd: projectDir, createdAt: 200 }),
      sessionFixture({ id: 'ddd44444', cwd: tree.dir('plain'), createdAt: 900 }),
      sessionFixture({ id: 'eee55555', cwd: projectDir, createdAt: 800, origin: 'subagent' }),
    ]
    const harness = await buildHarness({ sessions })
    await captureConsole(async () => apply(harness.ctx, { titleFixPerPass: 0 }))
    const report = await captureConsole(() => harness.runInitial()).then((captured) => captured.result)

    assert.deepEqual(report.projects, [{ dir: projectDir, sessions: 3, attached: 3 }])
    assert.equal(report.attached, 3)
    const row = harness.registry.rows.get(projectDir)
    assert.equal(row.title, 'TestProject')
    assert.deepEqual(row.sessionIds, ['bbb22222', 'ccc33333', 'aaa11111'], 'sessions must end up newest-first')
    assert.equal(harness.registry.rows.has(tree.dir('plain')), false)
    assert.equal(row.sessionIds.includes('eee55555'), false, 'subagent sessions must not be grouped')
  })

  test('recency is max(header.createdAt, projection lastPromptAt) and decides the order', async () => {
    const projectDir = tree.dir('TestProject')
    const sessions = [
      sessionFixture({ id: 'aaa11111', cwd: projectDir, createdAt: 100 }),
      sessionFixture({ id: 'bbb22222', cwd: projectDir, createdAt: 200 }),
      sessionFixture({ id: 'ccc33333', cwd: projectDir, createdAt: 300 }),
    ]
    // lastPromptAt pushes bbb past ccc, so the recency order (bbb > ccc > aaa) differs from
    // the createdAt order (ccc > bbb > aaa).
    const harness = await buildHarness({ sessions, lastPromptAt: { bbb22222: 1000 } })
    await captureConsole(async () => apply(harness.ctx, { titleFixPerPass: 0 }))
    await captureConsole(() => harness.runInitial())
    const ordered = harness.registry.rows.get(projectDir).sessionIds
    assert.deepEqual(ordered, ['bbb22222', 'ccc33333', 'aaa11111'])
    assert.notDeepEqual(ordered, ['ccc33333', 'bbb22222', 'aaa11111'], 'createdAt alone would have produced this order')
  })

  test('recency index: lastPromptAt wins only when it is larger', () => {
    const header = { id: 'x', createdAt: 500 }
    const cache = {
      cachedSnapshot: () => ({ values: { sessionListMetadata: { lastPromptAt: 100 } } }),
    }
    const index = createRecencyIndex(cache)
    index.reset([{ header }])
    assert.equal(index.recencyOf('x'), 500, 'a smaller lastPromptAt must not lower the recency')
    const newer = createRecencyIndex({ cachedSnapshot: () => ({ values: { sessionListMetadata: { lastPromptAt: 900 } } }) })
    newer.reset([{ header }])
    assert.equal(newer.recencyOf('x'), 900)
    const withoutCache = createRecencyIndex(undefined)
    withoutCache.reset([{ header }])
    assert.equal(withoutCache.recencyOf('x'), 500)
    assert.equal(withoutCache.recencyOf('unknown'), 0)
  })

  test('a session older than every sibling is appended to the end', async () => {
    const projectDir = tree.dir('TestProject')
    const sessions = [
      sessionFixture({ id: 'recent11', cwd: projectDir, createdAt: 9000 }),
      sessionFixture({ id: 'ancient1', cwd: projectDir, createdAt: 10 }),
    ]
    const harness = await buildHarness({ sessions })
    await captureConsole(async () => apply(harness.ctx, { titleFixPerPass: 0 }))
    await captureConsole(() => harness.runInitial())
    assert.deepEqual(harness.registry.rows.get(projectDir).sessionIds, ['recent11', 'ancient1'])
  })

  test('a second pass does not re-attach anything and emits the report shape', async () => {
    const projectDir = tree.dir('TestProject')
    const sessions = [sessionFixture({ id: 'pass1111', cwd: projectDir, createdAt: 10 })]
    const harness = await buildHarness({ sessions })
    await captureConsole(async () => apply(harness.ctx, { titleFixPerPass: 0 }))
    await captureConsole(() => harness.runInitial())
    const second = await captureConsole(() => harness.runPoll())
    const report = second.result
    assert.equal(report.attached, 0)
    assert.equal(report.tag, 'poll')
    assert.deepEqual(Object.keys(report).sort(), ['attached', 'projects', 'renamed', 'tag', 'titles'])
    const line = second.log.find((entry) => entry.includes('poll '))
    assert.ok(line !== undefined && line.includes('"attached":0'), `expected the JSON report line, got: ${second.log.join(' | ')}`)
  })
})

describe('pass(): title backfill', () => {
  test('rewrites a [router] title from the first human message and re-folds the projection', async () => {
    const projectDir = tree.dir('TestProject')
    const question = '把 SkillTree 的加点面板改成鼠标悬停显示详情'
    const session = sessionFixture({
      id: 'titre111',
      cwd: projectDir,
      createdAt: 100,
      inheritedEventCount: 7,
      events: [
        userMessage(`[router] 现在是 Ask 模式：只读\n\n${question}`, 1),
        titleEventFixture('[router] 现在是 Ask 模式：只读 把 SkillTree', 2),
      ],
    })
    const harness = await buildHarness({ sessions: [session] })
    await captureConsole(async () => apply(harness.ctx, {}))
    const report = await captureConsole(() => harness.runInitial()).then((captured) => captured.result)

    assert.equal(report.renamed, 1)
    assert.equal(session.appended.length, 1)
    const event = session.appended[0]
    assert.equal(event.type, 'session/title')
    assert.equal(event.seq, 3, 'seq must be maxSeq + 1 from the same read')
    assert.deepEqual(event.data, { title: question, messageSeqs: [], source: { kind: 'user' } })
    assert.equal(session.flushes, 1)
    assert.equal(harness.projectionCache.coldSnapshots.length, 1, 'the sidebar only sees the title after coldSnapshot')
    assert.equal(harness.projectionCache.coldSnapshots[0].id, 'titre111')
    assert.equal(harness.projectionCache.coldSnapshots[0].inheritedEventCount, 7, 'inheritedEventCount must come from the handle')
    assert.equal(harness.projectionCache.coldSnapshots[0].eventCount, 3)
    assert.equal(session.closes, 1)
  })

  test('a user-set title is never overwritten', async () => {
    const projectDir = tree.dir('TestProject')
    const session = sessionFixture({
      id: 'keep1111',
      cwd: projectDir,
      events: [userMessage('随便问问', 1), titleEventFixture('功能|随便问问|0919', 2)],
    })
    const harness = await buildHarness({ sessions: [session] })
    await captureConsole(async () => apply(harness.ctx, {}))
    const report = await captureConsole(() => harness.runInitial()).then((captured) => captured.result)
    assert.equal(report.renamed, 0)
    assert.equal(session.appended.length, 0)
    assert.equal(harness.projectionCache.coldSnapshots.length, 1, 'existing titles must be reconciled with this host cache')
  })

  test('a session held by an ACP child is left unwritten but made VISIBLE here', async () => {
    const projectDir = tree.dir('TestProject')
    const session = sessionFixture({
      id: 'busy1111',
      cwd: projectDir,
      busy: true,
      events: [userMessage('[router] 规则\n\n真正的问题', 1), titleEventFixture('[router] 规则', 2)],
    })
    const harness = await buildHarness({ sessions: [session] })
    await captureConsole(async () => apply(harness.ctx, {}))
    const first = await captureConsole(() => harness.runInitial()).then((captured) => captured.result)
    assert.deepEqual(first.titles, ['busy1111 surfaced(2)'])
    assert.deepEqual(
      harness.persistence.opened,
      [{ id: 'busy1111', access: 'read' }],
      'the write handle must be refused and only a read taken',
    )
    assert.equal(session.appended.length, 0, 'a session another process owns must never be written')
    assert.equal(session.flushes, 0)
    assert.equal(harness.projectionCache.coldSnapshots.length, 1, 'the fold is what makes the row readable')
    assert.equal(harness.projectionCache.coldSnapshots[0].id, 'busy1111')
    assert.equal(harness.projectionCache.coldSnapshots[0].eventCount, 2)

    // A router placeholder may be replaced by the owning host later, so check it again.
    const settled = await captureConsole(() => harness.runPoll()).then((captured) => captured.result)
    assert.deepEqual(settled.titles, ['busy1111 surfaced(2)'])
    assert.equal(harness.projectionCache.coldSnapshots.length, 2)

    session.busy = false
    const second = await captureConsole(() => harness.runPoll()).then((captured) => captured.result)
    assert.equal(second.renamed, 1, 'the busy session must be retried on the next pass')
    assert.equal(session.appended[0].data.title, '真正的问题')
  })

  test('a held session that cannot be read either degrades to busy, never throws', async () => {
    const projectDir = tree.dir('TestProject')
    const session = sessionFixture({
      id: 'dark1111',
      cwd: projectDir,
      busy: true,
      unreadable: true,
      events: [userMessage('[router] 规则\n\n问题', 1), titleEventFixture('[router] 规则', 2)],
    })
    const harness = await buildHarness({ sessions: [session] })
    await captureConsole(async () => apply(harness.ctx, {}))
    const report = await captureConsole(() => harness.runInitial()).then((captured) => captured.result)
    assert.deepEqual(report.titles, ['dark1111 busy'])
    assert.equal(report.error, undefined)
    assert.equal(harness.projectionCache.coldSnapshots.length, 0)
  })

  test('a held session this host can already title is not touched at all', async () => {
    const projectDir = tree.dir('TestProject')
    const session = sessionFixture({
      id: 'shown111',
      cwd: projectDir,
      busy: true,
      events: [userMessage('[router] 规则\n\n问题', 1), titleEventFixture('[router] 规则', 2)],
    })
    // The listing already serves a title for it: no read, no fold.
    const harness = await buildHarness({ sessions: [session], titled: { shown111: '功能|问题|0920' } })
    await captureConsole(async () => apply(harness.ctx, {}))
    const report = await captureConsole(() => harness.runInitial()).then((captured) => captured.result)
    assert.deepEqual(report.titles, [], 'a row that already reads correctly is not an exception')
    assert.deepEqual(harness.persistence.opened, [], 'the sidebar question is answered with no I/O')
    assert.equal(harness.projectionCache.coldSnapshots.length, 0)
  })

  test('a held session with a stale router title is read-only refolded', async () => {
    const projectDir = tree.dir('TestProject')
    const session = sessionFixture({
      id: 'routerold',
      cwd: projectDir,
      busy: true,
      events: [userMessage('真正的问题', 1), titleEventFixture('[router] 规则', 2), titleEventFixture('真正的问题', 3)],
    })
    const harness = await buildHarness({ sessions: [session], titled: { routerold: '[router] 规则' } })
    await captureConsole(async () => apply(harness.ctx, {}))
    const report = await captureConsole(() => harness.runInitial()).then((captured) => captured.result)
    assert.deepEqual(report.titles, ['routerol surfaced(3)'])
    assert.equal(harness.projectionCache.titled.get('routerold'), '真正的问题')
    assert.equal(session.appended.length, 0)
  })

  test('a LAGGING checkpoint without a title is still folded (sandbox case)', async () => {
    const projectDir = tree.dir('TestProject')
    const session = sessionFixture({
      id: 'stale111',
      cwd: projectDir,
      busy: true,
      events: [userMessage('[router] 规则\n\n问题', 1), titleEventFixture('[router] 规则', 2)],
    })
    // Rows exist for the session, so `cachedSnapshot` is not undefined — but the cut carries
    // no `title`, which is the state that still renders as the bare directory name.
    const harness = await buildHarness({ sessions: [session], lastPromptAt: { stale111: 900 } })
    await captureConsole(async () => apply(harness.ctx, {}))
    const report = await captureConsole(() => harness.runInitial()).then((captured) => captured.result)
    assert.deepEqual(report.titles, ['stale111 surfaced(2)'])
    assert.equal(harness.projectionCache.coldSnapshots.length, 1)

    const settled = await captureConsole(() => harness.runPoll()).then((captured) => captured.result)
    assert.deepEqual(settled.titles, ['stale111 surfaced(2)'])
    assert.equal(harness.projectionCache.coldSnapshots.length, 2)
  })

  test('an empty stored log is not folded and stays busy', async () => {
    const projectDir = tree.dir('TestProject')
    const session = sessionFixture({ id: 'void1111', cwd: projectDir, busy: true, events: [] })
    const harness = await buildHarness({ sessions: [session] })
    await captureConsole(async () => apply(harness.ctx, {}))
    const report = await captureConsole(() => harness.runInitial()).then((captured) => captured.result)
    assert.deepEqual(report.titles, ['void1111 busy'])
    assert.equal(harness.projectionCache.coldSnapshots.length, 0)
  })

  test('titleFixPerPass=0 performs no backfill at all', async () => {
    const projectDir = tree.dir('TestProject')
    const session = sessionFixture({
      id: 'budg1111',
      cwd: projectDir,
      events: [userMessage('[router] 规则\n\n问题', 1), titleEventFixture('[router] 规则', 2)],
    })
    const harness = await buildHarness({ sessions: [session] })
    await captureConsole(async () => apply(harness.ctx, { titleFixPerPass: 0 }))
    const report = await captureConsole(() => harness.runInitial()).then((captured) => captured.result)
    assert.equal(report.renamed, 0)
    assert.equal(harness.persistence.opened.length, 0)
  })

  test('a projection failure degrades instead of breaking the pass', async () => {
    const projectDir = tree.dir('TestProject')
    const session = sessionFixture({
      id: 'fold1111',
      cwd: projectDir,
      events: [userMessage('[router] 规则\n\n问题', 1), titleEventFixture('[router] 规则', 2)],
    })
    const harness = await buildHarness({ sessions: [session] })
    harness.projectionCache.coldSnapshot = () => {
      throw new Error('cache refused the record')
    }
    await captureConsole(async () => apply(harness.ctx, {}))
    const captured = await captureConsole(() => harness.runInitial())
    assert.equal(captured.result.renamed, 1, 'the log write still counts as a rename')
    assert.ok(captured.log.some((line) => line.includes('projection refold failed')))
  })
})

describe('agent/pre-step: prompt constraints', () => {
  /**
   * Invoke the registered pre-step handler.
   * @param {object} harness - the harness.
   * @param {object} session - the live session stub.
   * @param {object} [options] - invocation options.
   * @returns {Promise<object>} the decision.
   */
  async function runPreStep(harness, session, options = {}) {
    const handler = harness.preStep()
    assert.ok(handler !== undefined, 'no agent/pre-step handler was registered')
    const claimed = options.claimed ?? [{ role: 'user' }]
    return handler({ agent: { session }, messages: claimed }, async () => options.decision ?? { kind: 'continue', messages: claimed })
  }

  test('injects once into a UE project session, with the dsh-aura identity', async () => {
    const projectDir = tree.dir('TestProject')
    const harness = await buildHarness()
    const session = { header: { id: 'step1111', cwd: projectDir }, snapshotEvents: () => [] }
    await captureConsole(async () => apply(harness.ctx, undefined))
    const decision = await runPreStep(harness, session)
    assert.equal(decision.messages.length, 2)
    const reminder = decision.messages[1]
    assert.equal(reminder.role, 'user')
    assert.equal(reminder.source.kind, INJECTION_SOURCE_KIND)
    assert.equal(
      reminder.source.plugin,
      undefined,
      'session format V4 producer-owned kinds carry no `plugin` field',
    )
    const text = reminder.content[0].text
    assert.ok(text.startsWith('<system-reminder>'))
    assert.ok(text.trimEnd().endsWith('</system-reminder>'))
    assert.ok(text.includes('交付物 = 结果 + 简短规范'))
    assert.ok(text.includes('动手前先备份'))
    assert.ok(text.includes('先加载技能'))
    assert.ok(text.includes('如果本工作区自带快照脚本'))
  })

  test('does not inject a second time once its own message is in the log', async () => {
    const projectDir = tree.dir('TestProject')
    const harness = await buildHarness()
    await captureConsole(async () => apply(harness.ctx, undefined))
    const injected = {
      type: 'user/message',
      seq: 1,
      data: { content: [{ type: 'text', text: '<system-reminder>…</system-reminder>' }], source: { kind: INJECTION_SOURCE_KIND } },
    }
    const session = { header: { id: 'step2222', cwd: projectDir }, snapshotEvents: () => [injected] }
    const decision = await runPreStep(harness, session)
    assert.equal(decision.messages.length, 1)
  })

  test('does not inject after the first step (an assistant message exists)', async () => {
    const projectDir = tree.dir('TestProject')
    const harness = await buildHarness()
    await captureConsole(async () => apply(harness.ctx, undefined))
    const session = { header: { id: 'step3333', cwd: projectDir }, snapshotEvents: () => [{ type: 'assistant/message', seq: 2 }] }
    const decision = await runPreStep(harness, session)
    assert.equal(decision.messages.length, 1)
  })

  test('does not inject into a non-UE session (no .uproject on disk)', async () => {
    const harness = await buildHarness()
    await captureConsole(async () => apply(harness.ctx, undefined))
    const session = { header: { id: 'step4444', cwd: tree.dir('plain') }, snapshotEvents: () => [] }
    const decision = await runPreStep(harness, session)
    assert.equal(decision.messages.length, 1)
  })

  test('does not depend on an AGENTS.md anywhere: only a *.uproject is required', async () => {
    const projectDir = tree.dir('TestProject')
    const harness = await buildHarness()
    await captureConsole(async () => apply(harness.ctx, undefined))
    const session = { header: { id: 'step5555', cwd: projectDir }, snapshotEvents: () => [] }
    const decision = await runPreStep(harness, session)
    assert.equal(decision.messages.length, 2, 'a UE project dir with no AGENTS.md must still receive the rules')
  })

  test('respects a reject decision', async () => {
    const projectDir = tree.dir('TestProject')
    const harness = await buildHarness()
    await captureConsole(async () => apply(harness.ctx, undefined))
    const session = { header: { id: 'step6666', cwd: projectDir }, snapshotEvents: () => [] }
    const rejected = { kind: 'reject', reason: 'user declined' }
    const decision = await runPreStep(harness, session, { decision: rejected })
    assert.equal(decision, rejected)
  })

  test('an empty claimed-message list passes straight through', async () => {
    const projectDir = tree.dir('TestProject')
    const harness = await buildHarness()
    await captureConsole(async () => apply(harness.ctx, undefined))
    const session = { header: { id: 'step7777', cwd: projectDir }, snapshotEvents: () => [] }
    const decision = await runPreStep(harness, session, { claimed: [], decision: { kind: 'continue', messages: [] } })
    assert.deepEqual(decision.messages, [])
  })

  test('a session without a cwd passes straight through', async () => {
    const harness = await buildHarness()
    await captureConsole(async () => apply(harness.ctx, undefined))
    const session = { header: { id: 'step8888' }, snapshotEvents: () => [] }
    const decision = await runPreStep(harness, session)
    assert.equal(decision.messages.length, 1)
  })
})
