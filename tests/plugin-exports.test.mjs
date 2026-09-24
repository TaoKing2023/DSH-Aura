/**
 * Package/module contract: the loader's `unwrapExports` expectations and the manifest.
 *
 * The loader takes the module namespace and uses its named exports directly. A default
 * export would be unwrapped into the plugin object, and any extra export becomes part of
 * the plugin's public surface — so both are asserted here rather than assumed.
 *
 * @module dsh-aura/tests/plugin-exports.test
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { dshHome } from '../scripts/lib/dsh-modules.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

/**
 * Every source file shipped to the host, recursively.
 * @param {string} dir - the directory to walk.
 * @returns {string[]} absolute file paths.
 */
function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}
const shippedSources = [join(packageRoot, 'index.js'), ...sourceFiles(join(packageRoot, 'lib'))]

describe('service access against inject', () => {
  test('every ctx.get("…") in the shipped source is declared in inject, or an existence probe', () => {
    const declared = new Set(['timer', 'fs', 'sessionPersistence', 'workspaceRegistry', 'sessionProjectionCache'])
    const optionalProbes = new Set(['loader', 'tools'])
    const offenders = []
    for (const file of shippedSources) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/ctx\.get\(\s*'([^']+)'\s*\)/g)) {
        const name = match[1]
        if (!declared.has(name) && !optionalProbes.has(name)) offenders.push(`${file}: ${name}`)
      }
    }
    assert.deepEqual(offenders, [], 'apply() must not read a service it did not declare')
    assert.deepEqual([...optionalProbes].filter((name) => declared.has(name)), [], 'an optional probe must not also be declared')
  })

  test('the tools service is never used beyond its existence check', () => {
    for (const file of shippedSources) {
      const text = readFileSync(file, 'utf8')
      assert.equal(/\btools\s*\.\s*register\s*\(/.test(text), false, `${file} registers a tool`)
      assert.equal(/ctx\.tools\b/.test(text), false, `${file} reads ctx.tools as a property`)
    }
  })

  test('the sessionTitle service is never accessed (its ownership stays with the title plugin)', () => {
    for (const file of shippedSources) {
      const text = readFileSync(file, 'utf8')
      // Mentioning the name in a doc comment is fine — and desirable, it records the
      // ownership decision. ACCESSING it is not.
      assert.equal(/\bsessionTitle\s*\./.test(text), false, `${file} uses sessionTitle`)
      assert.equal(/ctx\.get\(\s*'sessionTitle'\s*\)/.test(text), false, `${file} reads the sessionTitle service`)
    }
  })
})

describe('README', () => {
  const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8')

  // The README was rewritten for release: it is now the generic, English, machine-independent
  // document. The machine-local install runbook moved to docs/private/install-local.md, which
  // is gitignored. These assertions describe the SHIPPED document's promises, not the runbook's
  // wording -- asserting the old Chinese headings here would pin a file that no longer ships.

  test('documents installation, the guard, configuration, limits and rollback', () => {
    for (const heading of ['## Install', '## The bridge guard', '## Configuration', '## Known limits', '## Rollback']) {
      assert.ok(readme.includes(heading), `README.md is missing the section: ${heading}`)
    }
  })

  test('names the commands and switches the reader actually needs', () => {
    for (const needle of [
      'npm install',
      'npm test',
      'dsh plugin --profile',
      'file:',
      'DSH_AURA_BRIDGE',
      'DSH_AURA_FORCE_STDIO',
      'DSH_AURA_ALLOW_ANY_COMMAND',
    ]) {
      assert.ok(readme.includes(needle), `README.md does not mention: ${needle}`)
    }
  })

  test('warns that a `link:` install breaks module resolution', () => {
    // Measured 2026-09-20: a junction to the source directory makes Node resolve the package's
    // realpath outside the profile, so `@deepseek-ai/schemastery` cannot be found and the
    // plugin silently never activates while the MCP rows load fine.
    const at = readme.indexOf('never `link:`')
    assert.notEqual(at, -1, 'README.md must say which spec to avoid')
    const around = readme.slice(at, at + 900)
    assert.match(around, /ERR_MODULE_NOT_FOUND/, 'the warning must show the actual failure')
  })

  test('states the guard is fail-closed', () => {
    assert.ok(
      readme.includes('fail-closed'),
      'README.md must say what happens when the guard cannot be evaluated',
    )
  })

  test('admits the guard cannot tell a stale bridge file from a live one', () => {
    assert.ok(
      /not liveness|stale/i.test(readme),
      'README.md must not overclaim: the guard keys on file content, not on liveness',
    )
  })
})

describe('index.js exports', () => {
  test('exactly the four named exports, and no default export', async () => {
    const module = await import('../index.js')
    assert.deepEqual(Object.keys(module).sort(), ['Config', 'apply', 'inject', 'name'])
    assert.equal(Object.hasOwn(module, 'default'), false, 'the loader unwraps a default export; this package must not have one')
    assert.equal(typeof module.apply, 'function')
    assert.equal(typeof module.name, 'string')
    assert.equal(typeof module.Config, 'function', 'Schemastery schemas are callable')
    assert.ok(Array.isArray(module.inject))
  })
})

describe('package.json', () => {
  // SHIPPED SHAPE = CHANNEL B (the bundle layer).
  //
  // Measured 2026-09-20 on the rebuilt profile: Channel A needs a hand-written row in
  // profiles/<name>/cordis.patch.yml, and this machine's `pwsh` is Windows PowerShell
  // 5.1, whose Get-Content/Set-Content round-trip mojibakes that YAML and silently drops
  // newlines (t3 F3). The bundle form is declared by the package itself, installed by
  // `plugin_manager install_bundle`, and needs no YAML hand-editing.
  //
  // The two channels stay mutually exclusive. What must never happen is BOTH a declared
  // bundle layer AND a hand-written row for the same id: the loader throws
  // `duplicate loader entry id` and the whole profile then fails to boot (t3 F2).
  test('is the Channel B shape: declares the bundle layer that carries the rows', () => {
    assert.equal(packageJson.name, 'dsh-aura')
    assert.equal(packageJson.type, 'module')
    assert.equal(packageJson.main, 'index.js')
    assert.equal(
      packageJson.dsh?.bundle?.patch,
      './cordis.patch.yml',
      'the shipped shape is the bundle layer; without dsh.bundle the package cannot be a profile bundle (t3 F2)',
    )
  })

  test('the bundle patch inserts exactly the four rows, no id twice', () => {
    const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
    const ids = [...patch.matchAll(/^\s+- id: (.+)$/gm)].map((match) => match[1].trim())
    assert.deepEqual(ids, [
      'dsh-aura',
      'mcp-aura-unreal-inspector',
      'mcp-aura-unreal-editor',
      'mcp-unreal-engine',
    ])
  })

  test('mounts no hand-written row for the same id in the live profile', (t) => {
    const profileDir = join(dshHome(), 'profiles', 'web')
    const patchPath = join(profileDir, 'cordis.patch.yml')
    if (!existsSync(patchPath)) {
      // `t.skip`, NOT `t.diagnostic + return`: the diagnostic form still counted as a PASS, so a
      // suite that checked nothing reported all-green (adversarial review AURA-09).
      t.skip(`no live profile patch at ${patchPath} — nothing to check`)
      return
    }
    const text = readFileSync(patchPath, 'utf8')
    const offenders = ['dsh-aura', 'mcp-aura-unreal-inspector', 'mcp-aura-unreal-editor', 'mcp-unreal-engine']
      .filter((id) => new RegExp(`^\\s*-\\s+id:\\s+${id}\\s*$`, 'm').test(text))
    if (offenders.length === 0) return
    // Name the actual channel state, so the failure says whether the profile is really at risk.
    // A patch row alone is latent; it becomes fatal once `dsh-aura` is also SELECTED as a bundle —
    // and declaring `dsh.bundle` means any `dsh plugin add/install` auto-selects it (plugin-manager
    // `reconcile()`), so there is no safe way to leave this unfixed.
    let inBundles = false
    try {
      const profileJson = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
      inBundles = (profileJson.dsh?.profile?.bundles ?? []).includes('dsh-aura')
    } catch {
      /* an unreadable manifest is reported as "not selected", which is the weaker claim */
    }
    assert.fail(
      `these ids exist in BOTH the bundle layer and ${patchPath}: ${offenders.join(', ')}. ` +
        `dsh-aura is ${inBundles ? 'SELECTED in dsh.profile.bundles' : 'not currently selected in dsh.profile.bundles'}; ` +
        'the loader throws "duplicate loader entry id" and the profile will not boot once it is selected.',
    )
  })

  test('declares a test script that runs the offline suite', () => {
    assert.equal(typeof packageJson.scripts?.test, 'string')
    assert.ok(packageJson.scripts.test.includes('--test'), `unexpected test script: ${packageJson.scripts?.test}`)
    assert.ok(
      packageJson.scripts.test.includes('tests/**/*.test.mjs'),
      `the test script must target the offline suite: ${packageJson.scripts?.test}`,
    )
    assert.ok(
      packageJson.scripts.test.includes('register-resolver'),
      'the resolver hook is what lets the package be tested without installing it into a profile',
    )
  })

  test('the shipped files list covers the runtime surface', () => {
    for (const entry of ['index.js', 'cordis.patch.yml', 'lib/**/*.js', 'scripts/**/*.mjs', 'scripts/*.ps1']) {
      assert.ok(packageJson.files.includes(entry), `${entry} is missing from package.json files`)
    }
  })
})
