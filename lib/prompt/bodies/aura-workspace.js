/**
 * Aura workspace rules — the second prompt body, injected together with the UE one.
 *
 * Derived from the original Aura workspace safety rules.
 *
 * That file is only read when a session's cwd happens to be the Aura directory itself
 * (the router's fallback cwd). Normal Aura sessions run in the Unreal project directory,
 * so these file-safety rules — the ones that decide whether a mistaken write can be
 * undone — reached the model only sometimes. Injecting them from the package makes the
 * "either both rule sets arrive or neither does" property true.
 *
 * @module dsh-aura/lib/prompt/bodies/aura-workspace
 */

/** The Aura workspace (UE file safety) rules, as one prompt section. */
export const AURA_WORKSPACE_BODY = [
  '## Aura 工作区规则：UE 文件改前必须备份，且必须可还原',
  '- **任何**对 Unreal 项目的写入之前，先拍快照，没有例外。属于「UE 文件」的包括：`Plugins\\**` 的 C++/头文件、`Content\\**` 的 `.uasset`/`.umap`、`Config\\*.ini`、`Content\\Python\\**`、`scripts\\**`、`*.uproject`，以及任何通过 `unreal_editor` / `unreal_inspector` MCP 工具改动的资产。',
  '- 快照落在 `<项目>/Saved/_AuraBackup/<yyyyMMdd_HHmmss>/`。`Saved/` 不被资产注册表扫描，所以快照不会污染 Content Browser。**这次要新建的文件也要收进快照**——还原时要能把它们删掉；快照里记下每个路径「当时是否存在」，否则无法区分「改回原样」和「删掉」。',
  '- 快照必须**可还原**，而且**还原本身也要能还原**：写盘之前先给当前状态再拍一张。还原脚本在编辑器开着且涉及 `Content\\` / `Config\\` 时应当拒绝执行，除非显式强制。',
  '- 如果本工作区自带快照脚本，先确认它的用法和还原能力，再优先使用。**但不要假定它存在**——不存在就自己按上面的约定拍。',
  '- 给 agent / 无人值守会话的硬性规则：**不要删除任何备份**。只读检查备份清单可以进行；任何**会删除备份**的命令或脚本模式都不要运行（例如 `Remove-Item -Recurse`）。需要腾空间时先把清单交给用户。最新那张快照永远受保护；不要删备份目录本身。',
  '- 在本机用 PowerShell 写辅助脚本时注意编码：Windows PowerShell 5.1 会把无 BOM 的 `.ps1` 按系统 ANSI 代码页解码，非 ASCII 字节会吞掉紧随的换行导致解析失败。生成 `.ps1` 时保持纯 ASCII，或写带 BOM 的 UTF-8。',
].join('\n')

/** The rule markers this body must always contain (drift guard). */
export const AURA_WORKSPACE_MARKERS = [
  '备份',
  '_AuraBackup',
  '是否存在',
  '要新建的文件也要收进快照',
  '不要删除任何备份',
  '不要假定它存在',
]
