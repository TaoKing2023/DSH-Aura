/**
 * `[router] …` title detection and the `session/title` event that replaces it.
 *
 * Two non-obvious constraints, both inherited from the implementation that already
 * worked in production:
 *
 *   1. Only a title that still STARTS WITH `[router]` may be rewritten. A title a human
 *      set (or the `set_session_title` tool set) never matches, so user naming is
 *      structurally protected rather than conventionally.
 *   2. The appended event must be byte-identical in shape to the one the product writes
 *      when it renames a session (`dsh-session-title` -> `session.append('session/title',
 *      { title, messageSeqs: [], source: { kind: 'user' } })`), otherwise the sidebar
 *      treats it as a foreign event.
 *
 * @module dsh-aura/lib/session/title-backfill
 */

/** Prefix the Aura router used to put in front of its rule block. */
export const ROUTER_PREFIX = '[router]'

/** Default character budget of a backfilled title. */
export const DEFAULT_TITLE_MAX_CHARS = 60

/**
 * Drop whole blank-line-separated blocks that are router rules and keep everything else.
 *
 * The router used to send `[router] <rule>\n[router] <rule>\n\n<user text>`; it now sends
 * `<user text>\n\n[router] <rule>`. Both shapes are handled: only blocks whose first
 * non-space character sequence is the router marker are dropped.
 *
 * A message whose rule and question ended up in ONE block (no blank line between them)
 * survives the block filter intact, and titling a session with the rule text is worse than
 * leaving the placeholder alone. So a second pass drops leading `[router]` LINES. When
 * everything was a rule this returns `''`, which {@link decideTitle} turns into `empty` --
 * i.e. "do not rename". Note that is not the same as writing an empty title: nothing is
 * written at all.
 * @param {string} text - the first human message.
 * @returns {string} the text with the router rule blocks removed, or `''` if it was all rule.
 */
export function stripRouterPreamble(text) {
  const source = String(text ?? '')
  const blocks = source.split(/\n{2,}/)
  const kept = blocks.filter((block) => !/^\s*\[router\]/.test(block))
  const joined = (kept.length > 0 ? kept.join('\n\n') : source).trim()
  if (!/^\s*\[router\]/.test(joined)) return joined
  const lines = joined.split('\n')
  let start = 0
  while (start < lines.length && /^\s*\[router\]/.test(lines[start])) start += 1
  return lines.slice(start).join('\n').trim()
}

/**
 * Flatten whitespace and clip to a character budget.
 * @param {string} text - the raw title text.
 * @param {number} [maxChars] - character budget (code points).
 * @returns {string} the tidied title.
 */
export function tidyTitle(text, maxChars = DEFAULT_TITLE_MAX_CHARS) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_TITLE_MAX_CHARS
  return Array.from(flat).slice(0, budget).join('')
}

/**
 * Whether a title is still a router placeholder (and therefore rewriteable).
 * @param {unknown} title - the current title.
 * @returns {boolean} true when it starts with the router marker.
 */
export function isRouterTitle(title) {
  return String(title ?? '').startsWith(ROUTER_PREFIX)
}

/**
 * Read the facts the decision needs out of one session's event log.
 *
 * `lastSeq` and `first` MUST come from the same read: computing `seq` from a different
 * snapshot is how duplicate sequence numbers happen.
 * @param {Array<any>} events - the log events.
 * @returns {{title: string, first: string, lastSeq: number, turns: number}} the facts.
 */
export function inspectLog(events) {
  let title = ''
  let first = ''
  let lastSeq = -1
  let turns = 0
  for (const event of events ?? []) {
    if (typeof event.seq === 'number' && event.seq > lastSeq) lastSeq = event.seq
    if (event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
      title = event.data.title
      continue
    }
    if (event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'user') {
      turns += 1
      if (first === '') {
        const content = Array.isArray(event.data.content) ? event.data.content : []
        first = content
          .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n')
      }
    }
  }
  return { title, first, lastSeq, turns }
}

/**
 * Sentinels a client writes when the user sent nothing. Never a real question, so a title
 * built from one is wrong: measured 2026-09-20, Aura's empty input arrives as
 * `(empty)\n\n[router] 现在是 Ask 模式：只读` and the old decision titled the session
 * `(empty)`.
 */
const PLACEHOLDER_TITLES = new Set(['(empty)', '(空)', '<empty>', '(no content)', '(blank)'])

/**
 * Decide what to do with one session's title.
 * @param {object} facts - {@link inspectLog} output.
 * @param {number} [maxChars] - title character budget.
 * @returns {{kind: 'keep'|'empty'|'title', title?: string}} the decision.
 */
export function decideTitle({ title, first, lastSeq }, maxChars = DEFAULT_TITLE_MAX_CHARS) {
  // Only a router placeholder is rewriteable. A title a human set (or the `set_session_title`
  // tool set) never starts with the marker, so user naming is structurally protected.
  if (!isRouterTitle(title)) return { kind: 'keep' }
  const question = tidyTitle(stripRouterPreamble(first), maxChars)
  if (question === '' || lastSeq < 0) return { kind: 'empty' }
  if (PLACEHOLDER_TITLES.has(question)) return { kind: 'empty' }
  // FIXPOINT. Without this the pass appended an identical `session/title` on EVERY process
  // lifetime: the decision reported `title` even when the new title equalled the current one,
  // so the report counted a rename while the sidebar still read `[router] …`. Measured
  // 2026-09-20 with `{ title: '[router] X', first: '[router] X' }`.
  if (question === title) return { kind: 'keep' }
  return { kind: 'title', title: question }
}

/**
 * Build the `session/title` event appended for a cold session.
 * @param {string} title - the new title.
 * @param {number} lastSeq - highest sequence number in the same read.
 * @param {number} [now] - event time (epoch ms).
 * @returns {{type: string, seq: number, time: number, data: object}} the event.
 */
export function titleEvent(title, lastSeq, now = Date.now()) {
  return {
    type: 'session/title',
    seq: lastSeq + 1,
    time: now,
    data: { title, messageSeqs: [], source: { kind: 'user' } },
  }
}
