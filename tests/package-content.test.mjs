import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('R6: the actual npm pack includes runtime files and excludes backups and private evidence', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const require = createRequire(import.meta.url)
  const npm = process.env.npm_execpath ?? join(dirname(require.resolve('npm/package.json')), 'bin/npm-cli.js')
  const output = execFileSync(process.execPath, [npm, 'pack', '--dry-run', '--json', '--ignore-scripts'], {cwd: root, encoding: 'utf8', windowsHide: true})
  const files = JSON.parse(output)[0].files.map((f) => f.path)
  assert.deepEqual(files.filter((p) => /\.bak|(^|\/)(audit|private|node_modules|tests)\//i.test(p)), [])
  for (const required of ['index.js', 'cordis.patch.yml', 'lib/pass.js', 'lib/mcp/patch-yaml.js', 'scripts/Sync-AuraMcp.mjs', 'scripts/lib/dsh-modules.mjs', 'README.md', 'README.zh.md', 'LICENSE']) {
    assert.ok(files.includes(required), `${required} missing from npm pack`)
  }
})
