import yaml from 'js-yaml'

// Match the loader dialect, but keep executable expressions as inert data.
const jsExpression = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (value) => typeof value === 'string',
  construct: (value) => ({ __jsExpr: value }),
})
const schema = yaml.JSON_SCHEMA.extend(jsExpression)

export function parsePatch(text) {
  const patches = yaml.load(String(text ?? ''), { schema })
  if (patches === undefined || patches === null) return []
  if (!Array.isArray(patches)) throw new Error('patch must be a YAML sequence')
  return patches
}

export function insertedRows(text) {
  const rows = []
  function visit(entries, ancestors = new Set()) {
    if (!Array.isArray(entries)) return
    if (ancestors.has(entries)) throw new Error('cyclic loader entries are not supported')
    const next = new Set(ancestors).add(entries)
    for (const row of entries) {
      if (!row || typeof row !== 'object') continue
      rows.push(row)
      if (row.group === true) visit(row.config, next)
    }
  }
  for (const patch of parsePatch(text)) visit(patch?.insert)
  return rows
}
