/**
 * Stub DSH host services + stub Cordis context, so `apply()` can be driven offline.
 *
 * The stubs model only the surface the plugin actually touches, and they model it
 * faithfully where the behaviour matters:
 *   - `attachSession` PREPENDS (that is why recency re-placement exists at all);
 *   - `insertSessionBefore` moves an id before an anchor;
 *   - `sessionPersistence.open(id, 'write')` throws for a session an ACP child holds,
 *     while `open(id, 'read')` still succeeds — a read takes no ownership, which is the
 *     whole basis of the read-only title surfacing (an `unreadable` fixture models the
 *     other half: a session that cannot be opened at all);
 *   - `coldSnapshot` records what it was handed, so the fold cut point can be asserted,
 *     and makes `cachedSnapshot` start answering for that session — the listing's rows
 *     exist only after a fold, which is exactly the sidebar's behaviour.
 *
 * @module dsh-aura/tests/helpers/stub-dsh
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A real on-disk directory tree serviced by the injected `fs` service.
 *
 * Real files are used rather than an in-memory model so that `*.uproject` detection is
 * exercised against the file system, which is what the probe does in production.
 * @param {Record<string, string[]>} layout - directory path -> file names.
 * @returns {{root: string, fs: object, cleanup: Function}} the fixture.
 */
export function createFsFixture(layout) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-aura-fs-'))
  for (const [dir, files] of Object.entries(layout)) {
    const target = join(root, dir)
    mkdirSync(target, { recursive: true })
    for (const file of files) writeFileSync(join(target, file), '', 'utf8')
  }
  const fs = {
    async resolve(path) {
      return path
    },
    async stat(path) {
      // eslint-disable-next-line no-undef -- node:fs/promises is imported below
      const info = await statOf(path)
      return info
    },
    async listDir(path) {
      // eslint-disable-next-line no-undef -- node:fs/promises is imported below
      const entries = await readdirOf(path)
      return entries
    },
  }
  return {
    root,
    fs,
    dir: (relative) => join(root, relative),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** Lazily imported `node:fs/promises` helpers, kept out of the module top level for clarity. */
async function statOf(path) {
  const { stat } = await import('node:fs/promises')
  try {
    const info = await stat(path)
    return { type: info.isDirectory() ? 'directory' : 'file' }
  } catch {
    return undefined
  }
}

async function readdirOf(path) {
  const { readdir, stat } = await import('node:fs/promises')
  const names = await readdir(path)
  const out = []
  for (const name of names) {
    const info = await stat(join(path, name))
    out.push({ name, type: info.isDirectory() ? 'directory' : 'file' })
  }
  return out
}

/**
 * A session fixture.
 * @param {object} options - session inputs.
 * @param {string} options.id - session id.
 * @param {string} options.cwd - session cwd.
 * @param {number} [options.createdAt] - header creation time.
 * @param {string} [options.origin] - session origin.
 * @param {Array<any>} [options.events] - the log.
 * @param {number} [options.inheritedEventCount] - fork cut point.
 * @param {boolean} [options.busy] - make `open(id,'write')` throw (an ACP child holds it).
 * @param {boolean} [options.unreadable] - make `open(id,'read')` throw as well.
 * @returns {object} the fixture.
 */
export function sessionFixture({
  id,
  cwd,
  createdAt = 0,
  origin,
  events = [],
  inheritedEventCount = 0,
  busy = false,
  unreadable = false,
}) {
  return {
    header: { id, cwd, createdAt, ...(origin === undefined ? {} : { origin }) },
    events: events.slice(),
    inheritedEventCount,
    busy,
    unreadable,
    appended: [],
    flushes: 0,
    closes: 0,
    reads: 0,
  }
}

/**
 * A user message event.
 * @param {string} text - the message text.
 * @param {number} seq - the sequence number.
 * @returns {object} the event.
 */
export function userMessage(text, seq) {
  return { type: 'user/message', seq, time: 0, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } }
}

/**
 * A title event.
 * @param {string} title - the title.
 * @param {number} seq - the sequence number.
 * @returns {object} the event.
 */
export function titleEventFixture(title, seq) {
  return { type: 'session/title', seq, time: 0, data: { title, messageSeqs: [], source: { kind: 'user' } } }
}

/**
 * A `sessionPersistence` stub.
 * @param {object[]} sessions - {@link sessionFixture} entries.
 * @returns {object} the service.
 */
export function createFakePersistence(sessions) {
  const byId = new Map(sessions.map((session) => [session.header.id, session]))
  const opened = []
  return {
    sessions,
    byId,
    opened,
    async list() {
      return sessions.map((session) => ({ header: session.header }))
    },
    async open(id, access) {
      const session = byId.get(String(id))
      if (session === undefined) throw new Error(`unknown session ${String(id)}`)
      // A read takes no ownership: it succeeds exactly where the write claim cannot be had.
      if (access === 'read') {
        if (session.unreadable) throw new Error(`session ${String(id)} cannot be read`)
      } else if (session.busy) {
        throw new Error(`session ${String(id)} is busy (held by another process)`)
      }
      opened.push({ id: String(id), access })
      return {
        header: session.header,
        inheritedEventCount: session.inheritedEventCount,
        async read() {
          session.reads += 1
          return { events: session.events.slice() }
        },
        async append(events) {
          for (const event of events) session.events.push(event)
          session.appended.push(...events)
        },
        async flush() {
          session.flushes += 1
        },
        async close() {
          session.closes += 1
        },
      }
    },
  }
}

/**
 * A `workspaceRegistry` stub with PREPEND attach semantics.
 * @param {Array<{path: string, title: string, sessionIds?: string[]}>} [seed] - existing rows.
 * @returns {object} the service.
 */
export function createFakeRegistry(seed = []) {
  const rows = new Map()
  const calls = []
  for (const row of seed) {
    rows.set(row.path, {
      path: row.path,
      title: row.title,
      sessionIds: (row.sessionIds ?? []).slice(),
      async attachSession(id) {
        calls.push({ op: 'attach', path: this.path, id: String(id) })
        this.sessionIds.unshift(String(id))
      },
      async insertSessionBefore(id, anchor) {
        calls.push({ op: 'insertBefore', path: this.path, id: String(id), anchor: String(anchor) })
        const from = this.sessionIds.indexOf(String(id))
        if (from !== -1) this.sessionIds.splice(from, 1)
        const at = this.sessionIds.indexOf(String(anchor))
        if (at === -1) this.sessionIds.unshift(String(id))
        else this.sessionIds.splice(at, 0, String(id))
      },
    })
  }
  return {
    rows,
    calls,
    async create(path, title) {
      calls.push({ op: 'create', path, title })
      if (!rows.has(path)) {
        rows.set(path, {
          path,
          title,
          sessionIds: [],
          async attachSession(id) {
            calls.push({ op: 'attach', path: this.path, id: String(id) })
            this.sessionIds.unshift(String(id))
          },
          async insertSessionBefore(id, anchor) {
            calls.push({ op: 'insertBefore', path: this.path, id: String(id), anchor: String(anchor) })
            const from = this.sessionIds.indexOf(String(id))
            if (from !== -1) this.sessionIds.splice(from, 1)
            const at = this.sessionIds.indexOf(String(anchor))
            if (anchor === undefined) this.sessionIds.push(String(id))
            else if (at === -1) throw new Error('unknown anchor')
            else this.sessionIds.splice(at, 0, String(id))
          },
        })
      }
      return rows.get(path)
    },
    async list() {
      return Array.from(rows.values())
    },
  }
}

/**
 * A `sessionProjectionCache` stub that records both calls.
 *
 * `cachedSnapshot` mirrors the three states the real cache can be in, because the plugin's
 * gate has to tell them apart:
 *   - `titled` — a cut whose `title` row exists: the row already reads correctly;
 *   - `lastPromptAt` — a cut WITHOUT a title (a checkpoint written before the title existed):
 *     the row renders as the bare directory name, which is the state the sandbox reproduced;
 *   - neither, and not yet folded — no record at all (the reported production case).
 * `coldSnapshot` records what it was handed and makes the session titled from then on.
 * @param {object} [seed] - cache seed.
 * @param {Record<string, number>} [seed.lastPromptAt] - session id -> `sessionListMetadata.lastPromptAt`.
 * @param {Record<string, string>} [seed.titled] - session id -> an already-served title.
 * @returns {object} the service.
 */
export function createFakeProjectionCache(seed = {}) {
  const lastPromptAt = seed.lastPromptAt ?? {}
  const titled = new Map(Object.entries(seed.titled ?? {}))
  const coldSnapshots = []
  const cachedSnapshots = []
  return {
    coldSnapshots,
    cachedSnapshots,
    /** Session ids the cache can serve a title for. */
    titled,
    cachedSnapshot(header, keys) {
      // Current DSH accepts an optional iterable of projection keys, not an inherited cut.
      if (keys !== undefined && typeof keys?.[Symbol.iterator] !== 'function') throw new TypeError('projection keys must be iterable')
      cachedSnapshots.push({ header, keys })
      const id = String(header?.id ?? '')
      const title = titled.get(id)
      if (title !== undefined) return { asOfSeq: 0, values: { title } }
      const at = lastPromptAt[id]
      if (at !== undefined) return { asOfSeq: 0, values: { sessionListMetadata: { lastPromptAt: at } } }
      return undefined
    },
    coldSnapshot(header, inheritedEventCount, events) {
      coldSnapshots.push({ id: String(header.id), header, inheritedEventCount, eventCount: events.length })
      // The real fold stores every row the log projects, title included.
      const title = events.findLast?.((event) => event.type === 'session/title')?.data?.title
      if (typeof title === 'string') titled.set(String(header.id), title)
      else titled.set(String(header.id), '')
    },
  }
}

/**
 * Loader entries as `loader.entries()` would report them, for the self-check.
 *
 * `channel: 'A'` gives the profile-layer shape (the row's `name` is an absolute path the
 * loader rewrote to a `file://` URL); `channel: 'B'` gives the bundle-layer shape (the bare
 * package name); `extra` rows can be added to simulate a legacy or duplicated row.
 * @param {object} [options] - entry options.
 * @param {'A'|'B'|'none'} [options.channel] - which shape the `dsh-aura` row has.
 * @param {Array<{id: string, name?: string}>} [options.extra] - additional loader entries.
 * @returns {Array<object>} the entries.
 */
export function loaderEntries(options = {}) {
  const channel = options.channel ?? 'A'
  const entries = []
  const mcpIds = ['mcp-aura-unreal-inspector', 'mcp-aura-unreal-editor', 'mcp-unreal-engine']
  for (const id of mcpIds) {
    entries.push({ id, options: { id, name: '@deepseek-ai/dsh-mcp-client' } })
  }
  if (channel === 'A') {
    entries.unshift({
      id: 'dsh-aura',
      options: { id: 'dsh-aura', name: 'file:///C:/Users/example/.dsh/profiles/web/node_modules/dsh-aura/index.js' },
    })
  } else if (channel === 'B') {
    entries.unshift({ id: 'dsh-aura', options: { id: 'dsh-aura', name: 'dsh-aura' } })
  }
  for (const entry of options.extra ?? []) {
    entries.push({ id: entry.id, options: { id: entry.id, name: entry.name ?? entry.id } })
  }
  return entries
}

/**
 * Build a stub Cordis context.
 * @param {object} [options] - stub inputs.
 * @param {object} [options.services] - service overrides.
 * @param {object} [options.entries] - loader entries (for the self-check).
 * @returns {object} the context, with test-inspection fields.
 */
export function createStubCtx(options = {}) {
  const timers = []
  const effects = []
  const handlers = new Map()
  /** Every service name the plugin asked for, in order (including optional probes). */
  const requested = []
  const services = {
    timer: {
      timeout(fn, delay) {
        timers.push({ kind: 'timeout', fn, delay })
        return () => {}
      },
      interval(fn, delay) {
        timers.push({ kind: 'interval', fn, delay })
        return () => {}
      },
    },
    ...(options.services ?? {}),
  }
  const ctx = {
    get(serviceName) {
      requested.push(String(serviceName))
      return services[serviceName]
    },
    on(event, handler) {
      const list = handlers.get(event)
      if (list === undefined) handlers.set(event, [handler])
      else list.push(handler)
      return () => {}
    },
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  if (options.entries !== undefined) {
    services.loader = {
      entries: () => options.entries,
    }
  }
  /**
   * Tear this activation down the way a Cordis fiber does on unload / `update()`: run every
   * registered effect's disposer in reverse order, then forget the timers and handlers those
   * effects had registered.
   *
   * This exists so a test can model `fiber.update()`, which RE-INVOKES `apply` on the SAME
   * context. Without it the stub had no unload semantics at all, and a context-keyed
   * applied-once guard in the plugin looked correct while it was silently killing the plugin
   * on every hot reload (found 2026-09-20; see the re-apply test in apply-smoke.test.mjs).
   * @returns {void}
   */
  function unload() {
    for (const entry of [...effects].reverse()) {
      if (typeof entry.dispose === 'function') entry.dispose()
    }
    effects.length = 0
    timers.length = 0
    handlers.clear()
  }
  return {
    ctx,
    services,
    timers,
    effects,
    handlers,
    requested,
    unload,
    /** Run the first-pass timer (the `initial` timeout) and await the pass. */
    async runInitial() {
      const timer = timers.find((entry) => entry.kind === 'timeout')
      if (timer === undefined) throw new Error('no timeout timer was registered')
      return timer.fn()
    },
    /** Run the poll timer and await the pass. */
    async runPoll() {
      const timer = timers.find((entry) => entry.kind === 'interval')
      if (timer === undefined) throw new Error('no interval timer was registered')
      return timer.fn()
    },
    /** The registered `agent/pre-step` handler. */
    preStep() {
      const list = handlers.get('agent/pre-step')
      return list === undefined ? undefined : list[0]
    },
  }
}

/**
 * Capture console output for the duration of one call.
 * @param {Function} fn - the function to run.
 * @returns {Promise<{result: any, log: string[], warn: string[], error: string[]}>} captured output.
 */
export async function captureConsole(fn) {
  const log = []
  const warn = []
  const error = []
  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error
  console.log = (...args) => log.push(args.map(String).join(' '))
  console.warn = (...args) => warn.push(args.map(String).join(' '))
  console.error = (...args) => error.push(args.map(String).join(' '))
  try {
    const result = await fn()
    return { result, log, warn, error }
  } finally {
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
  }
}
