/**
 * Resolve DSH's own packages from a script that does not live inside the profile.
 *
 * The package is developed in a source checkout that has no `node_modules` of
 * its own: at runtime the loader resolves `@deepseek-ai/*` and `js-yaml` through the
 * profile's module fallback (`~/.dsh/profiles/<name>/node_modules` -> `~/.dsh/profiles/
 * node_modules`). Offline tooling and tests have to do the same thing explicitly, and
 * hard-coding an absolute user path (which the previous standalone verifier did) breaks the
 * moment the harness home moves.
 *
 * Anchors are discovered at runtime, in this order:
 *   1. `<package>/node_modules`                     — if the package was ever installed locally
 *   2. `$DSH_HOME/profiles/<every profile>/node_modules`
 *   3. `$DSH_HOME/profiles/node_modules`
 *   4. `$DSH_HOME/node_modules`
 *
 * @module dsh-aura/scripts/lib/dsh-modules
 */

import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Absolute path of this package's root directory. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Resolve the DSH home directory the same way the harness does.
 * @returns {string} the absolute DSH home path.
 */
export function dshHome() {
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) return resolve(process.env.DSH_HOME)
  const profile = typeof process.env.USERPROFILE === 'string' && process.env.USERPROFILE.length > 0 ? process.env.USERPROFILE : null
  const home = profile ?? (typeof process.env.HOME === 'string' ? process.env.HOME : null)
  if (home === null) throw new Error('cannot determine the DSH home: set DSH_HOME or USERPROFILE')
  return join(home, '.dsh')
}

/**
 * Every directory that may act as a module-resolution anchor, most specific first.
 * @returns {string[]} existing `node_modules` directories.
 */
export function candidateAnchors() {
  const anchors = [join(PACKAGE_ROOT, 'node_modules')]
  try {
    const home = dshHome()
    const profiles = join(home, 'profiles')
    if (existsSync(profiles)) {
      for (const entry of readdirSync(profiles, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        anchors.push(join(profiles, entry.name, 'node_modules'))
      }
      anchors.push(join(profiles, 'node_modules'))
    }
    anchors.push(join(home, 'node_modules'))
  } catch {
    /* fall through to whatever we have */
  }
  return anchors.filter((anchor, index) => anchors.indexOf(anchor) === index && existsSync(anchor))
}

/**
 * The anchor that should be tried first: the `web` profile's `node_modules`, because that
 * is the profile this wiring is installed into.
 * @returns {string|null} the anchor, or null when no candidate exists.
 */
export function preferredAnchor() {
  const anchors = candidateAnchors()
  if (anchors.length === 0) return null
  const web = anchors.find((anchor) => /[\\/]profiles[\\/]web[\\/]node_modules$/.test(anchor))
  return web ?? anchors[0]
}

/**
 * Resolve a bare specifier to an absolute file path.
 *
 * Order matters. The package's OWN `node_modules` is tried first, so a plain
 * `npm install && npm test` works on any machine -- including one with no harness
 * installed at all, which is the only way a third party can run this suite. Only when that
 * fails do the DSH anchors come into play, which is the case in a source checkout like
 * this one (no `node_modules` of its own).
 * @param {string} specifier - the bare package specifier.
 * @returns {string|null} the resolved path, or null when nothing resolves.
 */
export function resolveFromDsh(specifier) {
  try {
    return createRequire(import.meta.url).resolve(specifier)
  } catch {
    /* not a local dependency -- fall through to the harness anchors */
  }
  for (const anchor of candidateAnchors()) {
    try {
      return createRequire(join(anchor, '__dsh_aura_anchor__.js')).resolve(specifier)
    } catch {
      /* try the next anchor */
    }
  }
  return null
}

/**
 * Resolve a bare specifier and import it.
 * @param {string} specifier - the bare package specifier.
 * @returns {Promise<any>} the module namespace.
 * @throws {Error} when the specifier cannot be resolved from any anchor.
 */
export async function importFromDsh(specifier) {
  const path = resolveFromDsh(specifier)
  if (path === null) {
    throw new Error(
      `dsh-aura: cannot resolve ${JSON.stringify(specifier)} from any DSH anchor. ` +
        `Tried: ${candidateAnchors().join(', ') || '(none found)'}. ` +
        `Install the package into a profile (dsh plugin --profile web add file:${PACKAGE_ROOT}) or set DSH_HOME.`,
    )
  }
  return import(pathToFileURL(path).href)
}

/**
 * Read the profile manifest of one profile under `$DSH_HOME/profiles`.
 * @param {string} profileName - the profile directory name.
 * @returns {{dir: string, manifest: any}|null} the manifest, or null when missing.
 */
export function readProfileManifest(profileName) {
  try {
    const dir = join(dshHome(), 'profiles', profileName)
    const file = join(dir, 'package.json')
    if (!existsSync(file)) return null
    return { dir, manifest: JSON.parse(readFileSync(file, 'utf8')) }
  } catch {
    return null
  }
}
