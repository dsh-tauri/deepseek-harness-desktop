# 插件管理面板

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/desktop/09-plugin-panel.e2e.ts`（待建立）
> 前置：`07-harness-lifecycle.md` 通过；配置对话框可打开在「插件」面板
> 运行：`vitest --project desktop -- test/e2e/desktop/09-plugin-panel.e2e.ts`（待配置，见 G2）

插件面板是「插件出问题时」的修复入口，同时承担禁用/启用/快照/还原/卸载。**所有写操作都会停掉并重新拉起服务**，因此每条写用例都必须独立复位到「服务健康 + 面板已打开」。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 列表真值来自 `get_dsh_plugins` 查询（与导航栏、配置角标共用缓存） | `src/ui/config/plugin.tsx:58-61` |
| 打开面板补一次 `refresh_plugin_updates`，插件变更时重探 | `src/ui/config/plugin.tsx:65-73` |
| 内置项排在列表前部 | `src/ui/config/plugin.tsx:427` |
| 标记：`内置`/`已禁用`/`配置覆盖禁用`/`预设`/版本号 | `src/ui/config/plugin.tsx:459-485` |
| 升级入口仅在 `updateAvailable \|\| error != null` 时渲染 | `src/ui/config/plugin.tsx:496-516` |
| 禁用入口仅在非内置且未禁用且无配置覆盖时渲染 | `src/ui/config/plugin.tsx:533-544` |
| 启用入口在配置覆盖禁用或桌面禁用清单时渲染 | `src/ui/config/plugin.tsx:519-532` |
| 快照入口对全部非内置插件常驻；还原/删除快照仅在有快照时渲染 | `src/ui/config/plugin.tsx:545-583` |
| 卸载前弹危险确认框，取消即中止 | `src/ui/config/plugin.tsx:197-215` |
| 配置覆盖禁用时启用前弹警告确认框 | `src/ui/config/plugin.tsx:248-271` |
| 快照已存在时覆盖前弹警告确认框 | `src/ui/config/plugin.tsx:286-307` |
| 写操作后统一 `store.harness.restart()` | `src/ui/config/plugin.tsx:190-194`、`:223-227`、`:242-245`、`:280-283` |
| 行内操作单例守卫 `busy` | `src/ui/config/plugin.tsx:82`、`:180-182` |
| 异常图标 + Tooltip 展示 `error.message` | `src/ui/config/plugin.tsx:433-455` |
| 空态 `Empty` | `src/ui/config/plugin.tsx:420-425` |
| 异常插件运行期上报入口 | `src/layout/components/iframe.tsx:142-154` |

---

## 2. 列表与标记

### [P1] 验证插件面板列出插件并标注内置项

[Case ID] TC-DSK-L3-062
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/config/plugin.tsx:58-61`、`:427-486`
[自动化] 待接线（`test/e2e/desktop/09-plugin-panel.e2e.ts`）
[前置条件] 应用处于 `ready`；已安装至少 1 个内置插件与 1 个非内置插件
[测试数据] 选择器 `dsh-plugin-row`、`dsh-plugin-row-builtin`
[测试步骤] 1. 打开「插件」面板。2. 读取插件行数量与名称。3. 读取带「内置」标记的行及其位置。
[预期结果] 1. 面板渲染完成。2. 行数量与 `get_dsh_plugins` 返回数量一致。3. 带「内置」标记的行与后端 `internal == true` 的条目一一对应，且内置项排在列表前部。
[清理] 关闭对话框；`DELETE /session/<id>`

### [P2] 验证空列表显示空态

[Case ID] TC-DSK-L3-063
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/config/plugin.tsx:420-425`
[自动化] 待接线（同上）
[前置条件] 当前档案下无任何插件
[测试数据] 选择器 `dsh-plugin-empty`
[测试步骤] 1. 打开「插件」面板。2. 读取空态节点与插件行数量。
[预期结果] 1. 面板渲染完成。2. 空态节点存在且文案非空；插件行数量为 0。
[清理] 恢复插件集合；关闭对话框；`DELETE /session/<id>`

### [P2] 验证仅在有更新或异常时显示升级入口

[Case ID] TC-DSK-L3-064
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/config/plugin.tsx:496-516`
[自动化] 待接线（同上）
[前置条件] 面板内同时存在「有更新」与「无更新且无异常」两类插件
[测试数据] 选择器 `dsh-plugin-upgrade`
[测试步骤] 1. 读取有更新插件行的升级入口存在性。2. 读取无更新且无异常插件行的升级入口存在性。
[预期结果] 1. 升级入口存在，且附带的版本文本不超过 40 字符时完整显示。2. 升级入口不存在（不常驻）。
[清理] 关闭对话框；`DELETE /session/<id>`

### [P4] 验证操作进行中同一时间仅允许一项

[Case ID] TC-DSK-L3-065
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/ui/config/plugin.tsx:82`、`:180-182`
[自动化] 待接线（同上）
[前置条件] 存在至少 2 个可操作的非内置插件
[测试数据] 触发：对插件 A 触发禁用，在未收敛时点击插件 B 的禁用入口
[测试步骤] 1. 对 A 触发禁用。2. 在 A 未收敛时点击 B 的禁用入口。3. 读取 B 是否进入进行中状态。
[预期结果] 1. A 进入进行中状态。2. B 的点击被忽略。3. B 未进入进行中状态，最终只有 A 的变更生效。
[清理] 恢复被禁用的插件；关闭对话框；`DELETE /session/<id>`

---

## 3. 写操作

### [P2] 验证禁用后可再次启用

[Case ID] TC-DSK-L3-066
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/config/plugin.tsx:230-284`、`:533-544`
[自动化] 待接线（同上）
[前置条件] 存在非内置、未禁用、无配置覆盖的插件；服务健康
[测试数据] 选择器 `dsh-plugin-disable`、`dsh-plugin-enable`、`dsh-plugin-row-disabled-badge`
[测试步骤] 1. 点击「禁用」。2. 等待列表刷新与服务重启。3. 读取该行的「已禁用」标签与入口。4. 点击「启用」并等待收敛。5. 再次读取该行。
[预期结果] 1. 点击被接受。2. 刷新与重启完成。3. 出现「已禁用」标签，行内入口变为「启用」。4. 启用被接受并收敛。5. 「已禁用」标签消失，入口恢复为「禁用」。
[清理] 恢复插件状态；关闭对话框；`DELETE /session/<id>`

### [P2] 验证插件操作后服务被重新拉起

[Case ID] TC-DSK-L3-067
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/config/plugin.tsx:190-194`、`:223-227`
[自动化] 待接线（同上）
[前置条件] 服务健康；存在可禁用插件
[测试数据] 无
[测试步骤] 1. 记录当前服务地址。2. 执行一次禁用操作。3. 等待收敛。4. 读取连接状态与服务地址。
[预期结果] 1. 记录成功。2. 操作完成。3. 收敛完成。4. 连接状态为运行中，服务地址与记录值一致（不残留「服务已死但界面显示运行中」）。
[清理] 恢复插件状态；关闭对话框；`DELETE /session/<id>`

### [P3] 验证卸载需确认且取消不生效

[Case ID] TC-DSK-L3-068
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/ui/config/plugin.tsx:197-228`
[自动化] 待接线（同上）
[前置条件] 存在非内置插件；服务健康
[测试数据] 选择器 `dsh-plugin-uninstall`；确认框取消按钮
[测试步骤] 1. 记录插件列表。2. 点击某非内置插件的「卸载」。3. 在确认框中取消。4. 等待稳定后再次读取插件列表。
[预期结果] 1. 记录成功。2. 确认框出现（危险语义）。3. 确认框关闭。4. 列表与记录一致（插件仍在，服务未被重启）。
[清理] 关闭对话框；`DELETE /session/<id>`

### [P3] 验证配置覆盖禁用的插件启用前弹确认

[Case ID] TC-DSK-L3-069
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/ui/config/plugin.tsx:248-271`；issue #399
[自动化] 待接线（同上）
[前置条件] 存在 `patchDisabled == true` 的插件（在 `cordis.patch.yml` 中被显式禁用）
[测试数据] 选择器 `dsh-plugin-patch-disabled-badge`、`dsh-plugin-enable`
[测试步骤] 1. 读取该行的「配置覆盖禁用」标签。2. 点击「启用」。3. 在确认框中取消。4. 读取该插件状态与 `cordis.patch.yml` 内容。
[预期结果] 1. 标签存在（内置插件同样标注）。2. 确认框出现（警告语义）。3. 确认框关闭。4. 插件仍为配置覆盖禁用态；`cordis.patch.yml` 未被改写。
[清理] 关闭对话框；`DELETE /session/<id>`

### [P3] 验证快照已存在时覆盖前弹确认

[Case ID] TC-DSK-L3-070
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/ui/config/plugin.tsx:286-318`
[自动化] 待接线（同上）
[前置条件] 存在非内置插件，且已创建过至少一次快照
[测试数据] 选择器 `dsh-plugin-snapshot`
[测试步骤] 1. 点击「快照」。2. 读取确认框存在性。3. 取消后读取该行入口集合。
[预期结果] 1. 确认框出现（覆盖语义）。2. 确认框标题为覆盖确认语义。3. 取消后行内仍保留「还原」「删除快照」入口。
[清理] 删除本次创建的快照；关闭对话框；`DELETE /session/<id>`

---

## 4. 异常插件

### [P3] [反向] 验证异常插件显示危险图标与错误详情

[Case ID] TC-DSK-L3-071
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/ui/config/plugin.tsx:433-455`；`src/layout/components/iframe.tsx:142-154`
[自动化] 待接线（同上）
[前置条件] 已构造带 `error` 字段的插件（可由 iframe 上报 `dsh://plugin-error` 构造）
[测试数据] 选择器 `dsh-plugin-abnormal`
[测试步骤] 1. 读取异常插件行的危险图标。2. 悬停读取提示内容。3. 读取该行的升级入口存在性。
[预期结果] 1. 危险图标存在。2. 提示内容包含插件名与后端返回的 `error.message` 原文。3. 升级入口存在（异常时提供修复入口）。
[清理] 清除构造的插件异常；关闭对话框；`DELETE /session/<id>`

---

## 5. 选择器契约（待补）

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-plugin-row` | 单个插件行 | 待补 |
| `dsh-plugin-row-builtin` | 「内置」标记 | 待补 |
| `dsh-plugin-row-disabled-badge` | 「已禁用」标签 | 待补 |
| `dsh-plugin-patch-disabled-badge` | 「配置覆盖禁用」标签 | 待补 |
| `dsh-plugin-abnormal` | 异常危险图标按钮 | 待补 |
| `dsh-plugin-upgrade` | 「升级」Chip | 待补 |
| `dsh-plugin-disable` | 「禁用」Chip | 待补 |
| `dsh-plugin-enable` | 「启用」Chip | 待补 |
| `dsh-plugin-snapshot` | 「快照」Chip | 待补 |
| `dsh-plugin-restore` | 「还原」Chip | 待补 |
| `dsh-plugin-delete-snapshot` | 「删除快照」Chip | 待补 |
| `dsh-plugin-uninstall` | 「卸载」Chip | 待补 |
| `dsh-plugin-empty` | 空态 | 待补 |

---

## 6. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 列表与标记 | 062、063、064 | 正向 | 「预设」标记（`recommended`）与版本号展示未单独覆盖 |
| 禁用 / 启用 | 066、067 | 正向 | 启用后的 bundles 生效由服务重启间接证明 |
| 卸载 | 068 | 异常 | 卸载成功路径**未覆盖**（会破坏后续用例的插件集合，需独立批次） |
| 配置覆盖禁用 | 069 | 异常 | 确认后的真实改写 `cordis.patch.yml` 路径**未覆盖** |
| 快照 / 还原 / 删除快照 | 070 | 异常 | 「还原」成功路径会停服务，**未覆盖**；「删除快照」成功路径**未覆盖** |
| 异常插件 | 071 | 异常 | 依赖 iframe 上报能力，见 `03` G-D03-1 |
| 单例约束 | 065 | 边界 | — |

---

## 7. 缺口与假设

- **G-D09-1**：本文件的写操作用例**全部会重启服务**，彼此强耦合。按 `progressive.md` 的「单批单卡」，接线时应一个用例一个批次推进，且每条用例自带「恢复插件状态 + 等待服务健康」的清理步骤。
- **G-D09-2**：多条成功路径未覆盖（卸载成功、还原成功、删除快照成功），原因是它们会不可逆地改变插件集合，破坏其他用例前置。需要独立的可写档案夹具（对应 `00-overview.md` G8）后再补。
- **G-D09-3**：`refresh_plugin_updates` 依赖 GitHub 探测（Rust 侧 30 分钟缓存）。TC-DSK-L3-064 需要「有更新」的插件，离线环境下不可达；此时应跳过该用例而非判失败。
- **假设**：插件操作后服务一定会被后端停止，因此前端在 `finally` 中统一 `restart()`（`plugin.tsx:190-194`）；TC-DSK-L3-067 正是对这一行为的断言。
