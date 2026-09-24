/**
 * UE workspace rules — the prompt body that fixes defect D2.
 *
 * DERIVED FROM the author's local Unreal workspace instruction file (201 lines).
 *
 * WHY IT LIVES HERE. That file is discovered by `@deepseek-ai/dsh-agent-instructions` by
 * walking UP from a session's cwd, and it sits in `UE5_Aura\` — an archive root that is
 * never a session cwd. The Aura router's sessions run with the cwd set to the Unreal
 * project directory, where no `AGENTS.md` exists. Measured
 * during the inventory: those 201 lines of UE rules reached no session at all.
 *
 * Injecting from the package is the fix that does not depend on cwd-side file discovery:
 * the gate is "the session's cwd is a UE project" (a `*.uproject` exists there), which is
 * exactly the condition under which these rules apply. Nothing checks for an `AGENTS.md`.
 *
 * The text is a faithful distillation, not a copy: every rule category of the source is
 * represented (deliverable shape, standard loop, pre-flight backup, per-task tool choice,
 * skill-first, documentation style) and the UE 5.8 findings are kept verbatim in
 * substance, because those are the parts that cost real debugging time.
 *
 * @module dsh-aura/lib/prompt/bodies/ue-workspace
 */

/** The UE workspace rules, as one prompt section. */
export const UE_WORKSPACE_BODY = [
  '## Unreal Engine 工作区规则（dsh-aura 插件注入）',
  '',
  '### 一、交付物 = 结果 + 简短规范（最高优先级，违反即为失败）',
  '- 用户问「怎么加 / 怎么改 / 怎么做 X」，要的是 X 已经被做完，外加两三行规范说明 —— 不是教学，也不是一张让用户自己去填的对照表。',
  '- 最终回复只有两部分：① 结果：已完成的改动 + 实测证据（资产路径、变更项、回读断言值）；② 规范：≤3 行，只讲这套写法照什么规则。其余内容一律删掉。',
  '- 判断标准：用户拿到回复后是「可以直接用了」，还是「还得自己干一遍」。',
  '- 动手前用 ≤4 行说明你要改什么，然后同一条回复里直接开始执行；不要写完说明就停下等确认。只有被工具真正拒绝时（例如写操作被审批挡下），才回头找用户。',
  '- 下面这些**不是**放弃执行的理由：你自己**推断**出来的「本轮不改任何资产」「我是只读模式」「工具已按白名单过滤」。工具列表里没看到某个工具，先实际调用一次再判断 —— 不要把猜测当成结论。',
  '- **但真实存在的策略边界必须服从。** 当会话确实运行在只读沙箱、工具确实被白名单挡下、或项目闸门未放行写入（当前工程不是被授权的那个）时，工具返回的 `read-only` / `not permitted` / 拒绝类错误**就是本轮结论本身**：如实报告它，不要换工具、换路径、换裸 Python 反射去绕。',
  '- 判断依据只有一条：**工具实际返回了什么**。返回拒绝 ⇒ 停下并说明；返回结果 ⇒ 继续做完。这两条不冲突，冲突时以工具返回为准。',
  '',
  '### 二、标准闭环（顺序固定）',
  '1. 定位 —— 先问编辑器「你现在选中的是什么」，不要猜：`mcp__unreal_inspector__get_unreal_context`（返回当前窗口、关卡、selected_assets），再用 `quicksearch` / `query_unreal_project_assets` 找资产。',
  '2. 读 —— `get_asset_meta`（变量/函数/事件/WidgetTree，用 `parts` 精确取）、`get_asset_graph`（连线与引脚）、`get_blueprint_properties_specifiers`（现有 Category/Tooltip/Description）。',
  '3. 加载对应技能 —— 见第四节，必须在动手前做。',
  '4. 改 —— 直接调用会写盘的工具。',
  '5. 回读验证 —— 用同一个只读工具把结果读回来，断言具体值，不要只说「已完成」。',
  '6. 报告 —— 结果 + ≤3 行规范，格式见第一节。',
  '- 给前自检：我真的动手改了吗（还是只产出了建议/说明/对照表）？被要求做 N 个对象我做满 N 个了吗？改完回读断言了吗？回复里有输出格式之外的内容吗？「做不到的原因」是这次实测的，还是我推断的（推断出来的限制不要写进回复）？',
  '- 允许「只给说明」的两种例外：用户明确说只要方案；或你实际调用后确证该工具不可用且没有替代工具（此时必须写明：调用了什么、报了什么错、因此改成什么做法）。',
  '- 只写实测过的 UE 行为。分不清就先花一次工具调用去试；必须给未验证的写法时必须标注「未验证」并说明怎么验证。',
  '',
  '### 三、动手前先备份（没有例外）',
  '- 改 UE 资产 / 文件前，先把要改的东西备份到 `<Eproject>/Saved/_AuraBackup/<yyyyMMdd_HHmmss>/`。`Saved/` 不被资产注册表扫描，所以备份不会污染 Content Browser。',
  '- 用 MCP 工具改资产时按资产路径备份：把工具返回的 `/Game/...` 软路径换成 `Content\\...` 磁盘路径；不确定是哪个资产就备份整个 `Content\\<子目录>`。',
  '- 备份是静默动作，不要为它写一段说明。只备份，不改引擎/插件原始文件；删除任何东西都要用户确认。',
  '',
  '### 四、按任务选对工具（下面这些坑都是真的）',
  '读取 / 定位（`unreal_inspector`，只读）：`get_unreal_context` | `quicksearch`、`query_unreal_project_assets` | `get_asset_meta` | `get_asset_graph` | `get_blueprint_properties_specifiers` | `get_actor_property_in_pie`、`survey_pie_scene` | `get_unreal_output_logs`。',
  '- `quicksearch` 会扫到引擎里其它工程；结果里的 `file_path` 若是磁盘路径，多半不是当前工程 —— 当前工程要用 `/Game/...` 形式的资产软路径。',
  '写入（`unreal_editor`）：`edit_blueprint`（蓝图变量/组件属性、Category/Tooltip）| **`bp_agent`**（逻辑/事件图、节点、引脚连线，走 C++ 校验路径）| `edit_structure` | `add_or_replace_rows_in_data_table`、`read_datatable_*` | `edit_widget` | `material_agent`、`vfx_agent` | `create_input_actions`、`add_input_action_to_mapping_context` | `compile_blueprint` | `execute_unreal_python`（写）、`execute_unreal_python_readonly`（读）。',
  '- 写蓝图变量 Category/Tooltip：`edit_blueprint` 的 `properties` 里若某属性只给名字、不给值，会以 `null` 提交并被拒（`refuses to auto-detect a type for a property whose value is null`）。必须给每个属性配 `type_hints`，并用 `specifiers` 传 `Category` / `Tooltip`；改完必须回读 `get_blueprint_properties_specifiers` 断言真的落盘了。`type_hints` 用 UE 类型串：`float` / `bool` / `Vector2D` / `struct:/Script/Engine.TimerHandle` / `object:/Game/...BP.BP_C`。',
  '- 函数图的 Description（Details 面板那个字段）不能靠 `set_blueprint_node_properties` 写 —— 它反射不到 `Description`；节点注释框（Comment）同理。两者都走 `bp_agent`，不要用裸 Python 去拼。',
  '- UE 5.8 明确踩过的坑：`unreal.BlueprintEditorLibrary` 的图/节点/引脚 API 在 5.8 被临时禁用直接 Python 调用（`list_graphs` / `find_*_pin` / `get_node_pos` / `get_nodes_in_comment` …）→ 改用 `bp_agent`（`set_blueprint_variable_category` 等变量级 API 仍可用）；`WidgetBlueprint.FunctionGraphs` 是 protected，只读探查可用下划线形式绕过（`g._Nodes`、`n._Description`、`n.VariableReference.MemberName`、`n.Pins`）；`unreal.KismetEditorUtilities` 在 Python 里不存在，`BlueprintEditorLibrary.get_all_graphs` 也没有；Aura 的只读 Python 沙箱禁用 `getattr` / `setattr`（`hasattr` / `dir` 可用）→ 写具体调用，别做动态反射。',
  '- 引擎**自带**的那条 MCP 行（默认 `http://127.0.0.1:8000/mcp`，端口可在引擎设置里改）可能报 `Unknown session id` —— 它是可选工具，失败就换用具体工具，不要卡在那里。',
  '- 资产路径大小写会被模糊纠正（截图里是 `WB_WidgetBaee`，真实资产同名不同大小写也能解析），不必强行「改正」。',
  '',
  '### 五、先加载技能，再动手（技能里有踩坑清单）',
  '- Enhanced Input → `fetch_enhanced_input_skill(skill_name="enhanced_input_guide")`；UMG/控件树 → `fetch_ui_best_practices()`；蓝图修改 → `fetch_blueprint_best_practices()`；材质 → `fetch_material_best_practices(category=...)`；Niagara → `fetch_niagara_best_practices()`（再按效果取 `fetch_niagara_skill`）；性能分析 → `fetch_performance_best_practices(skill_name="profiling_workflow")`；GAS → `fetch_gas_best_practices()`；时间轴 → `fetch_timeline_best_practices()`；Unreal Python → `fetch_python_best_practices()`；关卡/地形/PCG → `fetch_level_design_skill(skill_name=...)`。',
  '- Aura 的子代理（`bp_agent` / `material_agent` / `vfx_agent` / `level_design_agent` / `python_agent` / `verification_agent`）确实可用，但调用很重（会开自己的多轮循环，可能超时）：简单、单一、有专用工具能做的事直接调专用工具；只有「改图」这类没有更细粒度工具的事才交给 `bp_agent`。',
  '',
  '### 六、写注释 / 文档的风格（本项目已确立）',
  '- 变量：`Category` 用按职责分组的名字（`Panning`、`Runtime`、`Fade|Timing`）；`Tooltip` 写中文，说清「是什么 + 谁写它 + 用来干什么」。',
  '- 函数：`Description` 同样中文，写清触发时机与副作用。',
  '- 节点：用 Comment 框把一段有语义的流程框起来，标题用 `【】`，正文按「触发 → 做什么 → 为什么」三行写。',
  '- 颜色/风格跟随资产里已有的配置，不要另起一套。',
].join('\n')

/**
 * The rule markers this body must always contain. Exported so tests can assert the body
 * still covers every category of the source file (drift guard for the distillation).
 */
export const UE_WORKSPACE_MARKERS = [
  '交付物 = 结果 + 简短规范',
  '≤3 行',
  '标准闭环',
  '回读验证',
  '动手前先备份',
  '_AuraBackup',
  '按任务选对工具',
  'bp_agent',
  'UE 5.8',
  '先加载技能',
  '写注释 / 文档的风格',
]
