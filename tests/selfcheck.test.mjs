/**
 * Self-check: sole owner, duplicate rows, and the honest "skipped" answer.
 *
 * The check exists because a silently doubled wiring is worse than a missing one: two
 * instances group every session twice and append two `session/title` events (the
 * `inspected` set is per process). When the loader is not reachable the check must say so —
 * "could not tell" is not "passed".
 *
 * @module dsh-aura/tests/selfcheck.test
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { channelFromEntries, resolveChannel, runSelfCheck } from '../lib/selfcheck.js'
import { ownedRowIds } from '../lib/mcp/rows.js'
import { createStubCtx, loaderEntries } from './helpers/stub-dsh.mjs'

/**
 * Run the self-check against a stubbed context.
 * @param {object} [options] - inputs.
 * @param {Array<any>|undefined} [options.entries] - loader entries (`undefined` = no loader service).
 * @param {object} [options.services] - extra services (e.g. a `tools` spy).
 * @param {string} [options.channel] - the channel to report.
 * @returns {{result: object, lines: string[]}} the conclusion and the log lines.
 */
function runCheck(options = {}) {
  const stub = createStubCtx({ services: options.services, entries: options.entries })
  const lines = []
  const result = runSelfCheck(stub.ctx, (line) => lines.push(line), { channel: options.channel ?? 'A' })
  return { result, lines }
}

describe('runSelfCheck', () => {
  test('sole owner with all four rows mounted', () => {
    const { result, lines } = runCheck({ entries: loaderEntries({ channel: 'A' }) })
    assert.equal(result.owner, 'sole')
    assert.deepEqual(result.legacy, [])
    assert.deepEqual(result.duplicates, [])
    assert.equal(lines.length, 1)
    assert.match(lines[0], /selfcheck owner=sole channel=A loader=ok rows=4\/4 tools=absent/)
  })

  test('reports a duplicate owner and NAMES the offending row', () => {
    const entries = loaderEntries({
      channel: 'A',
      extra: [{ id: 'aura-workspace-sync', name: 'D:/work/Aura/AuraWorkspaceSync.plugin.mjs' }],
    })
    const { result, lines } = runCheck({ entries })
    assert.equal(result.owner, 'duplicate')
    assert.deepEqual(result.legacy, ['D:/work/Aura/AuraWorkspaceSync.plugin.mjs'])
    assert.match(lines[0], /selfcheck owner=DUPLICATE/)
    assert.match(lines[0], /aura-workspace-sync|AuraWorkspaceSync/, 'the conflicting row must be named, not just counted')
  })

  test('reports a duplicated row id by name', () => {
    const entries = loaderEntries({ channel: 'A', extra: [{ id: 'mcp-unreal-engine', name: '@deepseek-ai/dsh-mcp-client' }] })
    const { result, lines } = runCheck({ entries })
    assert.equal(result.owner, 'sole')
    assert.deepEqual(result.duplicates, ['mcp-unreal-engine'])
    assert.match(lines[0], /row id duplicated: mcp-unreal-engine/)
  })

  test('a missing loader service is "skipped", never "passed"', () => {
    const { result, lines } = runCheck({ entries: undefined })
    assert.equal(result.owner, 'unreachable')
    assert.match(lines[0], /selfcheck skipped: loader service not reachable from here/)
    assert.doesNotMatch(lines[0], /owner=sole/)
  })

  test('a loader whose entries() is not iterable is skipped too', () => {
    const stub = createStubCtx({ services: { loader: { entries: () => 42 } } })
    const lines = []
    const result = runSelfCheck(stub.ctx, (line) => lines.push(line))
    assert.equal(result.owner, 'unreachable')
    assert.match(lines[0], /skipped/)
  })

  test('a throwing loader is skipped, not fatal', () => {
    const stub = createStubCtx({
      services: {
        loader: {
          entries() {
            throw new Error('loader exploded')
          },
        },
      },
    })
    const lines = []
    const result = runSelfCheck(stub.ctx, (line) => lines.push(line))
    assert.equal(result.owner, 'unreachable')
    assert.match(lines[0], /loader exploded/)
  })

  test('the tools service is reported as present-but-unused when it exists', () => {
    const { result, lines } = runCheck({
      entries: loaderEntries({ channel: 'B' }),
      services: {
        tools: {
          register() {
            throw new Error('the plugin must never register a tool')
          },
        },
      },
      channel: 'B',
    })
    assert.equal(result.tools, 'present-not-used')
    assert.match(lines[0], /channel=B/)
    assert.match(lines[0], /tools=present-not-used/)
  })

  test('an owner with no rows at all reports rows=0/4', () => {
    const { lines } = runCheck({ entries: [] })
    assert.match(lines[0], /rows=0\/4/)
  })

  test('a partially mounted owner reports the real count (3/4 here)', () => {
    const { lines } = runCheck({ entries: loaderEntries({ channel: 'none' }) })
    assert.match(lines[0], /rows=3\/4/)
  })
})

describe('channelFromEntries', () => {
  test('a file:// row is Channel A, a bare name is Channel B', () => {
    const a = createStubCtx({ entries: loaderEntries({ channel: 'A' }) })
    const b = createStubCtx({ entries: loaderEntries({ channel: 'B' }) })
    assert.equal(channelFromEntries(a.ctx), 'A')
    assert.equal(channelFromEntries(b.ctx), 'B')
  })

  test('no row at all is "none"', () => {
    const stub = createStubCtx({ entries: loaderEntries({ channel: 'none' }) })
    assert.equal(channelFromEntries(stub.ctx), 'none')
  })

  test('both shapes at once is a conflict', () => {
    const stub = createStubCtx({
      entries: [
        ...loaderEntries({ channel: 'A' }),
        { id: 'dsh-aura', options: { id: 'dsh-aura', name: 'dsh-aura' } },
      ],
    })
    assert.equal(channelFromEntries(stub.ctx), 'conflict')
  })

  test('no loader service is "unknown" (not "none")', () => {
    const stub = createStubCtx()
    assert.equal(channelFromEntries(stub.ctx), 'unknown')
  })
})

describe('resolveChannel', () => {
  test('covers all four combinations', () => {
    assert.equal(resolveChannel({ inBundleList: false, inProfilePatch: true }), 'A')
    assert.equal(resolveChannel({ inBundleList: true, inProfilePatch: false }), 'B')
    assert.equal(resolveChannel({ inBundleList: false, inProfilePatch: false }), 'none')
    assert.equal(resolveChannel({ inBundleList: true, inProfilePatch: true }), 'conflict')
  })
})

describe('ownedRowIds', () => {
  test('is the four ids the guard protects', () => {
    assert.deepEqual(ownedRowIds(), ['dsh-aura', 'mcp-aura-unreal-inspector', 'mcp-aura-unreal-editor', 'mcp-unreal-engine'])
  })
})
