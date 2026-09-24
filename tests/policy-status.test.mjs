/**
 * Host-side policy visibility: the router health probe and its degraded path.
 *
 * The project gate ("only the authorized project directory may be written") and the permission
 * pools (`full` / `ro`) live in the router process, which must outlive every DSH session, so
 * a plugin cannot read them from memory. The router publishes them on `/health`; this module
 * probes that endpoint and logs one line. The tests below use a throwaway local HTTP server
 * so the probe is exercised for real — including the unreachable case, which must degrade
 * into one explanatory line rather than a failure.
 *
 * @module dsh-aura/tests/policy-status.test
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, describe, test } from 'node:test'

import { inspectPolicyStatus, localPolicyFacts, summarizeHealthBody } from '../lib/policy-status.js'

/** The router's health payload shape, as documented by `Test-AuraReady.ps1`. */
const HEALTH = {
  router: { port: 41777, pid: 1234 },
  supervisor: { task: 'AuraChatTap', running: true },
  project: 'E:/Unreal_Projects/Test',
  pools: [
    { name: 'full', mode: 'Agent', sandbox: 'danger-full-access' },
    { name: 'ro', mode: 'Ask|Plan', sandbox: 'read-only' },
  ],
  model: 'DeepSeek Harness',
}

/** Servers started by this file, stopped afterwards. */
const servers = []
after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections?.()
          server.close(resolve)
        }),
    ),
  )
})

/**
 * Start a throwaway HTTP server.
 * @param {(request: http.IncomingMessage, response: http.ServerResponse) => void} handler - request handler.
 * @returns {Promise<{url: string, port: number}>} the server address.
 */
async function startServer(handler) {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}/health`, port }
}

describe('summarizeHealthBody', () => {
  test('extracts the policy fields it knows', () => {
    const summary = summarizeHealthBody(JSON.stringify(HEALTH))
    assert.equal(summary.parseable, true)
    assert.deepEqual(summary.pools, HEALTH.pools)
    assert.equal(summary.project, 'E:/Unreal_Projects/Test')
    assert.equal(summary.supervisor.running, true)
    assert.equal(summary.router.port, 41777)
  })

  test('does not log an unrecognised payload', () => {
    const summary = summarizeHealthBody(JSON.stringify({ somethingNew: 'v2', detail: 'x'.repeat(5000) }))
    assert.equal(summary.parseable, true)
    assert.equal(typeof summary.bodyLength, 'number')
    assert.equal(summary.body, undefined)
  })

  test('does not copy conversations nested inside a pool', () => {
    const summary = summarizeHealthBody(JSON.stringify({ pools: [{ pool: 'ro', conversations: [{ sessionId: 'private-session', cwd: 'C:/private' }] }] }))
    assert.deepEqual(summary.pools, [{ pool: 'ro' }])
    assert.equal(JSON.stringify(summary).includes('private-session'), false)
  })

  test('a non-JSON body is reported without its contents', () => {
    const summary = summarizeHealthBody('<html>not json</html>')
    assert.equal(summary.parseable, false)
    assert.equal(summary.bodyLength, '<html>not json</html>'.length)
    assert.equal(summary.body, undefined)
  })

  test('a JSON scalar is counted, not copied', () => {
    assert.equal(summarizeHealthBody('42').bodyLength, 2)
    assert.equal(summarizeHealthBody('').parseable, false)
  })
})

describe('inspectPolicyStatus', () => {
  test('logs the project gate and the permission pools when the router answers', async () => {
    const { url } = await startServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(HEALTH))
    })
    const lines = []
    const report = await inspectPolicyStatus({ url, timeoutMs: 2000, ueProjectDirs: ['E:/Unreal_Projects/Test'], log: (line) => lines.push(line) })
    assert.equal(report.ok, true)
    assert.equal(report.status, 200)
    assert.equal(report.health.project, 'E:/Unreal_Projects/Test')
    assert.deepEqual(report.local.ueProjectDirs, ['E:/Unreal_Projects/Test'])
    assert.equal(lines.length, 1)
    assert.ok(lines[0].includes('"project":"E:/Unreal_Projects/Test"'), 'the gate value must appear in the log line')
    assert.ok(lines[0].includes('"name":"ro"'), 'the pools must appear in the log line')
  })

  test('an unreachable router degrades to one explanatory line and never throws', async () => {
    // Port 1 is reserved and never listening.
    const lines = []
    const report = await inspectPolicyStatus({ url: 'http://127.0.0.1:1/health', timeoutMs: 500, ueProjectDirs: [], log: (line) => lines.push(line) })
    assert.equal(report.ok, false)
    assert.equal(typeof report.reason, 'string')
    assert.equal(lines.length, 1)
    assert.ok(lines[0].includes('router unreachable'))
    assert.ok(lines[0].includes('not a plugin failure'), 'the message must not read as an error the plugin owns')
  })

  test('a non-JSON answer is still reported as reachable', async () => {
    const { url } = await startServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
    })
    const report = await inspectPolicyStatus({ url, timeoutMs: 2000, log: () => {} })
    assert.equal(report.ok, true)
    assert.equal(report.health.parseable, false)
  })

  test('a large answer does not blow up the log line', async () => {
    const { url } = await startServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ project: 'x', pools: [], filler: 'y'.repeat(200000) }))
    })
    const lines = []
    const report = await inspectPolicyStatus({ url, timeoutMs: 4000, log: (line) => lines.push(line) })
    assert.equal(report.ok, true)
    assert.ok(lines[0].length < 4000, `log line too long: ${lines[0].length}`)
  })
})

describe('localPolicyFacts', () => {
  test('reports the local half and caps the directory list', () => {
    const facts = localPolicyFacts({ channel: 'A', injectionEnabled: true, ueProjectDirs: Array.from({ length: 20 }, (_, i) => `d${i}`) })
    assert.equal(facts.channel, 'A')
    assert.equal(facts.injectionEnabled, true)
    assert.equal(facts.ueProjectDirs.length, 8)
  })
})
