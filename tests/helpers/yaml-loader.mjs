/**
 * Loader-fidelity helpers for the MCP rows: the REAL YAML dialect, the REAL evaluator, the
 * REAL mcp-client schema — no hand-written expectations.
 *
 * Three steps, exactly what the DSH loader does with a patch file:
 *   1. parse with the entry-list dialect (`js-yaml` + `tag:yaml.org,2002:js`, the same
 *      `yaml.Type` the loader's include defines);
 *   2. evaluate each `config` expression the way `cordis-plugin-loader` does
 *      (`new Function('ctx','expr','with (ctx) { return eval(expr) }')`);
 *   3. validate the resulting object with `@deepseek-ai/dsh-mcp-client`'s own `Config`.
 *
 * The loader's own `entryListSchema` instance is used when it is importable, and a locally
 * constructed copy of the dialect otherwise (the copy is what the previous standalone
 * verifier did; keeping both paths means a `js-yaml` major bump cannot silently change what
 * "valid" means here).
 *
 * @module dsh-aura/tests/helpers/yaml-loader
 */

import { readFileSync } from 'node:fs'
import { importFromDsh } from '../../scripts/lib/dsh-modules.mjs'

/** Cached dependency bundle. */
let depsPromise

/**
 * Load `js-yaml`, `@deepseek-ai/dsh-mcp-client` and (when available) the loader's own
 * `cordis-plugin-include` dialect.
 * @returns {Promise<{yaml: any, jsExprType: any, schema: any, mcpClient: any, schemaSource: string}>} the deps.
 */
export async function loadLoaderDeps() {
  if (depsPromise === undefined) {
    depsPromise = (async () => {
      const yamlModule = await importFromDsh('js-yaml')
      const yaml = yamlModule.default ?? yamlModule
      if (typeof yaml.load !== 'function') throw new Error('js-yaml did not expose load()')
      const isJsExpr = (value) => value instanceof Object && '__jsExpr' in value
      const jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
        kind: 'scalar',
        resolve: (data) => typeof data === 'string',
        construct: (data) => ({ __jsExpr: data }),
        predicate: isJsExpr,
        represent: (data) => data.__jsExpr,
      })
      let schema = yaml.JSON_SCHEMA.extend(jsExprType)
      let schemaSource = 'local-copy'
      try {
        const include = await importFromDsh('@deepseek-ai/cordis-plugin-include')
        if (include.entryListSchema !== undefined) {
          schema = include.entryListSchema
          schemaSource = 'cordis-plugin-include'
        }
      } catch {
        /* keep the local copy */
      }
      const mcpClient = await importFromDsh('@deepseek-ai/dsh-mcp-client')
      return { yaml, jsExprType, schema, mcpClient, schemaSource }
    })()
  }
  return depsPromise
}

/**
 * Parse a patch file with the loader's dialect.
 * @param {string} file - absolute path of the patch file.
 * @returns {Promise<{text: string, patches: any[], schemaSource: string}>} the parsed file.
 */
export async function parsePatchFile(file) {
  const { yaml, schema, schemaSource } = await loadLoaderDeps()
  const text = readFileSync(file, 'utf8')
  const parsed = yaml.load(text, { schema })
  if (!Array.isArray(parsed)) throw new Error(`${file}: top level is not a YAML array of loader patch entries`)
  return { text, patches: parsed, schemaSource }
}

/**
 * Parse patch text with the loader's dialect.
 * @param {string} text - the patch text.
 * @returns {Promise<{patches: any[], schemaSource: string}>} the parsed text.
 */
export async function parsePatchText(text) {
  const { yaml, schema, schemaSource } = await loadLoaderDeps()
  const parsed = yaml.load(text, { schema })
  if (!Array.isArray(parsed)) throw new Error('patch text: top level is not a YAML array of loader patch entries')
  return { patches: parsed, schemaSource }
}

/**
 * The evaluator the loader builds, verbatim from `cordis-plugin-loader`.
 * @returns {Function} `(ctx, expr) => any`.
 */
export function createLoaderEvaluator() {
  return new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')
}

/**
 * Evaluate every `!!js` config expression of every inserted row.
 *
 * A plain object stands in for the loader's `ctx`: the expressions deliberately reference
 * nothing but `globalThis.process`, so the scope contents are irrelevant and a stand-in
 * keeps the check independent of cordis.
 * @param {Array<any>} patches - parsed patch entries.
 * @param {object} [scope] - the evaluation scope.
 * @returns {Array<{id: string, kind: 'expr'|'literal', value: object, error?: string}>} per-row results.
 */
export function evaluateRowConfigs(patches, scope = { baseUrl: 'file:///__dsh_aura_test__/' }) {
  const evaluate = createLoaderEvaluator()
  const results = []
  for (const patch of Array.isArray(patches) ? patches : []) {
    if (patch === null || typeof patch !== 'object' || !Array.isArray(patch.insert)) continue
    for (const row of patch.insert) {
      if (row === null || typeof row !== 'object') continue
      if (typeof row.id !== 'string' || row.config === undefined || row.config === null) continue
      const isExpr = row.config instanceof Object && '__jsExpr' in row.config
      if (!isExpr) {
        results.push({ id: row.id, kind: 'literal', value: row.config })
        continue
      }
      try {
        results.push({ id: row.id, kind: 'expr', value: evaluate(scope, row.config.__jsExpr) })
      } catch (error) {
        results.push({ id: row.id, kind: 'expr', value: {}, error: String(error && error.message ? error.message : error) })
      }
    }
  }
  return results
}

/**
 * Validate one resolved config with the mcp-client's own schema.
 * @param {any} resolved - the resolved config object.
 * @returns {{ok: true, value: any} | {ok: false, message: string}} the validation result.
 */
export async function validateWithMcpClient(resolved) {
  const { mcpClient } = await loadLoaderDeps()
  if (typeof mcpClient.Config !== 'function') throw new Error('@deepseek-ai/dsh-mcp-client did not export Config as a function')
  try {
    return { ok: true, value: mcpClient.Config(resolved) }
  } catch (error) {
    return { ok: false, message: String(error && error.message ? error.message : error) }
  }
}
