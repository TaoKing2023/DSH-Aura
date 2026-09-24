/**
 * Plugin configuration: the Schemastery `Config` schema plus a defensive resolver.
 *
 * The loader passes whatever the row's `config:` field holds — which may be nothing at
 * all. `effectiveConfig()` therefore never throws and never relies on the schema having
 * run, so an entry mounted without a `config` block still starts (the
 * `dsh-session-title-local` pattern).
 *
 * @module dsh-aura/lib/config
 */

import z from '@deepseek-ai/schemastery'

/** Poll interval of the grouping/title pass (ms). Same value the previous plugin used. */
export const DEFAULT_POLL_MS = 120000
/** First-pass delay (ms). Part of the previous plugin's observable behaviour; keep it. */
export const DEFAULT_INITIAL_DELAY_MS = 1500
/** Maximum titles backfilled in one pass — stops one pass from holding every ACP session. */
export const DEFAULT_TITLE_FIX_PER_PASS = 60
/** Character budget of a backfilled title. */
export const DEFAULT_TITLE_MAX_CHARS = 60
/** TTL of the "is this cwd a UE project" probe cache (ms). */
export const DEFAULT_UE_PROBE_CACHE_MS = 600000
/** Router health endpoint: the only place the project gate / permission pools are observable. */
export const DEFAULT_POLICY_PROBE_URL = 'http://127.0.0.1:41777/health'
/** Minimum spacing between router health probes (ms). */
export const DEFAULT_POLICY_PROBE_MS = 600000
/** Timeout of one router health probe (ms). */
export const DEFAULT_POLICY_PROBE_TIMEOUT_MS = 2000

/**
 * Schemastery configuration for the loader row.
 *
 * `injectionEnabled` is the rollback switch for the prompt constraints; everything else
 * tunes the polling pass.
 */
export const Config = z.object({
  injectionEnabled: z.boolean().default(true),
  pollMs: z.number().step(1).min(1000).default(DEFAULT_POLL_MS),
  initialDelayMs: z.number().step(1).min(0).default(DEFAULT_INITIAL_DELAY_MS),
  titleFixPerPass: z.number().step(1).min(0).default(DEFAULT_TITLE_FIX_PER_PASS),
  titleMaxChars: z.number().step(1).min(8).default(DEFAULT_TITLE_MAX_CHARS),
  ueProbeCacheMs: z.number().step(1).min(0).default(DEFAULT_UE_PROBE_CACHE_MS),
  policyProbeEnabled: z.boolean().default(true),
  policyProbeUrl: z.string().default(DEFAULT_POLICY_PROBE_URL),
  policyProbeMs: z.number().step(1).min(0).default(DEFAULT_POLICY_PROBE_MS),
  policyProbeTimeoutMs: z.number().step(1).min(100).default(DEFAULT_POLICY_PROBE_TIMEOUT_MS),
  /** Emit the verbose per-pass report line (JSON). Default on: it is the only observable surface. */
  reportEnabled: z.boolean().default(true),
})

/**
 * Pick a finite number, else the default.
 * @param {unknown} value - the raw config value.
 * @param {number} fallback - value to use when `value` is not a usable number.
 * @returns {number} the effective number.
 */
function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** The policy probe is a local diagnostic and must never follow a configured remote URL. */
function localPolicyUrl(value) {
  if (typeof value !== 'string') return DEFAULT_POLICY_PROBE_URL
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return DEFAULT_POLICY_PROBE_URL
    if (url.username || url.password || url.search || url.hash) return DEFAULT_POLICY_PROBE_URL
    return value
  } catch {
    return DEFAULT_POLICY_PROBE_URL
  }
}

/**
 * Resolve the effective configuration with defensive defaults.
 * @param {unknown} config - the raw loader-row config (may be undefined/null).
 * @returns {object} the effective configuration.
 */
export function effectiveConfig(config) {
  const raw = config === null || typeof config !== 'object' ? {} : config
  const timeout = num(raw.policyProbeTimeoutMs, DEFAULT_POLICY_PROBE_TIMEOUT_MS)
  return {
    injectionEnabled: typeof raw.injectionEnabled === 'boolean' ? raw.injectionEnabled : true,
    pollMs: num(raw.pollMs, DEFAULT_POLL_MS),
    initialDelayMs: num(raw.initialDelayMs, DEFAULT_INITIAL_DELAY_MS),
    titleFixPerPass: num(raw.titleFixPerPass, DEFAULT_TITLE_FIX_PER_PASS),
    titleMaxChars: num(raw.titleMaxChars, DEFAULT_TITLE_MAX_CHARS),
    ueProbeCacheMs: num(raw.ueProbeCacheMs, DEFAULT_UE_PROBE_CACHE_MS),
    policyProbeEnabled: typeof raw.policyProbeEnabled === 'boolean' ? raw.policyProbeEnabled : true,
    policyProbeUrl: localPolicyUrl(raw.policyProbeUrl),
    policyProbeMs: num(raw.policyProbeMs, DEFAULT_POLICY_PROBE_MS),
    policyProbeTimeoutMs: timeout,
    reportEnabled: typeof raw.reportEnabled === 'boolean' ? raw.reportEnabled : true,
  }
}
