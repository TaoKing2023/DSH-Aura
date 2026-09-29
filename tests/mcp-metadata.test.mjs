import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { MCP_ENTRY_NAMES, SERVER_NAMES } from '../lib/mcp/rows.js'

function readExportedJson(specifier) {
  return JSON.parse(readFileSync(fileURLToPath(import.meta.resolve(specifier)), 'utf8'))
}

test('each MCP row exposes distinct DSH display metadata', () => {
  const descriptions = new Set()
  for (const serverName of SERVER_NAMES) {
    const entry = MCP_ENTRY_NAMES[serverName]
    const manifest = readExportedJson(`${entry}/package.json`)
    const english = readExportedJson(`${entry}/locale/en.json`)
    const chinese = readExportedJson(`${entry}/locale/zh.json`)
    assert.ok(manifest.description)
    assert.ok(english.meta.title)
    assert.ok(english.meta.description)
    assert.ok(chinese.meta.description)
    descriptions.add(english.meta.description)
  }
  assert.equal(descriptions.size, SERVER_NAMES.length)
})

test('named row entry preserves upstream MCP client exports', async () => {
  const upstream = await import('@deepseek-ai/dsh-mcp-client')
  for (const serverName of SERVER_NAMES) {
    const entry = await import(MCP_ENTRY_NAMES[serverName])
    for (const name of ['Config', 'apply', 'inject', 'name']) {
      assert.equal(entry[name], upstream[name], `${serverName} changed ${name}`)
    }
  }
})

test('the DSH 0.2 MCP bridge executes a tool and projects its response content', async () => {
  const { createMcpToolDefinition } = await import('@deepseek-ai/dsh-mcp-client')
  const attachment = { id: 'test-image' }
  const ctx = {
    get(service) {
      if (service === 'attachments') return { saveImages: async () => [attachment] }
      if (service === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['image'] }) }
      return undefined
    },
  }
  let calls = 0
  const definition = createMcpToolDefinition(ctx, {
    name: 'mcp__aura__preview',
    rawName: 'preview',
    description: 'Preview the current scene',
    inputSchema: { type: 'object', properties: {} },
    call: async () => {
      calls += 1
      return {
        content: [
          { type: 'text', text: 'scene ready' },
          { type: 'image', mimeType: 'image/png', data: 'AQ==' },
        ],
      }
    },
  })
  const exec = {
    signal: new AbortController().signal,
    agent: {
      session: { requestHeader: () => ({ config: { provider: 'test', model: 'vision' } }) },
      options: {},
    },
  }

  const value = await definition.execute({}, exec)
  const fallback = definition.output.render({}, value)
  const content = definition.projectContent(exec, { value, content: fallback, isError: false })
  assert.equal(calls, 1)
  assert.deepEqual(content, [{ type: 'text', text: 'scene ready' }, { type: 'image', attachment }])
})
