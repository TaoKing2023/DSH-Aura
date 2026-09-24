/**
 * Logging: one line per event, fixed `[dsh-aura] ` prefix.
 *
 * The previous half of this wiring logged `[aura-ws] <tag> <ms>ms {json}`. The pass
 * report keeps exactly those JSON fields (`tag` / `projects[{dir,sessions,attached}]` /
 * `attached` / `renamed` / `titles[]`) so that "did the new plugin do the work" can still
 * be compared field-by-field against the historical log.
 *
 * @module dsh-aura/lib/log
 */

/** Log line prefix. grep -F '[dsh-aura]' is the diagnostic entry point. */
export const LOG_PREFIX = '[dsh-aura]'

/**
 * Create the plugin's logger.
 * @returns {(message: string) => void} a logger that never throws.
 */
export function createLogger() {
  return function log(message) {
    try {
      console.log(`${LOG_PREFIX} ${String(message)}`)
    } catch {
      /* logging must never take the plugin down */
    }
  }
}

/**
 * Stable JSON of a value, falling back to a short description when the value cannot be
 * serialized (a circular report would otherwise turn a log line into a crash).
 * @param {unknown} value - the value to serialize.
 * @returns {string} JSON text.
 */
export function safeJson(value) {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : String(value)
  } catch (error) {
    return JSON.stringify({ unserializable: String(error && error.message ? error.message : error) })
  }
}

/**
 * Format one pass report the way the previous plugin did.
 * @param {string} tag - `initial` or `poll`.
 * @param {number} elapsedMs - pass duration.
 * @param {object} report - the report object.
 * @param {boolean} [enabled] - when false, the line is not emitted.
 * @param {(message: string) => void} [log] - logger.
 * @returns {string|null} the emitted line, or null when suppressed.
 */
export function emitPassReport(tag, elapsedMs, report, enabled = true, log) {
  if (enabled === false) return null
  const line = `${tag} ${elapsedMs}ms ${safeJson(report)}`
  if (typeof log === 'function') log(line)
  return line
}
