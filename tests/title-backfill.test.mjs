/**
 * Title backfill fixtures: preamble stripping, tidying, the decision table, and the exact
 * shape of the appended `session/title` event.
 *
 * The decision table is a requirement fixture, not an implementation snapshot: every row is
 * a case the wiring must handle, including the one that protects user-set titles.
 *
 * @module dsh-aura/tests/title-backfill.test
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  decideTitle,
  inspectLog,
  isRouterTitle,
  ROUTER_PREFIX,
  stripRouterPreamble,
  tidyTitle,
  titleEvent,
} from '../lib/session/title-backfill.js'

describe('stripRouterPreamble', () => {
  test('drops leading router blocks (the historical shape)', () => {
    const text = '[router] 现在是 Ask 模式：只读\n\n[router] 只回答问题，不要改文件\n\n加一个血条'
    assert.equal(stripRouterPreamble(text), '加一个血条')
  })

  test('drops trailing router blocks (the current shape)', () => {
    const text = '加一个血条\n\n[router] 现在是 Agent 模式'
    assert.equal(stripRouterPreamble(text), '加一个血条')
  })

  test('drops mixed blocks and keeps everything else in order', () => {
    const text = '[router] a\n\n用户第一段\n\n[router] b\n\n用户第二段'
    assert.equal(stripRouterPreamble(text), '用户第一段\n\n用户第二段')
  })

  test('an all-rules message strips to empty, so the session is left alone', () => {
    // This assertion used to be the opposite ("keeps the original text ... must not become an
    // empty title"), and THAT is what made `decideTitle` rename a session to the rule text.
    // Returning '' makes the decision `empty`, which writes nothing at all -- the safe
    // outcome. Do not confuse it with writing an empty title, which never happens.
    assert.equal(stripRouterPreamble('[router] only rules here'), '')
  })

  test('a rule and a question in ONE block (no blank line) still yields the question', () => {
    // The old router shipped `[router] <rule>\n<question>` with no blank line, so the block
    // filter saw one block and kept the whole thing.
    assert.equal(stripRouterPreamble('[router] 现在是 Ask 模式：只读\n把血条加上'), '把血条加上')
    assert.equal(stripRouterPreamble('[router] a\n[router] b\n真实的提问'), '真实的提问')
  })

  test('is a no-op without the marker, and tolerates empty input', () => {
    assert.equal(stripRouterPreamble('普通提问'), '普通提问')
    assert.equal(stripRouterPreamble(''), '')
    assert.equal(stripRouterPreamble(undefined), '')
  })

  test('a block that merely STARTS with the word router is not treated as one', () => {
    const text = 'router 配置怎么改？\n\n第二段'
    assert.equal(stripRouterPreamble(text), text)
  })
})

describe('tidyTitle', () => {
  test('flattens whitespace and clips to the character budget', () => {
    assert.equal(tidyTitle('  a\n\nb\t c  '), 'a b c')
    assert.equal(Array.from(tidyTitle('x'.repeat(80))).length, 60)
    assert.equal(Array.from(tidyTitle('x'.repeat(80), 10)).length, 10)
  })

  test('clips by code point, not by UTF-16 unit (CJK and emoji safe)', () => {
    const text = '汉字'.repeat(40)
    const clipped = tidyTitle(text, 3)
    assert.equal(Array.from(clipped).length, 3)
    assert.equal(clipped, '汉字汉')
    assert.equal(Array.from(tidyTitle('🙂🙂🙂🙂', 2)).length, 2)
  })

  test('an invalid budget falls back to the default', () => {
    assert.equal(Array.from(tidyTitle('x'.repeat(100), 0)).length, 60)
    assert.equal(Array.from(tidyTitle('x'.repeat(100), Number.NaN)).length, 60)
  })
})

describe('isRouterTitle', () => {
  test('only the router prefix qualifies', () => {
    assert.equal(isRouterTitle('[router] x'), true)
    assert.equal(isRouterTitle('功能|主题|0919'), false)
    assert.equal(isRouterTitle(''), false)
    assert.equal(isRouterTitle(undefined), false)
    assert.equal(ROUTER_PREFIX, '[router]')
  })
})

describe('inspectLog', () => {
  test('collects the last title, the first human message, the max seq and the turn count', () => {
    const events = [
      { type: 'session/title', seq: 1, data: { title: '[router] old' } },
      { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '[router] r\n\n问题一' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 3, data: {} },
      { type: 'user/message', seq: 4, data: { content: [{ type: 'text', text: '问题二' }], source: { kind: 'user' } } },
      { type: 'session/title', seq: 5, data: { title: '[router] newer' } },
      { type: 'user/message', seq: 6, data: { content: [{ type: 'text', text: 'not human' }], source: { kind: 'plugin', plugin: 'x' } } },
    ]
    const facts = inspectLog(events)
    assert.equal(facts.title, '[router] newer')
    assert.equal(facts.first, '[router] r\n\n问题一')
    assert.equal(facts.lastSeq, 6)
    assert.equal(facts.turns, 2, 'only source.kind === "user" messages count as turns')
  })

  test('non-text parts are ignored and an empty log yields nothing', () => {
    const events = [
      { type: 'user/message', seq: 1, data: { content: [{ type: 'image' }, { type: 'text', text: 'oops' }], source: { kind: 'user' } } },
    ]
    assert.equal(inspectLog(events).first, 'oops')
    assert.equal(inspectLog([]).lastSeq, -1)
    assert.equal(inspectLog([]).title, '')
    assert.equal(inspectLog(undefined).turns, 0)
  })
})

describe('decideTitle', () => {
  const cases = [
    { name: 'router title + human question -> rewrite', facts: { title: '[router] x', first: '[router] r\n\n加个血条', lastSeq: 5 }, kind: 'title', title: '加个血条' },
    { name: 'user-set title -> keep', facts: { title: '功能|加个血条|0919', first: '加个血条', lastSeq: 5 }, kind: 'keep' },
    { name: 'empty title -> keep (nothing to fix)', facts: { title: '', first: '加个血条', lastSeq: 5 }, kind: 'keep' },
    // Was `kind: 'title', title: '[router] rules only'` -- it EXPECTED the session to be renamed
    // to the rule text. An all-rules message carries no question, so nothing may be written.
    { name: 'router title whose user text was entirely a rule -> empty', facts: { title: '[router] x', first: '[router] rules only', lastSeq: 5 }, kind: 'empty' },
    { name: 'router title with no events at all -> empty', facts: { title: '[router] x', first: '', lastSeq: -1 }, kind: 'empty' },
    { name: 'router title whose only user text is blank -> empty', facts: { title: '[router] x', first: '   \n  ', lastSeq: 3 }, kind: 'empty' },
    // Measured 2026-09-20 (adversarial review AURA-06). Each of these used to produce a bad
    // title; the first two also made the pass append an identical event forever.
    { name: "Aura's empty input '(empty)' is a placeholder, not a question", facts: { title: '[router] x', first: '(empty)\n\n[router] 现在是 Ask 模式：只读', lastSeq: 9 }, kind: 'empty' },
    { name: 'FIXPOINT: a question identical to the current title writes nothing', facts: { title: '[router] X', first: '[router] X', lastSeq: 5 }, kind: 'empty' },
    { name: 'rule then question in one block -> the question', facts: { title: '[router] x', first: '[router] 你确定吗\n不对，重来', lastSeq: 4 }, kind: 'title', title: '不对，重来' },
  ]
  for (const entry of cases) {
    test(entry.name, () => {
      const decision = decideTitle(entry.facts, 60)
      assert.equal(decision.kind, entry.kind)
      if (entry.title !== undefined) assert.equal(decision.title, entry.title)
    })
  }

  test('the rewrite is clipped to the configured budget', () => {
    const decision = decideTitle({ title: '[router] x', first: '一'.repeat(100), lastSeq: 1 }, 10)
    assert.equal(Array.from(decision.title).length, 10)
  })
})

describe('titleEvent', () => {
  test('matches the shape the product itself writes on rename', () => {
    const event = titleEvent('加个血条', 5, 1700000000000)
    assert.deepEqual(event, {
      type: 'session/title',
      seq: 6,
      time: 1700000000000,
      data: { title: '加个血条', messageSeqs: [], source: { kind: 'user' } },
    })
    assert.equal(event.data.source.kind, 'user', 'a plugin-sourced title would not be accepted as a user rename')
  })
})
