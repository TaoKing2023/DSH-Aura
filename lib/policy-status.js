/**
 * Host-side visibility for the policy state that decides what a session may touch.
 *
 * Two policy layers matter on this machine and neither is otherwise observable from
 * inside the DSH process:
 *
 *   1. the Aura router's **project gate** — only the authorized project directory may be written;
 *      any other project needs an explicit "允许修改 X" in the message;
 *   2. the router's **permission pools** — `full` (Agent, danger-full-access) and
 *      `ro` (Ask/Plan, read-only, MCP routed through the read-only proxy).
 *
 * Both live in the router process (`AuraChatTap.mjs`), which must outlive every DSH
 * session, so a plugin cannot read them from memory. The router does publish them on its
 * own `/health` endpoint; this module probes that endpoint (best-effort, short timeout)
 * and logs the answer in one line, together with the local facts the plugin does own.
 *
 * It is a diagnostic surface, never a control path: it never spawns the router, never
 * retries, never throws, and a router that is down only produces one explanatory line.
 *
 * @module dsh-aura/lib/policy-status
 */

import http from 'node:http'

/** Longest router body echoed into one log line. */
const MAX_BODY_CHARS = 1200

/**
 * HTTP GET a URL and return its body.
 *
 * `agent: false` matters: it gives the request a throwaway agent with keep-alive disabled,
 * so the socket is closed as soon as the response ends. A probe that left a pooled socket
 * behind would keep a handle on the DSH process (and on this module's callers) for every
 * poll — the probe is a diagnostic, and diagnostics must not hold resources.
 * @param {string} url - the absolute URL.
 * @param {number} timeoutMs - socket/response timeout.
 * @returns {Promise<{status: number, body: string}>} the response.
 */
function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      const target = new URL(url)
      if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
        reject(new Error('policy probe requires a loopback HTTP URL'))
        return
      }
    } catch {
      reject(new Error('policy probe URL is invalid'))
      return
    }
    let settled = false
    const done = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    let request
    try {
      request = http.get(url, { agent: false, headers: { connection: 'close' } }, (response) => {
        const chunks = []
        let total = 0
        const settle = () => done(resolve, { status: response.statusCode ?? 0, body: chunks.join('') })
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          chunks.push(chunk)
          total += chunk.length
          // Settle as soon as the answer is longer than anything useful, then drop the rest.
          // Waiting for 'end' here would let a chatty endpoint hold the probe open, and a
          // destroyed response does not reliably emit 'end'.
          if (total > MAX_BODY_CHARS * 4) {
            settle()
            response.destroy()
          }
        })
        response.on('end', settle)
        // 'close' is the only event guaranteed to fire for a destroyed, errored or ended
        // response, so it is the backstop that keeps this promise from staying pending.
        response.on('close', settle)
        response.on('error', (error) => done(reject, error))
      })
    } catch (error) {
      done(reject, error)
      return
    }
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`timeout after ${timeoutMs}ms`))
    })
    request.on('error', (error) => done(reject, error))
  })
}

/**
 * Pull the policy fields out of a router health payload without assuming its exact shape.
 *
 * The payload is externally owned; unknown and malformed bodies are counted, never copied
 * into logs, because they may contain credentials or unrelated local data.
 * @param {string} body - the raw response body.
 * @returns {object} a flat, log-safe summary.
 */
export function summarizeHealthBody(body) {
  const text = typeof body === 'string' ? body : ''
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { parseable: false, bodyLength: text.length }
  }
  if (parsed === null || typeof parsed !== 'object') return { parseable: true, bodyLength: text.length }
  const summary = { parseable: true }
  const select = (value, keys) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    return Object.fromEntries(keys.filter((key) => ['string', 'number', 'boolean'].includes(typeof value[key])).map((key) => [key, value[key]]))
  }
  if (typeof parsed.project === 'string') summary.project = parsed.project.slice(0, 240)
  if (typeof parsed.mode === 'string') summary.mode = parsed.mode.slice(0, 80)
  if (typeof parsed.model === 'string') summary.model = parsed.model.slice(0, 80)
  if (parsed.router) summary.router = select(parsed.router, ['port', 'pid'])
  if (parsed.supervisor) summary.supervisor = select(parsed.supervisor, ['task', 'running'])
  if (Array.isArray(parsed.pools)) summary.pools = parsed.pools.slice(0, 12).map((pool) => select(pool, ['name', 'pool', 'mode', 'sandbox', 'alive', 'generation', 'sessions']))
  const known = Object.keys(summary).length > 1
  if (!known) summary.bodyLength = text.length
  return summary
}

/**
 * Probe the router's policy state and log one line.
 *
 * Never rejects. `ueProjectDirs` are the local facts the plugin owns (which directories it
 * treated as Unreal projects), so the line pairs "what the router says" with "what this
 * process sees".
 * @param {object} options - probe inputs.
 * @param {string} options.url - the router health URL.
 * @param {number} options.timeoutMs - probe timeout.
 * @param {string[]} [options.ueProjectDirs] - UE project dirs seen by the last pass.
 * @param {(message: string) => void} options.log - logger.
 * @returns {Promise<object>} the report ({ok: false, reason} when the router is unreachable).
 */
export async function inspectPolicyStatus({ url, timeoutMs, ueProjectDirs = [], log }) {
  const local = { ueProjectDirs: ueProjectDirs.slice(0, 8) }
  try {
    const { status, body } = await httpGet(url, timeoutMs)
    const summary = summarizeHealthBody(body)
    const report = { ok: true, url, status, local, health: summary }
    log(`policy ${JSON.stringify(report)}`)
    return report
  } catch (error) {
    const reason = String(error && error.message ? error.message : error)
    const report = { ok: false, url, reason, local }
    // One line, stated as a degraded observation rather than an error: the router is an
    // external supervisor-owned process and the plugin must not try to bring it up.
    log(`policy ${JSON.stringify({ ...report, note: 'router unreachable - policy state unknown, this is not a plugin failure' })}`)
    return report
  }
}

/**
 * The local half of the policy report, usable without any network access.
 * @param {object} options - local facts.
 * @param {string} options.channel - `A` | `B` | `none` | `conflict`.
 * @param {boolean} options.injectionEnabled - whether prompt injection is on.
 * @param {string[]} [options.ueProjectDirs] - UE project dirs seen by the last pass.
 * @returns {object} the local policy facts.
 */
export function localPolicyFacts({ channel, injectionEnabled, ueProjectDirs = [] }) {
  return { channel, injectionEnabled, ueProjectDirs: ueProjectDirs.slice(0, 8) }
}
