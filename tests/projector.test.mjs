/**
 * Projection re-fold: the cut point, the re-read, and the degraded path.
 *
 * A title that reaches only the log stays invisible in the sidebar forever, because a
 * stored projection checkpoint is accepted on identity alone and never compared against the
 * log. These tests pin the three things that make the re-fold correct — and that it can
 * never take the pass down.
 *
 * @module dsh-aura/tests/projector.test
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { refoldSession } from '../lib/session/projector.js'

/**
 * A persistence handle stub.
 * @param {object} [options] - handle inputs.
 * @param {number} [options.inheritedEventCount] - the fork cut point reported by the handle.
 * @param {Array<any>} [options.before] - events returned by the first read.
 * @param {Array<any>} [options.after] - events returned by later reads.
 * @returns {object} the handle.
 */
function handleStub({ inheritedEventCount = 0, before = [], after = null } = {}) {
  let reads = 0
  return {
    header: { id: 'sess1111', cwd: 'X:/proj' },
    inheritedEventCount,
    get reads() {
      return reads
    },
    async read() {
      reads += 1
      if (reads === 1 || after === null) return { events: before }
      return { events: after }
    },
  }
}

describe('refoldSession', () => {
  test('does not settle a title before the cache exposes the folded value', async () => {
    const handle = handleStub({ before: [{ seq: 0, type: 'session/title', data: { title: 'Updated' } }] })
    const projectionCache = {
      coldSnapshot() { return { values: { title: 'Updated' } } },
      cachedSnapshot() { return { values: { title: 'Old' } } },
    }
    const outcome = await refoldSession({ handle, projectionCache })
    assert.equal(outcome.refolded, false)
    assert.equal(outcome.reason, 'cache-pending')
  })
  test('re-reads the log and folds with the handle cut point', async () => {
    const calls = []
    const handle = handleStub({
      inheritedEventCount: 12,
      before: [{ seq: 1 }, { seq: 2 }],
      after: [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
    })
    // The caller already read the log before appending the title; refoldSession must NOT
    // fold that stale snapshot together with the event it just wrote.
    await handle.read()
    const outcome = await refoldSession({
      handle,
      projectionCache: {
        coldSnapshot(header, inherited, events) {
          calls.push({ header, inherited, events })
        },
      },
    })
    assert.deepEqual(outcome, { refolded: true, events: 3 })
    assert.equal(handle.reads, 2, 'the fold must use a fresh re-read')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].inherited, 12, 'inheritedEventCount must come from the handle verbatim')
    assert.equal(calls[0].events.length, 3, 'the fold must use the RE-READ events, not the pre-append ones')
    assert.equal(calls[0].header, handle.header)
  })

  test('an inheritedEventCount of 0 on the handle stays 0 and is never invented', async () => {
    const calls = []
    await refoldSession({
      handle: handleStub({ inheritedEventCount: 0, before: [{ seq: 1 }] }),
      projectionCache: {
        coldSnapshot(header, inherited) {
          calls.push(inherited)
        },
      },
    })
    assert.deepEqual(calls, [0])
  })

  test('a non-numeric inheritedEventCount degrades to 0 instead of NaN', async () => {
    const calls = []
    await refoldSession({
      handle: handleStub({ inheritedEventCount: undefined, before: [{ seq: 1 }] }),
      projectionCache: {
        coldSnapshot(header, inherited) {
          calls.push(inherited)
        },
      },
    })
    assert.deepEqual(calls, [0])
  })

  test('a coldSnapshot throw is swallowed and reported, not propagated', async () => {
    const messages = []
    const outcome = await refoldSession({
      handle: handleStub({ before: [{ seq: 1 }] }),
      projectionCache: {
        coldSnapshot() {
          throw new Error('cache refused the record')
        },
      },
      log: (message) => messages.push(message),
    })
    assert.equal(outcome.refolded, false)
    assert.equal(outcome.reason, 'cache refused the record')
    assert.equal(messages.length, 1)
    assert.match(messages[0], /log stays authoritative/)
  })

  test('a read failure is swallowed too', async () => {
    const outcome = await refoldSession({
      handle: {
        header: { id: 'x' },
        inheritedEventCount: 0,
        async read() {
          throw new Error('disk gone')
        },
      },
      projectionCache: { coldSnapshot() {} },
    })
    assert.equal(outcome.refolded, false)
    assert.equal(outcome.reason, 'disk gone')
  })

  test('an empty log is not folded', async () => {
    const outcome = await refoldSession({
      handle: handleStub({ before: [] }),
      projectionCache: {
        coldSnapshot() {
          throw new Error('must not be called')
        },
      },
    })
    assert.equal(outcome.refolded, false)
    assert.equal(outcome.reason, 'empty-log')
  })

  test('a missing projectionCache is a clean no-op', async () => {
    const outcome = await refoldSession({ handle: handleStub({ before: [{ seq: 1 }] }), projectionCache: undefined })
    assert.equal(outcome.refolded, false)
    assert.equal(outcome.reason, 'no-projection-cache')
  })
})
