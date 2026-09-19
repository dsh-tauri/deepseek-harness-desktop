# 插件异常修复

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/specs/desktop/10-plugin-recovery.e2e.ts`（待建立）
> 前置：`09-plugin-panel.md` 通过；可构造插件异常态
> 运行：`vitest --project desktop -- test/e2e/specs/desktop/10-plugin-recovery.e2e.ts`（待配置，见 G2）

插件异常分两种呈现：**启动崩溃**走全屏恢复页（替换错误页内容），**运行期异常**走醒目对话框（不阻断使用）。本文件验证两者的区分、原因映射、以及三条恢复动作。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| `status === 'error' && recovery.required` → `Recovery fullScreen`，否则 `Setup` | `src/layout/components/webview.tsx:50-55` |
| `status === 'ready'` 时渲染运行期 `Recovery` 对话框 | `src/layout/index.tsx:149-152` |
| 全屏页根容器与半透明面板 | `src/ui/plugin/recovery.tsx:86-99` |
| 运行期对话框根容器（遮罩 + 实心面板） | `src/ui/plugin/recovery.tsx:86-99` |
| 失败原因 → i18n key 映射（8 类 + `unknown`） | `src/ui/plugin/recovery.tsx:13-22` |
| 单/多插件标题与按钮文案分支 | `src/ui/plugin/recovery.tsx:71-81` |
| 问题插件 id 列表 + 「问题插件」标记 | `src/ui/plugin/recovery.tsx:114-123` |
| 原始错误区块（空时显示 `—`） | `src/ui/plugin/recovery.tsx:131-136` |
| 快照检测：仅对有快照的 id 显示「从快照还原」 | `src/ui/plugin/recovery.tsx:45-64`、`:141-152` |
| 卸载动作 `recoverAndRedetect` | `src/ui/plugin/recovery.tsx:153-162` |
| 还原动作 `restoreAndRedetect` | `src/ui/plugin/recovery.tsx:145` |
| 「重启」「安全模式」「暂不处理」 | `src/ui/plugin/recovery.tsx:163-174` |
| 恢复耗尽提示 | `src/ui/plugin/recovery.tsx:125-127` |
| 安全模式动作 | `src/store/modules/harness/store.ts:669` |
| 快照查询 `get_plugin_backup` | `src/ui/plugin/recovery.tsx:51` |
| 开发期预览快捷键（仅 DEV） | `src/layout/index.tsx:50-78` |

---

## 2. 呈现与信息

### [P1] 验证启动崩溃时渲染全屏恢复页

[Case ID] TC-DSK-L3-072
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/webview.tsx:50-55`；`src/ui/plugin/recovery.tsx:86-99`
[自动化] 待接线（`test/e2e/specs/desktop/10-plugin-recovery.e2e.ts`）
[前置条件] 构造使服务启动失败且 `recovery.required` 为真的插件（如 UI 槽位冲突）
[测试数据] 选择器 `dsh-recovery-root`、`dsh-recovery-fullscreen`
[测试步骤] 1. 拉起应用并等待进入 `error`。2. 读取恢复页根节点与其全屏标记。3. 读取 `Setup` 错误内容是否存在。
[预期结果] 1. 进入 `error` 状态。2. 根节点存在；全屏标记为真。3. `Setup` 错误内容不存在（被替换而非叠加）。
[清理] 移除问题插件；`DELETE /session/<id>`

### [P2] 验证恢复页列出问题插件与原因标题

[Case ID] TC-DSK-L3-073
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/plugin/recovery.tsx:13-22`、`:100-136`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-072 通过
[测试数据] 选择器 `dsh-recovery-plugin-id`、`dsh-recovery-reason`、`dsh-recovery-raw-error`
[测试步骤] 1. 读取插件 id 列表。2. 读取原因标题。3. 读取原始错误区块。
[预期结果] 1. id 列表与后端上报的 `info.plugins` 完全一致，每项带「问题插件」标记。2. 原因标题与 `info.reason` 对应的文案一致且非空。3. 原始错误区块内容等于 `info.rawError`（为空时显示 `—`）。
[清理] 移除问题插件；`DELETE /session/<id>`

### [P2] 验证「暂不处理」关闭运行期对话框

[Case ID] TC-DSK-L3-074
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/plugin/recovery.tsx:172-174`；`src/layout/index.tsx:149-152`
[自动化] 待接线（同上）
[前置条件] 应用仍处于 `ready`，且已构造运行期插件异常（对话框而非全屏页）
[测试数据] 选择器 `dsh-recovery-dismiss`
[测试步骤] 1. 读取对话框可见性。2. 点击「暂不处理」。3. 再次读取可见性。4. 读取 iframe 存在性。
[预期结果] 1. 对话框可见。2. 点击被接受。3. 对话框不可见。4. iframe 仍存在（应用未被卸载或阻断）。
[清理] 清除插件异常；`DELETE /session/<id>`

### [P4] 验证恢复次数耗尽时显示提示

[Case ID] TC-DSK-L3-075
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/ui/plugin/recovery.tsx:125-127`
[自动化] 待接线（同上）
[前置条件] 构造 `exhausted == true` 的恢复态（连续恢复后仍失败）
[测试数据] 选择器 `dsh-recovery-exhausted`
[测试步骤] 1. 读取耗尽提示节点。2. 读取恢复动作入口是否仍可用。
[预期结果] 1. 节点存在且文案非空，提示恢复次数已用尽。2. 卸载与重启入口仍可用（不因耗尽而锁死）。
[清理] 移除问题插件；`DELETE /session/<id>`

---

## 3. 恢复动作

### [P2] 验证「卸除此插件并继续检测」后重新检测

[Case ID] TC-DSK-L3-076
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/plugin/recovery.tsx:153-162`；`src/store/modules/recovery/store.ts`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-072 通过
[测试数据] 选择器 `dsh-recovery-remove`
[测试步骤] 1. 点击「卸除此插件并继续检测」。2. 读取按钮进行中文案。3. 等待收敛。4. 读取恢复页可见性与问题插件列表。
[预期结果] 1. 点击被接受。2. 文案切换为「正在卸载」语义。3. 收敛完成。4. 恢复页消失或刷新为新的问题插件集合（不再显示已卸载插件）。
[清理] `DELETE /session/<id>`

### [P3] 验证仅对有快照的插件提供「从快照还原」

[Case ID] TC-DSK-L3-077
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/ui/plugin/recovery.tsx:45-64`、`:141-152`；issue #303
[自动化] 待接线（同上）
[前置条件] 恢复信息包含 2 个插件，其中恰有 1 个存在快照
[测试数据] 选择器 `dsh-recovery-restore`
[测试步骤] 1. 读取「从快照还原」按钮存在性。2. 点击后读取还原动作的入参集合。
[预期结果] 1. 按钮存在。2. 入参集合仅包含确有快照的那个插件 id（不含无快照插件，避免 `SNAPSHOT_NOT_FOUND` 导致整体失败）。
[清理] 清除插件异常；`DELETE /session/<id>`

### [P4] 验证安全模式入口可用

[Case ID] TC-DSK-L3-078
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/ui/plugin/recovery.tsx:166-171`；`src/store/modules/harness/store.ts:669`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-072 通过
[测试数据] 选择器 `dsh-recovery-safe-mode`
[测试步骤] 1. 点击「安全模式」。2. 等待服务启动收敛。3. 读取服务状态与插件列表。
[预期结果] 1. 点击被接受。2. 收敛完成。3. 服务健康；第三方插件未挂载（最小预设生效）。
[清理] 退出安全模式；`DELETE /session/<id>`

---

## 4. 选择器契约（待补）

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-recovery-root` | 恢复界面根节点 | 待补 |
| `dsh-recovery-fullscreen` | 全屏恢复页标记 | 待补 |
| `dsh-recovery-plugin-id` | 问题插件 id 行 | 待补 |
| `dsh-recovery-reason` | 原因标题 | 待补 |
| `dsh-recovery-raw-error` | 原始错误区块 | 待补 |
| `dsh-recovery-restore` | 「从快照还原」按钮 | 待补 |
| `dsh-recovery-remove` | 「卸除此插件并继续检测」按钮 | 待补 |
| `dsh-recovery-restart` | 「重启」按钮 | 待补 |
| `dsh-recovery-safe-mode` | 「安全模式」按钮 | 待补 |
| `dsh-recovery-dismiss` | 「暂不处理」按钮 | 待补 |
| `dsh-recovery-exhausted` | 恢复耗尽提示 | 待补 |

---

## 5. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 全屏页 vs 对话框的区分 | 072、074 | 正向 | 区分条件（`status` 与 `recovery.required`）已覆盖；两者同时为真时的优先级未覆盖 |
| 原因映射（8 类） | 073 | 正向 | 只覆盖 1 类原因；其余 7 类（`duplicate_route`/`duplicate_loader_entry`/`cannot_resolve_bundle`/`no_dsh_bundle`/`slot_conflict`/`load_failed`/`runtime`）需各自构造，**未覆盖** |
| 多插件分支 | 077 | 异常 | 单/多插件文案分支只覆盖多插件场景 |
| 快照还原 | 077 | 异常 | 还原成功路径未覆盖（会停服务） |
| 卸载并重检测 | 076 | 正向 | — |
| 安全模式 | 078 | 边界 | 与 `11` 的 TC-DSK-L3-086 同源，属有意重复的入口差异（恢复页 vs 错误页） |
| 恢复耗尽 | 075 | 边界 | 需连续恢复失败的构造能力 |

---

## 6. 缺口与假设

- **G-D10-1**：开发期预览快捷键（`Ctrl+Shift+1/2`，`src/layout/index.tsx:50-78`）可在 DEV 构建下注入受控的恢复态。**接线时应优先使用该入口**构造 `slot_conflict` 与 `duplicate_loader_entry` 两类原因，避免依赖真实损坏插件；但需注意它仅在 `import.meta.env.DEV` 下生效。
- **G-D10-2**：8 类失败原因只覆盖 1 类。其余原因的构造需要真实制造对应故障（路由重复、bundle 解析失败、槽位冲突等），成本高，登记为已知盲区。
- **G-D10-3**：`restoreAndRedetect` 的**成功路径**未覆盖（还原会停服务并需要重启）。仅覆盖「入参按快照存在性过滤」这一关键正确性点（issue #303 的修复目标）。
- **假设**：`recovery.required` 与 `recovery.info` 同时为真时组件才渲染（`src/ui/plugin/recovery.tsx:66-68`）；部分为真时返回 `null`，本套未单独覆盖该分支。
