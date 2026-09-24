# dsh-aura

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that wires
[Aura for Unreal](https://www.tryaura.dev/) into the harness, and keeps Aura's sessions
readable once they are there.

It does three things, all host-side:

| | what | why |
|---|---|---|
| **MCP rows** | renders three loader rows — `unreal_inspector`, `unreal_editor` (Aura's stdio MCP servers) and `mcp-unreal-engine` (the engine's own HTTP server) | so a DSH agent can read and write a live Unreal project |
| **Session grouping** | files every session whose working directory contains a `.uproject` into one workspace row per project, rewrites `[router] …` titles back to the user's actual question, and makes a session another DSH host is still holding readable here — read-only, never written | Aura drives DSH one session per conversation; without this the sidebar fills with identical rows, and a row whose title never reaches this host renders as the bare directory name |
| **Prompt constraints** | injects a short Unreal workspace contract once per session | the difference between "here is how you would do it" and the change actually being made |

Host-only. Named exports only. **It registers no tools**, opens no ports, and spawns nothing
of its own — the Unreal processes are started by the MCP client from the configuration this
plugin renders.

The Plugins page shows four components: `dsh-aura` manages sessions and workspace guidance;
**Aura Unreal Inspector** reads project assets and editor state; **Aura Unreal Editor**
changes the open project; and **Unreal Engine MCP** connects to the engine's local HTTP
endpoint. Each MCP component has its own description while sharing the upstream MCP client.

---

## Requirements

- **Node >= 22.3** (it uses `process.getBuiltinModule` in a load-time expression, and the
  guard below is written to fail safe on older runtimes rather than fall through).
- DeepSeek Harness **0.1.7-rc.1 or newer** and a profile to install into.
- For the two Unreal rows to actually return tools: **the Aura desktop app running**, with
  UnrealEditor connected to the project you care about. Without it the rows load but report
  no tools — see *Known limits*.

## Install

The package is a bundle: its `cordis.patch.yml` inserts the plugin row and the three MCP
rows. Put it in a profile and let the harness install it.

```powershell
# ~/.dsh/profiles/<profile>/package.json
"dependencies": { "dsh-aura": "file:/absolute/path/to/dsh-aura" },
"dsh": { "profile": { "bundles": [ /* … */ "dsh-aura" ] } }
```

```powershell
dsh plugin --profile <profile> install
```

If Aura is installed as an Unreal plugin rather than under the default local app directory,
set `DSH_AURA_INSTALL_DIR` in the environment of the DSH host before starting it. Point it
at the directory that contains both `PortablePython` and `MCP`, for example
`<UE-install>/Engine/Plugins/Marketplace/Aura`. The MCP command paths in Aura's JSON must
match that directory. Restart the host after changing the setting.

> ### Use a `file:` spec, never `link:`
>
> `link:` (and anything that produces a bare junction/symlink to the source directory) makes
> Node resolve the package's **realpath** outside the profile, so its bare imports —
> `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-llm` — cannot be found:
>
> ```
> ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
>   imported from <source>/lib/config.js
> ```
>
> The failure is quiet in a nasty way: the three MCP rows still load (they resolve from the
> profile), so the profile looks fine while the plugin itself never activates. `file:` packs
> the package into the profile's own `node_modules/.pnpm`, where resolution works.
>
> Also note `file:` is a **packed copy**: after editing the source, re-run the install or you
> will keep executing the old code. Restart the DSH host to load a changed bundle patch and
> refresh the Plugins page metadata.

Verify:

```powershell
dsh --profile <profile> --dump-config | Select-String 'mcp-aura|dsh-aura'
```

You want each of `dsh-aura`, `mcp-aura-unreal-inspector`, `mcp-aura-unreal-editor` and
`mcp-unreal-engine` once. Run `npm run channel` to check which wiring channel owns them;
Channel B is expected for a bundle install. `mcp:check` checks whether Channel A may be
written, so it deliberately refuses when Channel B is active. The config dump alone is not
a reliable duplicate-row check.

## The bridge guard, and why it exists

Aura's two stdio servers refuse to start when the desktop app's Python bridge is not
running — and then **retry roughly once a second, forever**. Nothing on the DSH side can
stop that: the child process belongs to the MCP client, so `failOnStartupError: false` only
covers failures at startup, not a child that starts, stays alive and never completes the
handshake. Measured in an isolated profile with Aura absent:

| | one two-word prompt | stderr | child processes |
|---|---|---|---|
| rows wired as shipped | **67.3 s** | ~1 line/second, saturating the log | 2, spinning |
| rows withheld | **2.1 s** | none | none |

The rows sit in `loading` indefinitely in the first case; a merely *unreachable* HTTP
endpoint, by contrast, settles to `active` within its normal timeout. This behavior is why
the plugin checks the bridge before selecting the stdio transport.

Until that is fixed, this plugin guards its two stdio rows. The `config` is a load-time
expression that checks for Aura's bridge port file and, **when it cannot establish that the
app is up, hands back a dead HTTP endpoint instead of a stdio command**. No process is
spawned, the connection is refused immediately, and the row settles instead of hanging.

What counts as "up": the bridge file exists **and** its content parses as a TCP port.
Missing, unreadable, empty, garbage or out-of-range all mean "not up". The check is
deliberately **fail-closed** — if it cannot be evaluated at all, the answer is the dead
endpoint, never the stdio command.

| variable | effect |
|---|---|
| `DSH_AURA_BRIDGE` | relocate the bridge port file the guard probes |
| `DSH_AURA_FORCE_STDIO=1` | skip the guard entirely (Aura installed somewhere the guard does not know about) |
| `DSH_AURA_INSTALL_DIR` | pin one trusted Aura plugin directory containing `PortablePython` and `MCP`; required for installs outside `%LOCALAPPDATA%/Programs/aura-client` |
| `DSH_AURA_ALLOW_ANY_COMMAND=1` | allow custom commands from trusted local configuration (bypasses installation validation) |

The engine's own row (`mcp-unreal-engine`) has no child process and is **not** guarded.

## Configuration

The plugin row takes an optional config:

```yaml
- id: dsh-aura
  name: 'dsh-aura'
  config:
    injectionEnabled: true      # the Unreal workspace prompt contract
    pollMs: 120000              # grouping/title pass interval
    initialDelayMs: 1500
    titleFixPerPass: 60
    titleMaxChars: 60
    policyProbeEnabled: true    # one GET to the local router's /health
    ueProbeCacheMs: 600000
```

## Safety notes

- **The `dsh-aura` row registers no tools.** The three MCP rows expose the tools supplied by
  Aura and Unreal Engine, including project-changing tools when those servers provide them.
  This row injects neither `tools` nor `sessionTitle`, opens no listener, and spawns no
  process. Its policy probe defaults to a `GET` on a loopback health endpoint.
- **Commands are pinned to an installation.** Candidate JSON cannot choose an executable
  outside the installation selected by `DSH_AURA_INSTALL_DIR` or the default
  `%LOCALAPPDATA%/Programs/aura-client` directory. For an Unreal Engine plugin under
  `Plugins/Aura` or `Plugins/Marketplace/Aura`, set `DSH_AURA_INSTALL_DIR` to that exact
  directory before starting DSH. The interpreter and script must resolve to
  `PortablePython/Windows/python.exe` and `MCP/unreal_inspector.py` or
  `MCP/unreal_editor.py` there. Both must be files; extra arguments and paths
  resolving outside that layout are rejected. URLs must use HTTP(S) on loopback without
  embedded credentials. Keep the installation, environment and plugin package trusted:
  this validates paths, not signatures or the contents of installed files. The explicit
  `DSH_AURA_ALLOW_ANY_COMMAND=1` switch trusts commands supplied by the local JSON.
- **Writes are append-only and fail-soft.** Session titles are appended as `session/title`
  events; the projection cache is re-folded; workspace rows are created. A busy session is
  left alone and retried on the next pass, never forced.
- The plugin reports titles and project paths into the host log. Keep local logs private.

## Known limits

- **The guard keys on file content, not liveness.** A bridge file that is present and
  well-formed while the app is actually dead still passes, and the retry loop comes back.
  Only Aura can close that one.
- **Changing an Aura installation requires updating `DSH_AURA_INSTALL_DIR` and reloading DSH.**
  A config file alone cannot select a new executable root.
- **Missing Aura configuration degrades safely.** If the app config is missing and neither
  the pinned nor default installation can be verified, the two Aura rows expose no tools
  until DSH is reloaded.
- **Aura must be running before DSH starts.** The transport choice is made once, at load
  time; starting Aura afterwards does not revive the rows in that session.
- **`mcp-unreal-engine` gives up.** A dead engine endpoint retries with backoff (500 ms
  doubling to a 30 s cap, 10 attempts, roughly 151 s) and then stops until the plugin is
  reloaded or the host restarted. If you start the engine later, reload.
- **Grouping is keyed on the working directory**, not on "was this session started by Aura".
  Any session whose cwd contains a `.uproject` is grouped and receives the prompt contract,
  including one you created by hand.
- **Aura never renames a DSH session.** The title is written once, by DSH, right after the
  first human message: the Aura-side profile's first-prompt titler takes its `fallback` branch
  (measured: the session's only `session/title` event carries `source.kind: "fallback"` and
  `messageSeqs: [<first prompt>]`), so the row reads like the message AuraChatTap composed —
  and AuraChatTap deliberately puts the user's words first for exactly that reason. Aura's own
  sidebar name is a DIFFERENT string: it is `condensedTitle()` written to Aura's cloud thread
  with `PATCH /api/threads/<id>`, and it never reaches DSH. So the fold above goes stale only
  if the title changes *after* it: a rename made in the DSH GUI (another host writing the same
  log), a title that an LLM titler lands later than the fallback, or this plugin's own
  `[router] …` backfill once the holder releases. Reopening the row always shows the log's
  current title.

## Rollback

Remove `dsh-aura` from `dsh.profile.bundles` and re-run the install. Three effects are
**not** reversible by uninstalling, by design:

- `session/title` events already appended to session logs (history is not rewritten);
- the injected prompt message already recorded in a session (it replays on resume);
- workspace rows created for Unreal projects (indistinguishable from ones you made yourself).

## Development

```powershell
npm install
npm test
```

`npm test` runs the whole suite offline — no harness, no Unreal, no network. It resolves
`@deepseek-ai/*` from the package's own `node_modules` when present and falls back to a
harness install otherwise, so it works on a machine that has no DSH at all.

```
tests/            offline suite: manifest, row rendering and evaluation, the guard,
                  blocking surgery, session grouping, title backfill, projections
scripts/          the managed-block generator and the resolution helpers
lib/mcp/          row rendering + the load-time expressions
lib/session/      grouping, recency, title backfill, projection re-fold
lib/prompt/       the injected contract and its dedup
meta/             row-specific titles and descriptions for the Plugins page
```

The test runner writes local evidence under `audit/`. It is excluded from Git because host
logs can contain session details and authentication URLs.

### Change flow (agreed 2026-09-20)

A change lands in three steps, in this order, and never skips one:

1. **Offline suite** — `npm test`, no harness, no network.
2. **Sandbox, on real hosts** — `npm run e2e:new` boots two throwaway `dsh web` hosts under a
   temporary `DSH_HOME` and a generated Unreal fixture (one holds a session, one must show
   it) and asserts the outcome. MCP rows and the router probe are disabled in these profiles.
   `npm run e2e:old` runs the same scenario against the previously installed build, which is
   what makes the pair an A/B rather than an assertion. `npm run e2e:negative` deliberately
   uses a fixture without a `.uproject` and must exit 1. Assertions and exceptions produce
   a failed report and nonzero exit. Every run gets a separate evidence directory; neither
   scenario modifies a real profile.
3. **Review, then the live profile** — the operator reads the evidence under
   `audit/<date>/<change>/` (results, host logs, fingerprints) and only then is the package
   installed into the production profile.

Two rules come out of the 2026-09-20 incident that produced `e2e:*`:

- **A test that never fails on the old build proves nothing.** `e2e:old` exists to stay red.
- **Two DSH hosts share one `DSH_HOME`.** Session logs are appended (both hosts see them), but
  the projection cache and the workspace registry are per-process in-memory images loaded at
  boot, and the last writer wins the file. Anything that reads them must assume it is looking
  at a snapshot, not at the truth.

## Licence and attribution

MIT. See [`LICENSE`](LICENSE).

This plugin contains **no Aura code, assets, or reverse-engineered internals**. It reads the
JSON configuration the Aura app writes and renders MCP client rows from it; that file path
and the two command lines in it are the entire coupling. The Unreal workspace rules shipped
in `lib/prompt/bodies/` are the author's own conventions, not Aura's or Epic's
documentation. The engine's own MCP server (`mcp-unreal-engine`) belongs to Epic, not Aura.
