# 语言与主题

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/desktop/04-locale-theme.e2e.ts`（待建立）
> 前置：`03-config-dialog.md` 通过；配置对话框可打开在「应用」面板
> 运行：`vitest --project desktop -- test/e2e/desktop/04-locale-theme.e2e.ts`（待配置，见 G2）

语言与主题是壳层的两个全局状态。语言的写入有三条通路（`localStorage`、setting store、后端 `set_language`），主题的真值来自后端 `get_dsh_theme` 并由系统偏好折算。本文件验证**即时生效**与**跨重启持久化**两条主线。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 语言持久化 key `deepseek-harness-desktop-language` | `src/i18n/index.detector.ts:7` |
| 探测优先级：localStorage → setting store → 浏览器语言 | `src/i18n/index.detector.ts:12-32` |
| 切换语言写入 localStorage + store + `set_language` | `src/i18n/index.detector.ts:34-40` |
| i18n 使用扁平 dot-notation key（禁用嵌套解析） | `src/i18n/index.ts:19-20` |
| 语言下拉：`selectedKey={i18n.language}`，选项 `zh-CN`/`en-US` | `src/ui/config/debug.tsx:355-372` |
| 主题偏好来源 `get_dsh_theme`（`dark`/`light`/`system`） | `src/hooks/use-theme-adaptive.ts:6` |
| `system` 时按 `usePreferredDark` 折算，写入 `document.documentElement.dataset.theme` | `src/hooks/use-theme-adaptive.ts:8-14` |
| 主题自适应在壳层根组件挂载 | `src/layout/index.tsx:48` |
| iframe 重建只由 `harness.iframeKey` 驱动 | `src/layout/components/iframe.tsx:192-193` |

---

## 2. 语言切换

### [P1] 验证语言切换为 English 后壳层文案即时变更

[Case ID] TC-DSK-L3-025
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] 批次 04；`src/ui/config/debug.tsx:355-372`；`src/i18n/index.ts:9-21`
[自动化] 待接线（`test/e2e/desktop/04-locale-theme.e2e.ts`）
[前置条件] 应用处于 `ready`；配置对话框已打开在「应用」面板；当前语言为 `zh-CN`
[测试数据] 目标语言 `en-US`；观察点 `dsh-navbar-menu-config` 的无障碍标签
[测试步骤] 1. 读取观察点标签。2. 在语言下拉中选择 `en-US`。3. 再次读取同一标签。4. 读取语言下拉当前值。
[预期结果] 1. 标签为中文文案。2. 选择被接受。3. 标签变为英文文案（不刷新页面即生效）。4. 当前值为 `en-US`。
[清理] 切回 `zh-CN`；关闭对话框；`DELETE /session/<id>`

### [P2] 验证语言选择在重启后保持

[Case ID] TC-DSK-L3-026
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/i18n/index.detector.ts:14`、`:34-40`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-025 已把语言切到 `en-US`
[测试数据] 观察点 `dsh-navbar-menu-config` 的无障碍标签
[测试步骤] 1. 关闭应用并等待进程退出。2. 重新拉起应用。3. 等待壳层渲染完成。4. 读取观察点标签。
[预期结果] 1. 进程退出。2. 启动成功。3. 壳层渲染完成。4. 标签仍为英文文案（语言未被重置为系统语言）。
[清理] 切回 `zh-CN`；`DELETE /session/<id>`

### [P2] 验证切换语言后菜单与提示文案同步为同一语言

[Case ID] TC-DSK-L3-027
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/i18n/index.ts:19`；`src/layout/components/navbar.tsx:82-87`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-025 通过（语言为 `en-US`）
[测试数据] 观察点：`dsh-navbar-menu-file`、`dsh-navbar-menu-config`、`dsh-navbar-menu-help` 的文本
[测试步骤] 1. 读取三个菜单触发器文本。2. 逐项断言语言一致性。
[预期结果] 1. 读取成功。2. 三者均为英文文案，无任一项残留中文。
[清理] 切回 `zh-CN`；`DELETE /session/<id>`

### [P4] 验证两种语言下壳层关键文案均非空

[Case ID] TC-DSK-L3-028
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `docs/specs/agents.desktop.md` §3.1「i18n 规范」
[自动化] 待接线（同上）
[前置条件] 应用处于 `ready`
[测试数据] 观察点：三个菜单触发器 + 配置对话框四个导航项（共 7 个）
[测试步骤] 1. 在 `zh-CN` 下读取全部观察点文本。2. 切换到 `en-US` 后再次读取。3. 逐项断言非空且不含原始 key。
[预期结果] 1. 读取成功。2. 读取成功。3. 全部观察点文本均非空，且不出现形如 `menu.file` 的原始 i18n key。
[清理] 切回 `zh-CN`；关闭对话框；`DELETE /session/<id>`

---

## 3. 主题

### [P2] 验证主题偏好被折算并应用到根节点

[Case ID] TC-DSK-L3-029
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/hooks/use-theme-adaptive.ts:6-14`
[自动化] 待接线（同上）
[前置条件] 应用处于 `ready`
[测试数据] 观察点 `document.documentElement.dataset.theme`；期望值域 `dark` / `light`
[测试步骤] 1. 读取根节点 `data-theme`。2. 读取 `get_dsh_theme` 返回值。3. 比对两者（`system` 时按 `usePreferredDark` 折算）。
[预期结果] 1. 读到非空值。2. 读到合法偏好值。3. 两者一致；取值属于 `dark` / `light`。
[清理] `DELETE /session/<id>`

### [P3] [反向] 验证语言切换不重建 iframe

[Case ID] TC-DSK-L3-030
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/layout/components/iframe.tsx:192-193`（`key={harness.iframeKey}`）
[自动化] 待接线（同上）
[前置条件] 应用处于 `ready`，iframe 已加载完成
[测试数据] 观察点：iframe 元素的 `src` 与实例标识
[测试步骤] 1. 记录 iframe 的 `src` 与实例标识。2. 切换语言。3. 等待壳层重渲染完成。4. 再次记录同一观察点。
[预期结果] 1. 记录成功。2. 切换成功。3. 重渲染完成。4. `src` 与实例标识均未变化（语言切换不触发 iframe 重载，不丢失会话状态）。
[清理] 切回 `zh-CN`；`DELETE /session/<id>`

---

## 4. 选择器契约（待补）

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-config-language-select` | 「应用」面板语言下拉 | 待补 |
| `dsh-shell-iframe` | `src/layout/components/iframe.tsx` 的 `iframe` | 待补 |

---

## 5. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 语言即时生效 | 025、027 | 正向 | 只断言壳层文案；iframe 内 DSH 界面语言未覆盖 |
| 语言持久化三通路 | 026 | 边界 | `localStorage` 与后端 `set_language` 未分别断言，只验证最终可观察结果 |
| i18n key 完整性 | 028 | 边界 | 只抽查 7 个观察点，全量 key 覆盖属单元测试职责 |
| 主题折算与应用 | 029 | 正向 | 视觉回归（配色是否正确）**未覆盖** |
| iframe 不因语言重载 | 030 | 异常 | — |

---

## 6. 缺口与假设

- **G-D04-1**：主题只断言 `document.documentElement.dataset.theme`，**不覆盖视觉回归**（同一 `data-theme` 下的配色是否正确）。若需覆盖，应引入截图基线，属 `visual-regression-testing` 范畴。
- **G-D04-2**：语言切换会同时写 `localStorage`、setting store 与后端 `set_language`。本文件只验证「重启后仍生效」这一端到端结果，未分别验证三条通路各自成功；若需定位「重启后语言丢失」的根因，需补三条通路的分项断言。
- **G-D04-3**：`system` 主题分支需要真实切换操作系统主题（Windows 应用主题设置），当前不构造该环境，**未覆盖**。
- **假设**：系统语言为中文时缺省语言为 `zh-CN`（`index.detector.ts:24`）；英文环境下缺省为 `en-US`，用例的前置需按执行机语言调整。
