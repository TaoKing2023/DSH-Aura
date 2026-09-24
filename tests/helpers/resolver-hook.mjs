/**
 * Node module-resolution hook for the package's offline tests.
 *
 * The package is developed in a source checkout that has no `node_modules`: its
 * runtime dependencies (`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-llm`, `js-yaml`)
 * come from the profile's module fallback. Without this hook, importing `index.js` from
 * the repository would fail with ERR_MODULE_NOT_FOUND even though the plugin runs fine in
 * the harness.
 *
 * Register it before the tests load (package.json `test` script):
 *   node --import ./tests/helpers/register-resolver.mjs --test tests/
 *
 * Resolution only kicks in when Node's own resolution FAILS, so a real local install always
 * wins and the hook cannot shadow anything.
 *
 * @module dsh-aura/tests/helpers/resolver-hook
 */

import { pathToFileURL } from 'node:url'
import { resolveFromDsh } from '../../scripts/lib/dsh-modules.mjs'

/**
 * Whether a specifier is bare (a package name rather than a path or a builtin).
 * @param {string} specifier - the import specifier.
 * @returns {boolean} true for bare specifiers.
 */
function isBare(specifier) {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:') && !specifier.startsWith('node:') && !/^[a-zA-Z]:[\\/]/.test(specifier)
}

/**
 * Resolve a specifier, retrying through the DSH anchors when Node's own resolution fails.
 * @param {string} specifier - the import specifier.
 * @param {object} context - Node's resolve context.
 * @param {Function} nextResolve - the next resolver in the chain.
 * @returns {Promise<object>} the resolution result.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (!isBare(specifier)) throw error
    const path = resolveFromDsh(specifier)
    if (path === null) throw error
    return { url: pathToFileURL(path).href, shortCircuit: true }
  }
}
