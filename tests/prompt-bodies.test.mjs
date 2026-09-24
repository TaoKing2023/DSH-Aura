/**
 * Prompt bodies and the injection text.
 *
 * The bodies are a distillation of two external `AGENTS.md` files, so the check is that
 * every rule CATEGORY survived — the markers below are the contract with the source files,
 * not a snapshot of the wording. A second check guards design R4b: the injected text must
 * never contain a `[router]` marker, because that prefix is what the title backfill strips
 * and a false one would corrupt the summary path.
 *
 * @module dsh-aura/tests/prompt-bodies.test
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { AURA_WORKSPACE_BODY, AURA_WORKSPACE_MARKERS } from '../lib/prompt/bodies/aura-workspace.js'
import { UE_WORKSPACE_BODY, UE_WORKSPACE_MARKERS } from '../lib/prompt/bodies/ue-workspace.js'
import {
  FOREIGN_INSTRUCTION_SOURCE_PLUGINS,
  INJECTION_SOURCE_PLUGIN,
  injectionText,
  REMINDER_CLOSE,
  REMINDER_OPEN,
} from '../lib/prompt/inject.js'

describe('UE workspace body', () => {
  test('covers every rule category of the source file', () => {
    for (const marker of UE_WORKSPACE_MARKERS) {
      assert.ok(UE_WORKSPACE_BODY.includes(marker), `the UE body lost the "${marker}" category`)
    }
  })

  test('names the five areas the contract requires', () => {
    assert.ok(UE_WORKSPACE_BODY.includes('交付物 = 结果 + 简短规范'), 'deliverable shape')
    assert.ok(UE_WORKSPACE_BODY.includes('≤3 行'), 'the 3-line spec budget')
    assert.ok(UE_WORKSPACE_BODY.includes('动手前先备份'), 'pre-flight backup')
    assert.ok(UE_WORKSPACE_BODY.includes('按任务选对工具'), 'per-task tool choice')
    assert.ok(UE_WORKSPACE_BODY.includes('先加载技能'), 'skill first')
    assert.ok(UE_WORKSPACE_BODY.includes('写注释 / 文档的风格'), 'documentation style')
  })

  test('carries the UE 5.8 findings and the anti-self-limitation rule', () => {
    assert.ok(UE_WORKSPACE_BODY.includes('BlueprintEditorLibrary'))
    assert.ok(UE_WORKSPACE_BODY.includes('KismetEditorUtilities'))
    assert.ok(UE_WORKSPACE_BODY.includes('我是只读模式'), 'the "do not invent a read-only limit" rule must survive')
  })
})

describe('Aura workspace body', () => {
  test('covers every rule category of the source file', () => {
    for (const marker of AURA_WORKSPACE_MARKERS) {
      assert.ok(AURA_WORKSPACE_BODY.includes(marker), `the Aura body lost the "${marker}" category`)
    }
  })

  test('keeps the "never delete a backup" hard rules', () => {
    // Assert the RULE, not one phrasing of it. This used to pin the exact sentence
    // "`-Prune -Apply` 不要跑", which broke the moment the wording was generalised to cover
    // every destructive mode -- and the generalisation is the better rule. What must survive
    // is: never delete a backup, and name at least one concrete destructive operation to avoid.
    assert.ok(AURA_WORKSPACE_BODY.includes('不要删除任何备份'), 'the never-delete rule is the point of this body')
    assert.match(AURA_WORKSPACE_BODY, /任何\*\*会删除备份\*\*的命令或脚本模式都不要运行/, 'the rule must be stated as a class, not one command')
    assert.ok(AURA_WORKSPACE_BODY.includes('Remove-Item -Recurse'), 'at least one concrete destructive operation must be named')
    assert.ok(AURA_WORKSPACE_BODY.includes('不要删备份目录本身'), 'the directory itself is protected too')
  })
})

describe('injectionText', () => {
  test('frames both sections in one system-reminder, UE rules first', () => {
    const text = injectionText()
    assert.ok(text.startsWith(REMINDER_OPEN))
    assert.ok(text.trimEnd().endsWith(REMINDER_CLOSE))
    assert.ok(text.includes(UE_WORKSPACE_BODY))
    assert.ok(text.includes(AURA_WORKSPACE_BODY))
    assert.ok(text.indexOf(UE_WORKSPACE_BODY) < text.indexOf(AURA_WORKSPACE_BODY), 'the order inside one message must be deterministic')
  })

  test('never contains a [router] marker (design R4b)', () => {
    assert.equal(injectionText().includes('[router]'), false)
  })
})

describe('injection identity', () => {
  test('is this package, and never one of the title plugin names', () => {
    assert.equal(INJECTION_SOURCE_PLUGIN, 'dsh-aura')
    assert.equal(FOREIGN_INSTRUCTION_SOURCE_PLUGINS.includes(INJECTION_SOURCE_PLUGIN), false, 'reusing a title plugin name would silently suppress its own injection')
  })
})
