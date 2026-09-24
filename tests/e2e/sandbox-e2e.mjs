/**
 * Sandbox E2E for the foreign-session title fix.
 *
 * THE CASE: Aura runs its conversations in its OWN DSH host (`dsh --profile acp`, started by
 * AuraChatTap). That host holds the session's cross-process write lease for as long as the
 * Aura tab is open, and the Web GUI is a different host whose projection cache was
 * snapshotted at boot. Result before the fix: the session was attached to the right
 * workspace, but its sidebar row rendered as the bare directory name (`Test`) because a cold
 * row's title is served only from `sessionProjectionCache.cachedSnapshot(header)`.
 *
 * WHAT THIS PROVES, ON REAL HOSTS: with two hosts sharing one state root, the host that
 * cannot write the session still ends up able to SHOW it.
 *
 * ISOLATION: nothing here touches the live `~/.dsh`. Every profile, state root, log and
 * session log is created under a throwaway `DSH_HOME` in the OS temp dir; the live home is
 * read only, and only for the DSH install and the shared `profiles/node_modules`.
 *
 * ROUNDS:
 *   --round=old   the plugin as currently PACKED in the sandbox profile (pre-fix code)
 *   --round=new   the plugin as it exists in this working tree (the fix)
 *
 * Usage:
 *   node audit/2026-09-20/foreign-session-title/sandbox-e2e.mjs --round=old
 *   node audit/2026-09-20/foreign-session-title/sandbox-e2e.mjs --round=new
 *
 * @module dsh-aura/audit/foreign-session-title-sandbox-e2e
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const evidenceRoot = path.join(root, 'audit', new Date().toISOString().slice(0, 10), 'remediation')
fs.mkdirSync(evidenceRoot, { recursive: true })
const here = fs.mkdtempSync(path.join(evidenceRoot, 'e2e-'))
const flags = new Map(
  process.argv.slice(2).map((raw) => {
    const [key, value = 'true'] = raw.replace(/^--/, '').split('=')
    return [key, value]
  }),
)

const ROUND = flags.get('round') ?? 'new'
const PORT_A = Number(flags.get('portA') ?? (ROUND === 'old' ? 3091 : 3093))
const PORT_B = Number(flags.get('portB') ?? (ROUND === 'old' ? 3092 : 3094))
let UE_PROJECT = flags.get('project')
const SESSION_ID = flags.get('session') ?? `session-e2e-${ROUND}-title`
const TITLE = flags.get('title') ?? `沙盒守卫-${ROUND}`
const KEEP = flags.get('keep') === 'true'

/** The live DSH install and the candidate plugin builds. Read-only inputs. */
const LIVE_HOME = process.env.DSH_HOME_LIVE ?? path.join(os.homedir(), '.dsh')
const DSH_BIN = [
  path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  path.join(path.dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
].find((candidate) => fs.existsSync(candidate))
if (DSH_BIN === undefined) throw new Error('could not locate the installed dsh entry point (lib/bin.js)')
const SHARED_NODE_MODULES = path.join(LIVE_HOME, 'profiles', 'node_modules')
/** The pre-fix build, as packed into the live sandbox profile. Resolved only for `--round=old`. */
let packedPluginCache
/** @returns {string} the packed pre-fix plugin directory. */
function oldPlugin() {
  packedPluginCache ??= findPackedPlugin()
  return packedPluginCache
}

/** Result record, written next to this script as run-<round>.json. */
const evidence = {
  round: ROUND,
  startedAt: new Date().toISOString(),
  ports: { holder: PORT_A, observer: PORT_B },
  ueProject: UE_PROJECT,
  sessionId: SESSION_ID,
  title: TITLE,
  pluginSource: null,
  steps: [],
  verdict: null,
}

const children = []

/**
 * Locate the plugin copy packed into the live sandbox profile (the pre-fix build).
 * @returns {string} the packed plugin directory.
 */
function findPackedPlugin() {
  const store = path.join(LIVE_HOME, 'profiles', 'aura-sandbox', 'node_modules', '.pnpm')
  const entry = fs
    .readdirSync(store, { withFileTypes: true })
    .filter((item) => item.isDirectory() && item.name.startsWith('dsh-aura@'))
    .map((item) => path.join(store, item.name, 'node_modules', 'dsh-aura'))
    .filter((candidate) => fs.existsSync(path.join(candidate, 'index.js')))
    .sort()
    .at(-1)
  if (entry === undefined) throw new Error(`no packed dsh-aura found under ${store}`)
  return entry
}

/**
 * Record one step.
 * @param {string} name - the step name.
 * @param {object} detail - JSON-able detail.
 * @returns {void}
 */
function step(name, detail) {
  evidence.steps.push({ name, at: new Date().toISOString(), ...detail })
  console.log(`[${name}] ${JSON.stringify(detail)}`)
}

/**
 * Build the throwaway DSH home: two profiles over ONE shared state root.
 *
 * The roles mirror production exactly. The HOLDER profile (the "Aura side") mounts no
 * dsh-aura at all — Aura's own host runs the `acp` profile, which has never had this plugin —
 * so any title the observer ends up showing had to be produced by the observer's build.
 * @returns {object} paths.
 */
function buildSandboxHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-aura-e2e-${ROUND}-`))
  if (!UE_PROJECT) {
    UE_PROJECT = path.join(home, 'UnrealProject')
    fs.mkdirSync(UE_PROJECT)
    if (flags.get('negative') !== 'true') fs.writeFileSync(path.join(UE_PROJECT, 'Sandbox.uproject'), '{}\n')
  }
  evidence.ueProject = UE_PROJECT
  const profiles = path.join(home, 'profiles')
  const state = path.join(home, `state-${ROUND}`)
  fs.mkdirSync(profiles, { recursive: true })
  fs.mkdirSync(path.join(state, 'sessions'), { recursive: true })
  fs.mkdirSync(path.join(state, 'storages'), { recursive: true })

  // The shared harness packages (`@deepseek-ai/dsh-base`, `dsh-web-app`, ...) resolve
  // through the profiles-level node_modules, exactly as a real profile does.
  fs.symlinkSync(SHARED_NODE_MODULES, path.join(profiles, 'node_modules'), 'junction')

  const pluginSource = flags.get('plugin') ? path.resolve(flags.get('plugin')) : ROUND === 'old' ? oldPlugin() : root
  for (const role of ['holder', 'observer']) {
    const profile = path.join(profiles, `e2e-${ROUND}-${role}`)
    fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
    const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
    const dependencies = {}
    if (role === 'observer') {
      bundles.push('dsh-aura')
      dependencies['dsh-aura'] = pluginSource
      fs.symlinkSync(pluginSource, path.join(profile, 'node_modules', 'dsh-aura'), 'junction')
    }
    fs.writeFileSync(
      path.join(profile, 'package.json'),
      `${JSON.stringify(
        { name: `dsh-profile-e2e-${ROUND}-${role}`, private: true, dsh: { profile: { bundles, patchReload: 'live' } }, dependencies },
        null,
        2,
      )}\n`,
    )
    fs.writeFileSync(path.join(profile, 'cordis.yml'), '# composed from bundles + patch files\n[]\n')
    // Same isolation the live `aura-sandbox` profile declares, rooted in this throwaway home.
    fs.writeFileSync(
      path.join(profile, 'cordis.patch.yml'),
      [
        '# e2e isolation: this profile must not touch any other root.',
        ...(role === 'observer' ? [
          '- id: mcp-aura-unreal-inspector', '  disabled: true',
          '- id: mcp-aura-unreal-editor', '  disabled: true',
          '- id: mcp-unreal-engine', '  disabled: true',
          '- id: dsh-aura', '  config:', '    policyProbeEnabled: false', '    initialDelayMs: 10000',
        ] : []),
        '- id: session-persistence-jsonl',
        '  config:',
        `    root: ${JSON.stringify(toPosix(path.join(state, 'sessions')))}`,
        '- id: storage-json',
        '  config:',
        `    root: ${JSON.stringify(toPosix(path.join(state, 'storages')))}`,
        '- id: settings',
        '  config:',
        `    path: ${JSON.stringify(toPosix(path.join(state, 'settings.yaml')))}`,
        '',
      ].join('\n'),
    )
  }
  return {
    home,
    state,
    holderProfile: `e2e-${ROUND}-holder`,
    observerProfile: `e2e-${ROUND}-observer`,
    pluginSource,
  }
}

/** @param {string} value - a path. @returns {string} the same path with forward slashes. */
function toPosix(value) {
  return value.replaceAll('\\', '/')
}

/**
 * Boot one real `dsh web` host and wait for its authenticated URL.
 * @param {object} options - boot inputs.
 * @param {string} options.home - the throwaway DSH home.
 * @param {string} options.profile - the profile name.
 * @param {number} options.port - the listen port.
 * @param {string} options.logFile - where the host's stdout goes.
 * @returns {Promise<{proc: object, token: string, base: string, cookie: string}>} the host.
 */
async function bootHost({ home, profile, port, logFile }) {
  // `dsh --profile <name> [app flags]`: the profile selects the app, so `web` is NOT a
  // positional here (passing it makes the web app reject it as a stray argument).
  const proc = spawn(process.execPath, [DSH_BIN, '--profile', profile, '--no-open', '--port', String(port)], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(proc)
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 90_000
  let token = null
  // Parse the one-time login token in memory, and redact it before any host output is saved.
  // A direct stdout-to-file redirect used to leave a working login URL in audit logs.
  const capture = (stream) => {
    let pending = ''
    const save = (line) => {
      const found = /dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=([\w-]+)/.exec(line)
      if (found !== null) token = found[1]
      fs.appendFileSync(logFile, line.replace(/([?&]token=)[^\s"']+/g, '$1[REDACTED]'), 'utf8')
    }
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      pending += chunk
      let end
      while ((end = pending.indexOf('\n')) !== -1) {
        save(pending.slice(0, end + 1))
        pending = pending.slice(end + 1)
      }
    })
    stream.on('end', () => {
      if (pending !== '') save(pending)
    })
  }
  capture(proc.stdout)
  capture(proc.stderr)
  while (Date.now() < deadline) {
    if (token !== null) break
    if (proc.exitCode !== null) throw new Error(`host exited with ${proc.exitCode}; see ${logFile}`)
    await delay(250)
  }
  if (token === null) throw new Error(`host on :${port} never printed its URL; see ${logFile}`)
  const cookie = await authenticate(base, token)
  return { proc, token, base, cookie }
}

/**
 * Exchange the process token for the auth cookie the browser client uses.
 * @param {string} base - host base URL.
 * @param {string} token - the process token.
 * @returns {Promise<string>} the `Cookie:` header value.
 */
async function authenticate(base, token) {
  const response = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
  const raw = response.headers.getSetCookie?.() ?? []
  const jar = raw.map((entry) => entry.split(';')[0]).join('; ')
  if (jar === '') throw new Error(`no auth cookie returned by ${base}`)
  return jar
}

/**
 * Call one host RPC.
 * @param {object} host - the host handle.
 * @param {string} method - the RPC method (`session/list`, ...).
 * @param {object} args - the method arguments.
 * @returns {Promise<any>} the RPC result value.
 */
async function api(host, method, args = {}) {
  const rpcId = `e2e-${Math.random().toString(36).slice(2)}`
  const response = await fetch(`${host.base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: host.cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  })
  const body = await response.json()
  if (body?.result?.ok !== true) throw new Error(`${method} failed: ${JSON.stringify(body).slice(0, 400)}`)
  return body.result.value
}

/** @param {number} ms - milliseconds. @returns {Promise<void>} resolves after the delay. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait until the plugin reports its first pass in a host's log.
 * @param {string} logFile - the host's log.
 * @param {number} timeoutMs - how long to wait.
 * @returns {Promise<string>} the matching line.
 */
async function waitForInitialPass(logFile, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
    const line = text.split(/\r?\n/).find((entry) => entry.includes('[dsh-aura] initial'))
    if (line !== undefined) return line
    await delay(250)
  }
  throw new Error(`no [dsh-aura] initial line in ${logFile}`)
}

/** Wait for a session title to become visible after the host's async cache write. */
async function waitForListedTitle(host, sessionId, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let mine
  do {
    const listing = await api(host, 'session/list', { _request: {} })
    mine = (listing?.items ?? []).find((item) => item.sessionId === sessionId)
    if (mine?.projections?.values?.title === expected) return mine
    await delay(200)
  } while (Date.now() < deadline)
  return mine
}

/**
 * Every session id stored under a state root's sessions directory.
 * @param {string} sessionsRoot - `<state>/sessions`.
 * @returns {string[]} the session ids.
 */
function storedSessionIds(sessionsRoot) {
  if (!fs.existsSync(sessionsRoot)) return []
  const out = []
  for (const dir of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    for (const session of fs.readdirSync(path.join(sessionsRoot, dir.name), { withFileTypes: true })) {
      if (session.isDirectory()) out.push(session.name)
    }
  }
  return out
}

/**
 * Kill a host and everything it spawned.
 * @param {object} proc - the child process.
 * @returns {Promise<void>} resolves once the tree is gone.
 */
async function killHost(proc) {
  if (proc === undefined || proc.exitCode !== null) return
  const done = new Promise((resolve) => proc.once('exit', resolve))
  spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  await Promise.race([done, delay(15_000)])
}

async function main() {
  const sandbox = buildSandboxHome()
  evidence.sandbox = sandbox
  evidence.pluginSource = sandbox.pluginSource
  step('sandbox-built', {
    home: sandbox.home,
    holderProfile: sandbox.holderProfile,
    observerProfile: sandbox.observerProfile,
    plugin: sandbox.pluginSource,
  })

  const logA = path.join(here, `run-${ROUND}-holder.log`)
  const logB = path.join(here, `run-${ROUND}-observer.log`)
  fs.writeFileSync(logA, '')
  fs.writeFileSync(logB, '')

  // ---- Host A: the "Aura side". It OWNS the session, so it holds the write lease.
  // It deliberately mounts NO dsh-aura: any title the observer shows is its own doing. ----
  const a = await bootHost({ home: sandbox.home, profile: sandbox.holderProfile, port: PORT_A, logFile: logA })
  step('holder-up', { port: PORT_A, pid: a.proc.pid })

  const created = await api(a, 'session/create', { request: { sessionId: SESSION_ID, cwd: UE_PROJECT } })
  step('session-created', { response: created })

  // Start the observer while the session is still untitled. Its projection cache now has
  // the same stale view as a Web host that booted before Aura wrote the title.
  const b = await bootHost({ home: sandbox.home, profile: sandbox.observerProfile, port: PORT_B, logFile: logB })
  step('observer-up', { port: PORT_B, pid: b.proc.pid })
  // Disabled MCP rows still appear in the host inventory. This exercises the same
  // metadata resolver the Plugins page uses without connecting to a real Aura server.
  const inventory = await api(b, 'pluginInventory/list')
  const mcpRows = (inventory?.entries ?? [])
    .filter((entry) => String(entry.moduleName).startsWith('dsh-aura/mcp/'))
    .map((entry) => ({ name: entry.moduleName, title: entry.meta?.title?.en, description: entry.meta?.description?.en }))
  step('observer-mcp-inventory', { rows: mcpRows })
  const expectedMcpNames = ['dsh-aura/mcp/unreal-inspector', 'dsh-aura/mcp/unreal-editor', 'dsh-aura/mcp/unreal-engine']
  const componentDescriptionsDistinct = expectedMcpNames.every((name) => mcpRows.some((row) => row.name === name && row.description))
    && new Set(mcpRows.map((row) => row.description)).size === 3
  const beforeRename = await api(b, 'session/list', { _request: {} })
  const initiallyUntitled = (beforeRename?.items ?? []).find((item) => item.sessionId === SESSION_ID)
  step('observer-before-rename', { found: initiallyUntitled !== undefined, title: initiallyUntitled?.projections?.values?.title ?? null })

  const renamed = await api(a, 'session/rename', { request: { sessionId: SESSION_ID, title: TITLE } })
  step('session-renamed', { response: renamed })

  const sessionsRoot = path.join(sandbox.state, 'sessions')
  const storedBefore = storedSessionIds(sessionsRoot)
  // Wait for the holder's asynchronously persisted title before the observer's delayed pass.
  const logPath = await waitForLogPath(sessionsRoot, SESSION_ID)
  const logHashBefore = logPath === null ? null : hashFile(logPath)
  step('session-on-disk', { stored: storedBefore, logPath, titleOnDisk: readTitleFromLog(logPath) })

  const beforePass = await api(b, 'session/list', { _request: {} })
  const stillUntitled = (beforePass?.items ?? []).find((item) => item.sessionId === SESSION_ID)
  step('observer-before-pass', { found: stillUntitled !== undefined, title: stillUntitled?.projections?.values?.title ?? null })

  const passLine = await waitForInitialPass(logB)
  step('observer-pass', { line: passLine })
  const passReport = JSON.parse(passLine.slice(passLine.indexOf('{')))
  const foldReported = passReport.titles?.some((entry) =>
    entry.startsWith(`${SESSION_ID.slice(0, 8)} surfaced(`) || entry.startsWith(`${SESSION_ID.slice(0, 8)} surfaced-pending(`)) ?? false

  const mine = await waitForListedTitle(b, SESSION_ID, TITLE)
  step('observer-listing', {
    found: mine !== undefined,
    hasProjections: mine?.projections !== undefined,
    title: mine?.projections?.values?.title ?? null,
    cwd: mine?.cwd ?? null,
  })

  // The held log must be byte-identical: an observer that surfaced the title without writing.
  const logHashAfter = logPath === null ? null : hashFile(logPath)
  evidence.verdict = {
    sessionStoredInSharedRoot: storedBefore.includes(SESSION_ID),
    holderMountsNoPlugin: !fs.readFileSync(logA, 'utf8').includes('[dsh-aura]'),
    componentDescriptionsDistinct,
    observerInitiallyUntitled: initiallyUntitled !== undefined && !initiallyUntitled?.projections?.values?.title,
    observerUntitledBeforePass: stillUntitled !== undefined && !stillUntitled?.projections?.values?.title,
    observerSawSession: mine !== undefined,
    observerHasTitle: mine?.projections?.values?.title === TITLE,
    observerTitle: mine?.projections?.values?.title ?? null,
    observerDidTheFoldItself: foldReported,
    heldLogUnchanged: logHashBefore !== null && logHashBefore === logHashAfter,
    pluginPassLine: passLine,
  }
  step('verdict', evidence.verdict)
  const required = ['sessionStoredInSharedRoot', 'holderMountsNoPlugin', 'componentDescriptionsDistinct', 'observerInitiallyUntitled', 'observerUntitledBeforePass', 'observerSawSession', 'observerHasTitle', 'observerDidTheFoldItself', 'heldLogUnchanged']
  const failed = required.filter((key) => evidence.verdict[key] !== true)
  if (failed.length) throw new Error(`E2E assertions failed: ${failed.join(', ')}`)

  if (!KEEP) {
    await killHost(b.proc)
    await killHost(a.proc)
    step('teardown', { killed: true })
  }
}

/**
 * Wait for a stored session's log to appear (the append is asynchronous).
 * @param {string} sessionsRoot - `<state>/sessions`.
 * @param {string} sessionId - the session id.
 * @param {number} [timeoutMs] - how long to wait.
 * @returns {Promise<string|null>} the log path, or null.
 */
async function waitForLogPath(sessionsRoot, sessionId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = findLogPath(sessionsRoot, sessionId)
    if (found !== null && readTitleFromLog(found) === TITLE) return found
    await delay(200)
  }
  return null
}

/**
 * Path of one stored session's log inside a sessions root.
 * @param {string} sessionsRoot - `<state>/sessions`.
 * @param {string} sessionId - the session id.
 * @returns {string|null} the log path, or null.
 */
function findLogPath(sessionsRoot, sessionId) {
  if (!fs.existsSync(sessionsRoot)) return null
  for (const dir of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    for (const version of [4, 3]) {
      const candidate = path.join(sessionsRoot, dir.name, sessionId, `session.v${version}.jsonl.zstd`)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * SHA-256 of a file.
 * @param {string} file - the file path.
 * @returns {string} the hex digest.
 */
function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Read the newest title out of a stored session log (frames are concatenated zstd).
 * @param {string|null} file - the session log path.
 * @returns {string|null} the title, or null.
 */
function readTitleFromLog(file) {
  if (file === null || !fs.existsSync(file)) return null
  const buffer = fs.readFileSync(file)
  const starts = []
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) starts.push(i)
  }
  const text = starts
    .map((start, index) => {
      const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
      try {
        return zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
      } catch {
        return ''
      }
    })
    .join('')
  let title = null
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
    } catch {
      /* torn tail */
    }
  }
  return title
}

try {
  await main()
  evidence.status = 'ok'
} catch (error) {
  process.exitCode = 1
  evidence.status = 'failed'
  evidence.error = String(error?.stack ?? error)
  console.error(evidence.error)
} finally {
  for (const child of children) await killHost(child)
  // Keep the temporary home for evidence inspection.
  fs.writeFileSync(path.join(here, `run-${ROUND}.json`), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`\nwrote ${path.join(here, `run-${ROUND}.json`)} (status=${evidence.status})`)
}
