/**
 * Temporary-environment sandbox for the MCP row tests.
 *
 * The `!!js` expressions read two files whose locations come from the process environment
 * (`LOCALAPPDATA` and `USERPROFILE`) — the real Aura app path and the real "Add to Editor"
 * path. To exercise the three scenarios honestly (nothing configured / only
 * `aura-mcp.json` / Aura's own file wins) the test relocates those roots to a temp tree and
 * restores the environment afterwards.
 *
 * No assumption about the real home directory is baked in: the roots are invented per run.
 *
 * @module dsh-aura/tests/helpers/env-sandbox
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Relative path Aura's own app config lives at, under `LOCALAPPDATA`. */
export const APP_CONFIG_RELATIVE = join('Programs', 'aura-client', 'next', '.mcp-config.json')
/** Relative path the "Add to Editor" action writes, under `USERPROFILE`. */
export const AURA_CONFIG_RELATIVE = join('.dsh', 'aura-mcp.json')
/**
 * Relative path of the file Aura's Python bridge publishes its port into.
 *
 * This is the gate the stdio servers themselves refuse to run without, so the rendered
 * `!!js` expressions read it too: absent ⇒ hand back a dead HTTP endpoint instead of a
 * stdio command, so no Python server is spawned (see `BRIDGE_GUARD` in lib/mcp/rows.js).
 */
export const BRIDGE_RELATIVE = join('Programs', 'aura-client', '.Aura', 'aura_server_port.txt')

/**
 * Create a sandbox with a private `LOCALAPPDATA` and `USERPROFILE`.
 * @returns {object} sandbox controls.
 */
export function createEnvSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-aura-env-'))
  const localAppData = join(root, 'localappdata')
  const userProfile = join(root, 'userprofile')
  mkdirSync(localAppData, { recursive: true })
  mkdirSync(userProfile, { recursive: true })
  const saved = new Map()
  let active = false
  let cleared = false

  const appConfigPath = join(localAppData, APP_CONFIG_RELATIVE)
  const auraConfigPath = join(userProfile, AURA_CONFIG_RELATIVE)
  const bridgePath = join(localAppData, BRIDGE_RELATIVE)
  const defaultInstallDir = join(localAppData, 'Programs', 'aura-client')
  // Publish the bridge by default. The candidate-resolution tests all describe a machine
  // where Aura IS running; without this the guard would (correctly) short-circuit every one
  // of them to the dead-endpoint config and they would stop testing stdio resolution at all.
  // `clearBridge()` is what a test uses to enter the "Aura is not running" state.
  mkdirSync(dirname(bridgePath), { recursive: true })
  writeFileSync(bridgePath, '41200\n', 'utf8')

  function activate() {
    if (!active) {
      for (const key of ['LOCALAPPDATA', 'USERPROFILE']) saved.set(key, process.env[key])
      active = true
    }
    process.env.LOCALAPPDATA = localAppData
    process.env.USERPROFILE = userProfile
  }

  function restore() {
    if (active) {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      saved.clear()
      active = false
    }
    if (!cleared) {
      cleared = true
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Write one of the candidate config files.
   * @param {'app'|'aura'} which - which file to write.
   * @param {object|string} content - the JSON value, or raw text.
   * @param {object} [options] - write options.
   * @param {boolean} [options.bom] - prefix a UTF-8 BOM (the Notepad case).
   * @returns {string} the written path.
   */
  function writeConfig(which, content, options = {}) {
    const path = which === 'app' ? appConfigPath : auraConfigPath
    mkdirSync(dirname(path), { recursive: true })
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
    writeFileSync(path, `${options.bom === true ? '\uFEFF' : ''}${text}`, 'utf8')
    return path
  }

  return {
    root,
    localAppData,
    userProfile,
    appConfigPath,
    auraConfigPath,
    bridgePath,
    defaultInstallDir,
    activate,
    restore,
    writeConfig,
    /** Create the expected Aura installation layout without running any executable. */
    installAuraFiles(rootDir = defaultInstallDir) {
      const command = join(rootDir, 'PortablePython', 'Windows', 'python.exe')
      const inspector = join(rootDir, 'MCP', 'unreal_inspector.py')
      const editor = join(rootDir, 'MCP', 'unreal_editor.py')
      for (const file of [command, inspector, editor]) {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, '', 'utf8')
      }
      return { rootDir, command, inspector, editor }
    },
    /** Remove both candidate files (the "nothing configured" scenario). */
    clearConfigs() {
      rmSync(appConfigPath, { force: true })
      rmSync(auraConfigPath, { force: true })
    },
    /** Enter the "Aura is not running" state: withdraw the bridge port file. */
    clearBridge() {
      rmSync(bridgePath, { force: true })
    },
    /** Publish the bridge port file with the normal, well-formed content. */
    publishBridge() {
      writeFileSync(bridgePath, '41200\n', 'utf8')
    },
    /**
     * Publish the bridge with arbitrary content; `undefined` removes it. Drives the guard's
     * content check -- empty, garbage and out-of-range must all read as "not up".
     * @param {string|undefined} content - file content, or undefined to remove the file.
     * @returns {void}
     */
    writeBridge(content) {
      if (content === undefined) {
        rmSync(bridgePath, { force: true })
        return
      }
      writeFileSync(bridgePath, content, 'utf8')
    },
  }
}

/**
 * Build a well-formed `mcpServers` payload.
 * @param {object} overrides - per-server overrides (`unreal_inspector` / `unreal_editor` / `unreal_mcp`).
 * @returns {{mcpServers: object}} the payload.
 */
export function mcpServersPayload(overrides = {}) {
  return {
    mcpServers: {
      unreal_inspector: {
        command: 'C:/sandbox/app/python.exe',
        args: ['C:/sandbox/app/unreal_inspector.py'],
        ...overrides.unreal_inspector,
      },
      unreal_editor: {
        command: 'C:/sandbox/app/python.exe',
        args: ['C:/sandbox/app/unreal_editor.py'],
        ...overrides.unreal_editor,
      },
      unreal_mcp: { url: 'http://127.0.0.1:9999/mcp', ...overrides.unreal_mcp },
    },
  }
}
