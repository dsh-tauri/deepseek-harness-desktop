# 壳层导航栏

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/specs/desktop/02-shell-navigation.e2e.ts`（待建立）
> 前置：`01-window-boot.md` 通过
> 运行：`vitest --project desktop -- test/e2e/specs/desktop/02-shell-navigation.e2e.ts`（待配置，见 G2）

导航栏是本应用唯一常驻的壳层控件，同时承担窗口控制与三个下拉菜单。本文件的重点是**条件渲染的正确性**：依赖 iframe 或插件状态的入口在接收方缺席时必须消失或禁用，而不是留一个点了没反应的死按钮。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 导航栏根元素与 44px 高度 | `src/layout/components/navbar.tsx:344-356` |
| 「文件」菜单项 id：`new-window`/`new-chat`/`open-folder`/`close`/`quit` | `src/layout/components/navbar.tsx:389-430` |
| 「配置」菜单项来自 `CONFIG_TABS`（`application`/`profiles`/`plugins`/`harness`） | `src/layout/components/navbar.tsx:82-87`、`:444-454` |
| 「帮助」菜单项 id：`copy-run-logs`/`check-update`/`about`/`documentation` | `src/layout/components/navbar.tsx:470-506` |
| 侧边栏开关仅在 `onToggleSidebar != null && tauriEnabled` 时渲染 | `src/layout/components/navbar.tsx:357` |
| `tauriEnabled` 判定：插件列表含 `dsh-tauri` | `src/layout/components/navbar.tsx:70`、`:173` |
| 「新聊天」「打开文件夹」在回调缺席时 `isDisabled` | `src/layout/components/navbar.tsx:400`、`:410` |
| 折叠状态来自 iframe 桥消息 `dsh://sidebar:collapsed` | `src/layout/components/webview.tsx:41-45` |
| 侧边栏切换向 iframe 发 `dsh://sidebar:toggle` | `src/layout/components/webview.tsx:70` |
| 拖拽区带 `data-tauri-drag-region`，非 macOS 双击切换最大化 | `src/layout/components/navbar.tsx:190-194`、`:519-524` |
| macOS 原生全屏时整条导航栏 `hidden` | `src/layout/components/navbar.tsx:97-143`、`:349` |
| macOS 上「文件」「帮助」不渲染（由原生菜单承载） | `src/layout/components/navbar.tsx:373`、`:543` |
| macOS 原生菜单事件 `macos-menu-action` 复用壳层操作 | `src/layout/components/navbar.tsx:310-342` |

---

## 2. 菜单结构

### [P1] 验证导航栏根容器与三个菜单按钮存在

[Case ID] TC-DSK-L3-009
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] 批次 02；`src/layout/components/navbar.tsx:344-510`
[自动化] 待接线（`test/e2e/specs/desktop/02-shell-navigation.e2e.ts`）
[前置条件] 应用已进入 `ready`；平台非 macOS
[测试数据] 选择器 `dsh-navbar-root`、`dsh-navbar-menu-file`、`dsh-navbar-menu-config`、`dsh-navbar-menu-help`
[测试步骤] 1. 读取导航栏根容器。2. 依次读取三个菜单触发器。
[预期结果] 1. 根容器存在且可见。2. 三个菜单触发器均存在且可见。
[清理] `DELETE /session/<id>`

### [P2] 验证「配置」菜单包含四个面板入口

[Case ID] TC-DSK-L3-010
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/navbar.tsx:82-87`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-009 通过
[测试数据] 期望 id 顺序：`application`、`profiles`、`plugins`、`harness`
[测试步骤] 1. 点击「配置」。2. 读取菜单项 id 集合与文本集合。
[预期结果] 1. 菜单展开。2. id 集合与顺序等于期望值。3. 文本为「应用」「档案」「插件」「核心」。
[清理] `DELETE /session/<id>`

### [P2] 验证「帮助」菜单包含四个入口

[Case ID] TC-DSK-L3-011
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/navbar.tsx:459-509`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-009 通过
[测试数据] 期望 id 顺序：`copy-run-logs`、`check-update`、`about`、`documentation`
[测试步骤] 1. 点击「帮助」。2. 读取菜单项 id 集合。
[预期结果] 1. 菜单展开。2. id 集合与顺序等于期望值。
[清理] `DELETE /session/<id>`

### [P2] 验证「文件」菜单包含五个入口

[Case ID] TC-DSK-L3-012
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/navbar.tsx:378-433`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-009 通过
[测试数据] 期望 id 顺序：`new-window`、`new-chat`、`open-folder`、`close`、`quit`
[测试步骤] 1. 点击「文件」。2. 读取菜单项 id 集合。
[预期结果] 1. 菜单展开。2. id 集合与顺序等于期望值。
[清理] `DELETE /session/<id>`

---

## 3. 依赖状态的条件渲染

### [P2] 验证侧边栏折叠图标随 iframe 回报切换

[Case ID] TC-DSK-L3-013
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/webview.tsx:41-45`；`src/layout/components/navbar.tsx:357-372`
[自动化] 待接线（同上）
[前置条件] 当前档案已安装 `dsh-tauri`；应用处于 `ready`
[测试数据] 桥消息 `dsh://sidebar:collapsed`，`collapsed` 依次取 `false`、`true`
[测试步骤] 1. 由 iframe 侧回报 `collapsed=false`，读取开关的无障碍标签。2. 回报 `collapsed=true`，再次读取。
[预期结果] 1. 标签为「收起侧边栏」语义。2. 标签切换为「展开侧边栏」语义，图标随之变化。
[清理] 复位 `collapsed=false`；`DELETE /session/<id>`

### [P3] [反向] 验证 dsh-tauri 未安装时侧边栏开关不渲染

[Case ID] TC-DSK-L3-014
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/layout/components/navbar.tsx:173`、`:356`
[自动化] 待接线（同上）
[前置条件] 当前档案未安装 `dsh-tauri`；应用处于 `ready`
[测试数据] 选择器 `dsh-navbar-sidebar-toggle`
[测试步骤] 1. 确认插件列表中不含 `dsh-tauri`。2. 读取侧边栏开关节点。
[预期结果] 1. 列表中确实不含 `dsh-tauri`。2. 开关节点不存在（无死按钮）。
[清理] 恢复插件状态（若测试改动了档案）；`DELETE /session/<id>`

### [P3] [反向] 验证无 iframe 接收方时依赖项禁用

[Case ID] TC-DSK-L3-015
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/layout/components/navbar.tsx:400`、`:410`；`src/layout/components/webview.tsx:68-73`
[自动化] 待接线（同上）
[前置条件] 应用处于 `preinstall`（无 iframe 回调），导航栏仍渲染
[测试数据] 菜单项 `new-chat`、`open-folder`
[测试步骤] 1. 打开「文件」菜单。2. 读取两项的禁用状态。
[预期结果] 1. 菜单展开。2. 两项均为禁用状态。
[清理] 结束引导页（跳过或确认）以恢复环境；`DELETE /session/<id>`

---

## 4. 拖拽区与平台差异

### [P4] 验证拖拽区双击切换最大化（非 macOS）

[Case ID] TC-DSK-L3-016
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/layout/components/navbar.tsx:190-194`、`:519-524`
[自动化] 待接线（同上）
[前置条件] 平台为 Windows 或 Linux；窗口当前非最大化
[测试数据] 拖拽区选择器 `dsh-navbar-drag-region`
[测试步骤] 1. 读取最大化状态。2. 双击拖拽区。3. 再次读取。
[预期结果] 1. 状态为未最大化。2. 双击被接受。3. 状态变为已最大化。
[清理] 恢复为未最大化；`DELETE /session/<id>`

### [P5] 验证 macOS 原生全屏时整条导航栏隐藏

[Case ID] TC-DSK-L3-017
[层级] L3（真实 Tauri 窗口）
[类型] 低频
[追踪] `src/layout/components/navbar.tsx:97-143`、`:349`
[自动化] 否（手工；需操作系统级全屏切换）
[前置条件] 平台为 macOS；窗口处于普通（非全屏）状态
[测试数据] 导航栏根节点 `dsh-navbar-root`
[测试步骤] 1. 确认导航栏可见。2. 通过绿色交通灯进入原生全屏。3. 读取导航栏可见性。4. 退出全屏。
[预期结果] 1. 导航栏可见。2. 进入原生全屏成功。3. 导航栏不可见。4. 退出后导航栏恢复可见。
[清理] 退出原生全屏

---

## 5. 选择器契约（待补）

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-navbar-menu-file` | 「文件」下拉触发器 | 待补 |
| `dsh-navbar-menu-config` | 「配置」下拉触发器 | 待补 |
| `dsh-navbar-menu-help` | 「帮助」下拉触发器 | 待补 |
| `dsh-navbar-sidebar-toggle` | 侧边栏折叠开关 | 待补 |
| `dsh-navbar-drag-region` | 空白拖拽区 | 待补 |

---

## 6. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `CONFIG_TABS` 四项 | 010 | 正向 | 定位结果归 `03` |
| 「帮助」「文件」菜单项集合 | 011、012 | 正向 | 各菜单项动作分散在 `12`/`13`/`16` |
| `tauriEnabled` 条件渲染 | 013、014 | 正向 / 异常 | 插件增删即时生效依赖 `dsh-plugins-updated` 事件 |
| iframe 回调缺席时的禁用 | 015 | 异常 | — |
| 拖拽区（双击 / 触摸） | 016 | 边界 | 触摸与笔输入的 `startDragging` 分支（`:196-205`）需真实触摸设备，**未覆盖** |
| macOS 原生全屏与原生菜单 | 017 | 低频 | 原生菜单 9 个动作（`:310-342`）逐项未覆盖，**已知盲区** |

---

## 7. 缺口与假设

- **G-D02-1**：`dsh-tauri` 的安装状态来自 `get_dsh_plugins` 查询缓存，由根布局订阅 `dsh-plugins-updated` 写入（`src/layout/index.tsx:36-38`）。TC-DSK-L3-014 需要真实的「未安装」档案，属 `08`/`09` 的能力，接线时须先建立插件安装/卸载夹具。
- **G-D02-2**：TC-DSK-L3-013 需要 iframe 侧主动回报桥消息。若 `dsh-tauri` 客户端未在测试环境装配，该用例不可达；此时应改用注入脚本直接派发 `message` 事件，并注明这是对桥的模拟而非真实插件行为。
- **G-D02-3**：macOS 原生菜单（`macos-menu-action`）共 9 个动作，本套只覆盖「导航栏在全屏时隐藏」这一条平台差异，原生菜单本身**未覆盖**。
- **假设**：未标注平台的用例默认在 Windows（WebView2）执行；macOS 上「文件」「帮助」不渲染，TC-DSK-L3-009/011/012 需按平台跳过或改断言原生菜单。
