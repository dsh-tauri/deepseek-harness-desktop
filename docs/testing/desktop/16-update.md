# 更新

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/specs/desktop/16-update.e2e.ts`（待建立）
> 前置：`02-shell-navigation.md` 通过
> 运行：`vitest --project desktop -- test/e2e/specs/desktop/16-update.e2e.ts`（待配置，见 G2）

桌面端自更新有两条独立链路：**应用自身更新**（`desktopUpdater`，低频轮询 + 导航栏 chip）与**核心更新**（`harnessUpdater`，toast 提示）。本文件覆盖检测、提示、对话框与破坏性更改确认。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 应用更新轮询间隔 10 分钟，启动即检查一次 | `src/layout/index.tsx:21`、`:85-89` |
| 轮询失败一律静默（不打扰用户） | `src/layout/index.tsx:86` |
| 「更新可用」chip 紧跟「帮助」右侧，三平台均显示 | `src/layout/components/navbar.tsx:528-541` |
| 「帮助 → 检查更新」：有更新才弹框，无更新提示「已是最新」 | `src/layout/components/navbar.tsx:283-295` |
| 检查失败 → 危险提示「检查失败」（不冒充「已是最新」） | `src/layout/components/navbar.tsx:291-294` |
| 更新对话框 `DesktopUpdateDialog` | `src/ui/dialog/update.tsx`；`src/layout/components/navbar.tsx:278-280` |
| 「检查更新」项内的新版本标记 | `src/layout/components/navbar.tsx:483-488` |
| 核心更新提示由 `harnessUpdater.showToast` 触发，仅提示不打断 | `src/layout/index.tsx:128-133` |
| 「立即更新」先过破坏性更改确认，取消即中止 | `src/layout/index.tsx:135-141`；`src/ui/config/hooks/use-core-breaking-confirm.tsx` |
| 「应用」面板核心版本旁的新版本链接 | `src/ui/config/debug.tsx:260-269` |
| 下载完成事件 `harness-download-finished` 由外壳订阅 | `src/layout/index.tsx:94-126` |

---

## 2. 检测与提示

### [P1] 验证发现新版本时导航栏出现更新入口

[Case ID] TC-DSK-L3-121
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/navbar.tsx:531-541`；`src/layout/index.tsx:88-89`
[自动化] 待接线（`test/e2e/specs/desktop/16-update.e2e.ts`）
[前置条件] 已构造「存在更高版本」的更新检查结果；联网
[测试数据] 选择器 `dsh-navbar-update-chip`
[测试步骤] 1. 触发一次更新检查。2. 等待检查结果写入。3. 读取导航栏更新入口存在性与文案。
[预期结果] 1. 检查被触发。2. 结果写入完成。3. 更新入口存在且文案为「有可用更新」语义。
[清理] 清除构造的更新结果；`DELETE /session/<id>`

### [P2] 验证无更新时提示已是最新

[Case ID] TC-DSK-L3-122
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/navbar.tsx:283-295`
[自动化] 待接线（同上）
[前置条件] 已构造「无更高版本」的更新检查结果；联网
[测试数据] 菜单项 `check-update`
[测试步骤] 1. 打开「帮助」菜单并点击「检查更新」。2. 等待提示出现。3. 读取提示文案与更新对话框存在性。
[预期结果] 1. 点击被接受。2. 提示出现。3. 文案为「已是最新版本」语义；更新对话框未打开。
[清理] `DELETE /session/<id>`

### [P2] 验证点击更新入口打开更新对话框

[Case ID] TC-DSK-L3-123
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/navbar.tsx:278-280`、`:532-540`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-121 通过（更新入口存在）
[测试数据] 选择器 `dsh-navbar-update-chip`、`dsh-update-dialog`
[测试步骤] 1. 点击更新入口。2. 读取更新对话框可见性与版本信息。
[预期结果] 1. 点击被接受。2. 对话框可见，包含目标版本号与下载/安装状态信息。
[清理] 关闭对话框；`DELETE /session/<id>`

### [P4] 验证「应用」面板核心有新版时显示新版本链接

[Case ID] TC-DSK-L3-124
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/config/debug.tsx:260-269`
[自动化] 待接线（同上）
[前置条件] 已构造核心更新信息；配置对话框打开在「应用」面板
[测试数据] 选择器 `dsh-config-dsh-version-new`
[测试步骤] 1. 读取新版本链接存在性。2. 点击该链接。3. 读取更新提示存在性。
[预期结果] 1. 链接存在。2. 点击被接受。3. 出现更新提示（与导航栏入口收敛到同一处）。
[清理] 关闭对话框；`DELETE /session/<id>`

---

## 3. 失败与破坏性更改

### [P3] [反向] 验证检查更新失败时提示失败而非已是最新

[Case ID] TC-DSK-L3-125
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/layout/components/navbar.tsx:291-294`
[自动化] 待接线（同上）
[前置条件] 构造更新检查失败（如不可达的更新源）
[测试数据] 菜单项 `check-update`
[测试步骤] 1. 点击「检查更新」。2. 等待失败返回。3. 读取提示文案与语义。
[预期结果] 1. 点击被接受。2. 失败在超时内返回。3. 提示为「检查失败」语义且为危险样式；不出现「已是最新」。
[清理] 恢复更新源；`DELETE /session/<id>`

### [P3] 验证高于 rc.2 的版本更新前弹破坏性更改确认

[Case ID] TC-DSK-L3-126
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/layout/index.tsx:135-141`；`src/ui/config/hooks/use-core-breaking-confirm.tsx`
[自动化] 待接线（同上）
[前置条件] 已构造目标版本高于 `rc.2` 的更新信息
[测试数据] 确认框取消按钮
[测试步骤] 1. 触发「立即更新」。2. 读取破坏性更改确认框。3. 取消后读取下载/安装进度状态。
[预期结果] 1. 确认框出现。2. 确认框存在且说明破坏性更改。3. 取消后不发起更新动作（无进度变化、无安装包下载）。
[清理] 清除构造的更新信息；`DELETE /session/<id>`

### [P4] 验证后台轮询失败不影响其他功能

[Case ID] TC-DSK-L3-127
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/layout/index.tsx:85-89`（失败一律静默）
[自动化] 待接线（同上）
[前置条件] 构造后台更新轮询失败
[测试数据] 观察点：壳层可见提示区与控制台错误收集器
[测试步骤] 1. 让一次后台轮询失败。2. 等待轮询返回。3. 读取壳层可见提示与控制台错误。4. 打开配置对话框。
[预期结果] 1. 失败返回。2. 轮询完成。3. 不出现面向用户的错误提示；收集器为空。4. 配置对话框可正常打开。
[清理] 恢复更新源；`DELETE /session/<id>`

---

## 4. 选择器契约（待补）

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-navbar-update-chip` | 「更新可用」Chip | 待补 |
| `dsh-navbar-menu-help-new-version` | 「检查更新」项内的新版本标记 | 待补 |
| `dsh-update-dialog` | 更新对话框根节点 | 待补 |
| `dsh-update-dialog-install` | 「立即更新」按钮 | 待补 |
| `dsh-config-dsh-version-new` | 「应用」面板新版本链接 | 待补 |

---

## 5. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 应用更新检测与 chip | 121、123 | 正向 | chip 的**静默下载**过程未覆盖（需观测下载进度） |
| 「帮助 → 检查更新」三态 | 122、125 | 正向 / 异常 | 三态（有更新 / 无更新 / 失败）已完整覆盖 |
| 核心更新提示 | 124、126 | 正向 / 异常 | 确认后的**实际更新执行**未覆盖（会替换核心，破坏性极强） |
| 破坏性更改确认 | 126 | 异常 | 只覆盖「取消中止」；确认后继续的分支未覆盖 |
| 后台轮询容错 | 127 | 边界 | — |

---

## 6. 缺口与假设

- **G-D16-1**：本文件的多数用例需要「可控的更新结果」（有更高版本 / 无更高版本 / 检查失败）。当前无测试替身更新源，接线时需引入（例如指向本地 HTTP 服务），否则 TC-DSK-L3-121/123/126 不可达。
- **G-D16-2**：真实更新检查会触发 GitHub 未认证限流（60 次/小时/IP，见 `src/layout/index.tsx:20-21`）。测试**不得**依赖真实 GitHub，必须使用替身源。
- **G-D16-3**：TC-DSK-L3-126 只覆盖「取消中止」。确认后继续执行更新会替换核心并重启服务，破坏性极强，**未覆盖**。
- **G-D16-4**：`harness-download-finished` 的下载完成提示归 `18`，本文件不重复。
- **假设**：`desktopUpdater.check()` 返回非空即表示「有更新」；返回空或抛错分别对应「无更新」与「检查失败」（`navbar.tsx:283-295`）。
