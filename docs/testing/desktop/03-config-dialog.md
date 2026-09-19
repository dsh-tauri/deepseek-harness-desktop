# 配置对话框

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/specs/desktop/03-config-dialog.e2e.ts`（待建立）
> 前置：`02-shell-navigation.md` 通过；应用处于 `ready`
> 运行：`vitest --project desktop -- test/e2e/specs/desktop/03-config-dialog.e2e.ts`（待配置，见 G2）

配置对话框是四个面板（应用 / 档案 / 插件 / 核心）的唯一容器，`04`–`16` 的多数用例都以「对话框已打开在某个面板」为前置。本文件只验证**容器的行为**，各面板的内部行为归各自文件。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| `ConfigTab` 值域 `application`/`profiles`/`plugins`/`harness` | `src/ui/dialog/config.tsx:20` |
| 打开时定位面板来自 `props.tab`，缺省 `application` | `src/ui/dialog/config.tsx:45` |
| 导航项顺序：应用 / 档案 / 插件 / 核心 | `src/ui/dialog/config.tsx:38-43` |
| 面板由 `Switch`/`Case` 按 `activeTab` 渲染 | `src/ui/dialog/config.tsx:88-101` |
| 对话框尺寸 `w-[800px]`，上限 `calc(100vw-48px)` × `min(720px, calc(100vh-96px))` | `src/ui/dialog/config.tsx:54` |
| 关闭触发器 `Modal.CloseTrigger`；`onOpenChange` 走 `disclosure.cancel` | `src/ui/dialog/config.tsx:51`、`:55` |
| 异常插件角标 = `plugins.filter(p => p.error != null).length` | `src/ui/dialog/config.tsx:36`、`:77-81` |
| 命令式收起钩子 `config.dialog.hidden` | `src/ui/dialog/config.tsx:48`、`src/config/hooks.ts` |
| 导航栏「配置」菜单直接传入 `tab` | `src/layout/components/navbar.tsx:269-271`、`:444-454` |

---

## 2. 打开、定位与切换

### [P1] 验证「配置 → 应用」打开对话框并默认定位「应用」面板

[Case ID] TC-DSK-L3-018
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] 批次 03；`src/ui/dialog/config.tsx:45`、`:51`
[自动化] 待接线（`test/e2e/specs/desktop/03-config-dialog.e2e.ts`）
[前置条件] 对话框当前未打开
[测试数据] 选择器 `dsh-config-dialog`、`dsh-config-nav-application`、`dsh-config-panel-title`
[测试步骤] 1. 点击导航栏「配置」并选择「应用」。2. 读取对话框可见性。3. 读取「应用」导航项选中态。4. 读取当前面板标题。
[预期结果] 1. 菜单项被点击。2. 对话框存在且可见。3. 「应用」导航项为选中态，其余三项非选中。4. 面板标题为「应用」面板标题且非空。
[清理] 关闭对话框；`DELETE /session/<id>`

### [P2] 验证左侧导航可切换四个面板

[Case ID] TC-DSK-L3-019
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/dialog/config.tsx:38-43`、`:64-84`、`:88-101`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-018 通过
[测试数据] 四个导航项：`application`、`profiles`、`plugins`、`harness`
[测试步骤] 1. 依次点击四个导航项。2. 每次点击后读取选中态与面板标题。
[预期结果] 1. 四次点击均被接受。2. 每次只有被点击项为选中态。3. 面板标题与导航项一一对应。
[清理] 关闭对话框；`DELETE /session/<id>`

### [P2] 验证从导航栏直接定位到指定面板

[Case ID] TC-DSK-L3-020
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/navbar.tsx:269-271`、`:444-454`；`src/ui/dialog/config.tsx:45`
[自动化] 待接线（同上）
[前置条件] 对话框当前未打开
[测试数据] 目标面板 `profiles`；其余三个面板各执行一次
[测试步骤] 1. 点击导航栏「配置 → 档案」。2. 读取对话框可见性与当前面板标题。3. 对 `plugins`、`harness`、`application` 重复步骤 1–2。
[预期结果] 1. 每次菜单项被点击。2. 每次对话框可见且直接定位到目标面板（不先经过「应用」面板）。
[清理] 关闭对话框；`DELETE /session/<id>`

---

## 3. 关闭与收起

### [P2] 验证关闭触发器关闭对话框

[Case ID] TC-DSK-L3-021
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/dialog/config.tsx:51`、`:55`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-018 通过
[测试数据] 关闭触发器 `dsh-config-dialog-close`
[测试步骤] 1. 点击关闭触发器。2. 等待对话框消失。3. 再次点击导航栏「配置 → 应用」。
[预期结果] 1. 触发器被点击。2. 对话框在超时内不可见。3. 对话框可再次打开，且默认仍定位「应用」（不残留上次面板）。
[清理] 关闭对话框；`DELETE /session/<id>`

### [P3] 验证服务重启前对话框被命令式收起

[Case ID] TC-DSK-L3-022
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/ui/dialog/config.tsx:48`；`src/config/hooks.ts`（`config.dialog.hidden`）
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-018 通过；服务处于运行中
[测试数据] 触发源：服务重启流程
[测试步骤] 1. 确认对话框可见。2. 在「应用」面板点击「重启」触发服务重启。3. 等待重启流程启动后读取对话框可见性。
[预期结果] 1. 对话框可见。2. 重启被触发。3. 对话框已收起（不可见），无需用户手动关闭。
[清理] 等待服务恢复健康；`DELETE /session/<id>`

---

## 4. 角标与边界

### [P3] 验证存在异常插件时「插件」导航显示角标数量

[Case ID] TC-DSK-L3-023
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/ui/dialog/config.tsx:36`、`:77-81`；issue #399
[自动化] 待接线（同上）
[前置条件] 已构造至少 1 个带 `error` 字段的插件（可由运行期插件异常上报构造，见 `09`）
[测试数据] 异常插件数量 `N`（N ≥ 1）
[测试步骤] 1. 确认插件列表中 `error != null` 的条目数为 N。2. 打开配置对话框。3. 读取「插件」导航项的角标文本。4. 读取其余三项的角标存在性。
[预期结果] 1. 确认为 N。2. 对话框打开。3. 角标存在且文本等于 `N`。4. 其余三项不存在角标。
[清理] 清除构造的插件异常；关闭对话框；`DELETE /session/<id>`

### [P4] 验证对话框尺寸不超出视口

[Case ID] TC-DSK-L3-024
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/ui/dialog/config.tsx:54`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-018 通过
[测试数据] 期望上限 = 视口宽 − 48px、视口高 − 96px（按当前视口实测）
[测试步骤] 1. 读取视口尺寸。2. 读取对话框边界矩形。3. 把窗口缩到最小尺寸后重复步骤 1–2。
[预期结果] 1. 读取成功。2. 宽不超过视口宽减 48px，高不超过视口高减 96px。3. 最小窗口下仍满足该上限且对话框内部可滚动。
[清理] 恢复窗口尺寸；关闭对话框；`DELETE /session/<id>`

---

## 5. 选择器契约（待补）

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-config-dialog` | `Modal.Dialog` 根节点 | 待补 |
| `dsh-config-dialog-close` | `Modal.CloseTrigger` | 待补 |
| `dsh-config-nav-application` | 左侧「应用」导航项 | 待补 |
| `dsh-config-nav-profiles` | 左侧「档案」导航项 | 待补 |
| `dsh-config-nav-plugins` | 左侧「插件」导航项 | 待补 |
| `dsh-config-nav-harness` | 左侧「核心」导航项 | 待补 |
| `dsh-config-nav-plugins-badge` | 「插件」导航项角标 | 待补 |
| `dsh-config-panel-title` | 当前面板标题 | 待补 |

---

## 6. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `props.tab` 定位语义 | 018、020 | 正向 | 未传入 `tab` 时的缺省行为由 018 覆盖 |
| 四面板切换 | 019 | 正向 | 各面板内容归 `04`/`05`/`09`/`14` |
| 关闭路径 | 021 | 正向 | 点击遮罩关闭、Esc 关闭未单独覆盖（同一 `disclosure.cancel` 通路） |
| `config.dialog.hidden` 命令式收起 | 022 | 异常 | 仅覆盖「重启」触发源；「退出」触发源未覆盖 |
| 异常角标 | 023 | 异常 | 依赖 `09` 的异常构造能力 |
| 尺寸上限 | 024 | 边界 | 视觉溢出（内容裁切）不做像素级回归 |

---

## 7. 缺口与假设

- **G-D03-1**：TC-DSK-L3-023 依赖「带 `error` 字段的插件」这一夹具。当前唯一可用的构造路径是让 iframe 上报 `dsh://plugin-error`（`src/layout/components/iframe.tsx:142-154`），需要 iframe 环境可用；若不可用，该用例应标记为未接线。
- **G-D03-2**：关闭路径有多条（关闭触发器、遮罩点击、Esc、`onOpenChange`），本文件只覆盖关闭触发器。其余三条走同一 `disclosure.cancel` 通路，按「等价候选合并」不重复建用例；若后续发现行为分叉，再拆。
- **G-D03-3**：对话框内部滚动条的可用性未覆盖（需要构造内容高度超过 `min(720px, 100vh-96px)` 的面板状态）。
- **假设**：`Modal` 的 `onOpenChange` 在 Esc 与遮罩点击时都会触发 `cancel`；该假设来自 HeroUI Modal 的通用行为，未在源码中逐行确认。
