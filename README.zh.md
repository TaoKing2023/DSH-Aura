# dsh-aura

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：将 [Aura for Unreal](https://www.tryaura.dev/) 接入 Harness，并让 Aura 会话在 Harness 中保持清晰可读。

插件在宿主端完成三件事：

| 功能 | 做什么 | 为什么需要 |
|---|---|---|
| **MCP 组件** | 提供三条加载配置：`unreal_inspector`、`unreal_editor`（Aura 的 stdio MCP 服务器）和 `mcp-unreal-engine`（引擎自己的 HTTP 服务器） | 让 DSH 智能体读取和修改正在运行的 Unreal 项目 |
| **会话归组** | 将工作目录含有 `.uproject` 的会话按项目归入工作区；把 `[router] …` 占位标题改回用户的实际提问；让另一个 DSH 宿主仍在持有的会话也能在当前宿主中读取，且只读、不写入 | Aura 的每段对话对应一个 DSH 会话；否则侧边栏会充满相似条目，标题尚未传到当前宿主时还会只显示目录名 |
| **提示词约束** | 每个会话注入一次简短的 Unreal 工作区操作约定 | 引导智能体实际完成修改，而不只是说明修改方法 |

插件仅在宿主端运行，只使用具名导出。**它自身不注册任何工具**，不开放端口，也不自行启动进程。Unreal 相关进程由 MCP 客户端根据插件呈现的配置启动。

插件页面会显示四个组件：`dsh-aura` 负责会话管理和工作区指导；**Aura Unreal Inspector** 读取项目资产和编辑器状态；**Aura Unreal Editor** 修改当前项目；**Unreal Engine MCP** 连接引擎的本地 HTTP 端点。三个 MCP 组件共用上游 MCP 客户端，但各有独立说明。

---

## 运行要求

- **Node.js >= 22.3**。插件在加载时使用 `process.getBuiltinModule`；下文的守卫在旧运行时会安全地拒绝启用，而不会继续尝试启动进程。
- **DeepSeek Harness 0.1.7-rc.1 或更新版本**，以及一个用于安装插件的 profile。
- 要让两个 Aura MCP 组件实际提供工具，需运行 **Aura 桌面应用**，并让 UnrealEditor 连接到目标项目。否则组件可以加载，但不会提供工具，详见「已知限制」。

## 安装

本包是一个 bundle；其中的 `cordis.patch.yml` 会插入插件组件和三条 MCP 组件。将包加入 profile，然后让 Harness 安装：

```powershell
# ~/.dsh/profiles/<profile>/package.json
"dependencies": { "dsh-aura": "file:/absolute/path/to/dsh-aura" },
"dsh": { "profile": { "bundles": [ /* … */ "dsh-aura" ] } }
```

```powershell
dsh plugin --profile <profile> install
```

如果 Aura 以 Unreal 插件形式安装，而不在默认的本地应用目录中，请在启动 DSH 宿主前设置环境变量 `DSH_AURA_INSTALL_DIR`。其值应指向同时包含 `PortablePython` 和 `MCP` 的目录，例如 `<UE-install>/Engine/Plugins/Marketplace/Aura`。Aura JSON 配置中的 MCP 命令路径必须与该目录一致。修改设置后需重启宿主。

> ### 使用 `file:`，不要使用 `link:`
>
> `link:` 以及任何直接链接到源代码目录的 junction 或符号链接，都会让 Node 在 profile 之外解析包的**真实路径**，导致包中的裸导入（如 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm`）无法解析：
>
> ```text
> ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
>   imported from <source>/lib/config.js
> ```
>
> 这种故障不易察觉：三条 MCP 组件仍能加载（它们从 profile 中解析），看起来 profile 一切正常，但插件本身并未启用。`file:` 会把包打包到 profile 自身的 `node_modules/.pnpm`，从而正确解析依赖。
>
> 另请注意，`file:` 安装的是**打包副本**。修改源代码后须重新运行安装命令，否则执行的仍是旧代码。要加载改动后的 bundle patch 并刷新插件页面的元数据，还需重启 DSH 宿主。

验证配置：

```powershell
dsh --profile <profile> --dump-config | Select-String 'mcp-aura|dsh-aura'
```

输出中应各有一条 `dsh-aura`、`mcp-aura-unreal-inspector`、`mcp-aura-unreal-editor` 和 `mcp-unreal-engine`。运行 `npm run channel` 可查看由哪个接入通道管理这些组件；bundle 安装应使用 Channel B。`mcp:check` 用于检查能否写入 Channel A，因此 Channel B 启用时它会有意拒绝。仅凭配置转储不能可靠判断是否存在重复组件。

## 桥接守卫及其原因

Aura 的两个 stdio 服务器在桌面应用的 Python 桥接未运行时无法启动，并且会**约每秒重试一次，持续不断**。DSH 侧无法阻止这种情况：子进程由 MCP 客户端持有，`failOnStartupError: false` 只处理启动阶段的失败，处理不了已经启动、仍然存活却始终无法完成握手的子进程。在 Aura 未启动的隔离 profile 中测得：

| 配置 | 两词提示词的耗时 | stderr | 子进程 |
|---|---|---|---|
| 按原配置接入组件 | **67.3 秒** | 约每秒一行，日志持续增长 | 2 个，持续重试 |
| 暂不接入组件 | **2.1 秒** | 无 | 无 |

前一种情况下，组件会一直停留在 `loading`；相比之下，仅仅是 HTTP 端点无法连接时，组件会在正常超时内进入 `active`。因此，插件在选择 stdio 传输方式前会检查桥接状态。

在上游问题解决前，插件会守卫这两个 stdio 组件。`config` 是加载时求值的表达式，它检查 Aura 桥接端口文件；**无法确认应用正在运行时，返回一个不会响应的 HTTP 端点，而不是 stdio 命令**。这样不会启动进程，连接会立即被拒绝，组件也不会一直卡在加载状态。

判定桥接“已启动”的条件：端口文件存在，且内容能解析为 TCP 端口。文件缺失、不可读、为空、内容无效或端口越界，都视为“未启动”。检查有意采用**失败时关闭**的策略；即使表达式本身无法求值，也只会返回无法连接的端点，绝不返回 stdio 命令。

| 环境变量 | 作用 |
|---|---|
| `DSH_AURA_BRIDGE` | 改变守卫检查的桥接端口文件位置 |
| `DSH_AURA_FORCE_STDIO=1` | 完全跳过守卫（适用于守卫无法识别的 Aura 安装方式） |
| `DSH_AURA_INSTALL_DIR` | 指定一个可信的 Aura 插件目录，其中须包含 `PortablePython` 和 `MCP`；安装位置不在 `%LOCALAPPDATA%/Programs/aura-client` 时必须设置 |
| `DSH_AURA_ALLOW_ANY_COMMAND=1` | 允许来自可信本地配置的自定义命令（跳过安装目录验证） |

引擎自身的组件（`mcp-unreal-engine`）不启动子进程，**不受此守卫约束**。

## 配置

插件组件可接收以下可选配置：

```yaml
- id: dsh-aura
  name: 'dsh-aura'
  config:
    injectionEnabled: true      # Unreal 工作区提示词约定
    pollMs: 120000              # 归组和标题修复的检查间隔
    initialDelayMs: 1500
    titleFixPerPass: 60
    titleMaxChars: 60
    policyProbeEnabled: true    # 对本地路由器 /health 执行一次 GET
    ueProbeCacheMs: 600000
```

## 安全说明

- **`dsh-aura` 组件自身不注册工具。** 三条 MCP 组件会暴露 Aura 和 Unreal Engine 服务器提供的工具；如果服务器提供修改项目的工具，这些工具也会暴露。`dsh-aura` 不注入 `tools` 或 `sessionTitle`，不开放监听端口，也不启动进程。策略探测默认只对回环地址的健康检查端点执行 `GET`。
- **命令绑定到已选安装目录。** 候选 JSON 配置不能选择 `DSH_AURA_INSTALL_DIR` 或默认 `%LOCALAPPDATA%/Programs/aura-client` 安装目录之外的可执行文件。如果 Unreal Engine 插件位于 `Plugins/Aura` 或 `Plugins/Marketplace/Aura`，请在启动 DSH 前将 `DSH_AURA_INSTALL_DIR` 设为该确切目录。解释器和脚本必须分别解析到该目录内的 `PortablePython/Windows/python.exe` 以及 `MCP/unreal_inspector.py` 或 `MCP/unreal_editor.py`；两者都必须是文件。额外参数和解析后越出该目录结构的路径会被拒绝。URL 必须使用回环地址上的 HTTP(S)，且不能嵌入凭据。安装目录、环境变量和插件包本身仍须可信：此检查验证的是路径，并不验证签名或安装文件的内容。显式设置 `DSH_AURA_ALLOW_ANY_COMMAND=1` 会信任本地 JSON 提供的命令。
- **写入采用追加方式，失败时不会强行继续。** 会话标题以 `session/title` 事件追加；投影缓存会重新折叠；工作区条目会被创建。正在使用的会话会留待下一轮处理，不会强制修改。
- 插件会把标题和项目路径写入宿主日志。请妥善保护本地日志。

## 已知限制

- **守卫依据文件内容判断，不验证进程是否存活。** 即使应用实际已停止，只要桥接文件存在且格式正确，检查仍会通过，重试循环也会再次出现。这需要 Aura 自身解决。
- **更换 Aura 安装位置需要更新 `DSH_AURA_INSTALL_DIR` 并重新加载 DSH。** 单靠配置文件不能选定新的可执行文件根目录。
- **缺少 Aura 配置时会安全降级。** 如果应用配置不存在，而且指定或默认的安装目录都无法验证，两个 Aura 组件在 DSH 重新加载前不会提供工具。
- **必须先启动 Aura，再启动 DSH。** 传输方式在加载时只选择一次；之后才启动 Aura，不会恢复该次运行中的组件。
- **`mcp-unreal-engine` 会停止重试。** 引擎端点无法连接时，它按退避策略重试（从 500 毫秒起，逐次翻倍，最多 30 秒；共 10 次，合计约 151 秒），然后停止，直到插件重新加载或宿主重启。如果之后才启动引擎，需要重新加载。
- **归组依据工作目录**，而不是“会话是否由 Aura 启动”。任何 cwd 包含 `.uproject` 的会话都会被归组并收到提示词约定，包括你手动创建的会话。
- **Aura 不会重命名 DSH 会话。** DSH 在第一条用户消息之后写入一次标题：Aura 侧 profile 的首轮提示词标题生成器走的是 `fallback` 分支（实测该会话唯一的 `session/title` 事件包含 `source.kind: "fallback"` 和 `messageSeqs: [<first prompt>]`），所以条目标题与 AuraChatTap 拼装的消息相似。AuraChatTap 正是为此把用户原话放在开头。Aura 自己侧边栏中的名称是**另一个字符串**：它由 `condensedTitle()` 生成，经 `PATCH /api/threads/<id>` 写入 Aura 云端会话，不会传到 DSH。因此，上述投影只会在标题写入之后又发生变化时过期，例如在 DSH 界面重命名（另一个宿主写入同一日志）、LLM 标题生成晚于 fallback，或本插件在持有该会话的宿主释放后回填 `[router] …` 标题。重新打开条目始终能看到日志中的当前标题。

## 回滚

从 `dsh.profile.bundles` 中移除 `dsh-aura`，然后重新运行安装命令。按照设计，卸载后**不会撤销**以下三种影响：

- 已追加到会话日志中的 `session/title` 事件（历史记录不会被重写）；
- 已记录在会话中的注入提示词消息（恢复会话时会重放）；
- 为 Unreal 项目创建的工作区条目（无法与手动创建的条目区分）。

## 开发

```powershell
npm install
npm test
```

`npm test` 会离线运行整套测试，不需要 Harness、Unreal 或网络。存在包自身的 `node_modules` 时，测试从中解析 `@deepseek-ai/*`；否则尝试使用 Harness 安装目录。因此，没有安装 DSH 的机器也能运行。

```text
tests/            离线测试：清单、组件渲染及求值、守卫、
                  阻塞处理、会话归组、标题回填、投影
scripts/          受控配置块生成器与路径解析辅助程序
lib/mcp/          MCP 组件渲染与加载时表达式
lib/session/      归组、近期顺序、标题回填、投影重新折叠
lib/prompt/       注入的约定及去重
meta/             插件页面各组件专属的标题和说明
```

测试运行器会将本地证据写入 `audit/`。宿主日志可能包含会话细节和带认证信息的 URL，因此该目录不纳入 Git。

### 修改流程（2026-09-20 约定）

每项改动按以下顺序经过三个步骤，不跳过：

1. **离线测试**：`npm test`，无需 Harness 或网络。
2. **真实宿主上的隔离测试**：`npm run e2e:new` 会在临时 `DSH_HOME` 和生成的 Unreal 测试项目下启动两个一次性的 `dsh web` 宿主；一个持有会话，另一个必须能显示它，并对结果做断言。测试 profile 中禁用了 MCP 组件和路由器探测。`npm run e2e:old` 对先前安装的版本运行相同场景，让两次运行成为 A/B 对照。`npm run e2e:negative` 故意使用没有 `.uproject` 的测试目录，预期以退出码 1 结束。断言或异常发生时会生成失败报告和非零退出码。每次运行使用独立的证据目录，两个场景都不会修改实际使用的 profile。
3. **审核后安装到正式 profile**：操作者先阅读 `audit/<date>/<change>/` 下的证据（结果、宿主日志、指纹），再把包安装进生产 profile。

产生 `e2e:*` 的 2026-09-20 事件带来两条规则：

- **如果测试在旧版本上也不会失败，就不能证明修复有效。** `e2e:old` 应保持失败。
- **两个 DSH 宿主共用一个 `DSH_HOME`。** 会话日志采用追加写入，两个宿主都能看到；但投影缓存和工作区注册表是在启动时加载到各自进程内存中的映像，最后写入者会覆盖文件。因此，读取它们时必须把它们视为快照，而不是最终事实。

## 许可证与归属

MIT。详见 [`LICENSE`](LICENSE)。

本插件**不包含 Aura 代码、素材或经逆向工程取得的内部实现**。它读取 Aura 应用写出的 JSON 配置，并据此呈现 MCP 客户端组件；该文件路径和文件内的两条命令行就是全部耦合点。`lib/prompt/bodies/` 中的 Unreal 工作区规则是作者自己的惯例，并非 Aura 或 Epic 的文档。引擎自身的 MCP 服务器（`mcp-unreal-engine`）属于 Epic，不属于 Aura。
