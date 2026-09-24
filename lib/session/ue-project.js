/**
 * "Is this session cwd a UE project?" — the gate for both grouping and prompt injection.
 *
 * The check is `<cwd>/<something>.uproject exists`, read through the injected `fs`
 * service. It deliberately does NOT look for an `AGENTS.md`: the whole point of the
 * injection is that the UE rules currently reach nobody, because the Aura router's
 * session cwd is an Unreal project directory and no
 * `AGENTS.md` lives there. Requiring one would reproduce the defect.
 *
 * @module dsh-aura/lib/session/ue-project
 */

/** Case-insensitive Unreal project file suffix. */
const UPROJECT_SUFFIX = /\.uproject$/i

/**
 * Build a cached UE-project probe.
 * @param {object} fs - the injected `fs` service (`resolve` / `stat` / `listDir`).
 * @param {object} [options] - probe options.
 * @param {number} [options.cacheMs] - TTL for both positive and negative results.
 * @returns {(cwd: string) => Promise<boolean>} the probe.
 */
export function createUeProjectProbe(fs, options = {}) {
  const cacheMs = typeof options.cacheMs === 'number' && Number.isFinite(options.cacheMs) ? options.cacheMs : 600000
  /** @type {Map<string, {isUe: boolean, at: number}>} */
  const cache = new Map()

  return async function isUeProject(cwd) {
    const key = typeof cwd === 'string' ? cwd : ''
    if (key.length === 0) return false
    const hit = cache.get(key)
    const now = Date.now()
    if (hit !== undefined && now - hit.at < cacheMs) return hit.isUe
    let isUe = false
    try {
      const target = await fs.resolve(key)
      const info = await fs.stat(target)
      if (info !== undefined && info.type === 'directory') {
        const entries = await fs.listDir(target)
        isUe = Array.isArray(entries) && entries.some((entry) => entry.type === 'file' && UPROJECT_SUFFIX.test(entry.name))
      }
    } catch {
      isUe = false
    }
    cache.set(key, { isUe, at: now })
    return isUe
  }
}
