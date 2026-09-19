# 窗口控制与托盘

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/desktop/12-window-tray.e2e.ts`（待建立）
> 前置：`01-window-boot.md` 通过
> 运行：`vitest --project desktop -- test/e2e/desktop/12-window-tray.e2e.ts`（待配置，见 G2）

本文件区分两种「关闭」语义：**后台化**（隐藏到托盘，服务保持运行）与**退出**（完整退出，触发服务回收与几何保存）。`close_action` 设置决定右上角关闭按钮走哪一条；托盘菜单与「文件」菜单始终提供显式退出。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 窗口动作分发 `minimize`/`maximize`/`background` | `src/layout/components/navbar.tsx:174-188` |
| 「后台化」= `appWindow.hide()`（隐藏到托盘） | `src/layout/components/navbar.tsx:183-186` |
| 「关闭」菜单项与右上角关闭按钮同语义（隐藏到托盘） | `src/layout/components/navbar.tsx:229-232` |
| 「退出」菜单项 → `quit_app` | `src/layout/components/navbar.tsx:233-235`、`:249-257` |
| `quit_app` → `app_handle.exit(0)` | `src-tauri/src/desktop/window.rs:153-156` |
| 退出触发主窗口几何保存与服务回收 | `src-tauri/src/lib.rs:51`；`src-tauri/src/desktop/window.rs:152` |
| 「新建窗口」→ `create_app_window` | `src-tauri/src/desktop/window.rs:144-149` |
| 托盘菜单项 id：`open`（打开面板）/ `quit`（退出） | `src-tauri/src/desktop/builder.rs:185-186` |
| Linux 托盘单独实现（`tray-icon` + `ksni`） | `src-tauri/src/desktop/linux_tray.rs:42-53` |
| 关闭行为设置 `close_action`（`tray` / `quit`） | `src/ui/config/components/close-action.tsx:24`、`src/utils/close-action.ts` |
| 关闭行为写入走 `update_app_config`（后端归一化后落盘） | `src/ui/config/components/close-action.tsx:25-33` |
| 窗口几何持久化 | `src-tauri/src/config/window_state.rs`；`src-tauri/src/desktop/builder.rs:467` |
| 额外窗口与主窗口同标题、同尺寸 | `src-tauri/src/desktop/builder.rs:617-626` |

---

## 2. 窗口按钮

### [P1] 验证最小化按钮最小化窗口

[Case ID] TC-DSK-L3-087
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/navbar.tsx:545-554`
[自动化] 待接线（`test/e2e/desktop/12-window-tray.e2e.ts`）
[前置条件] 窗口处于正常（非最小化）状态；平台非 macOS
[测试数据] 选择器 `dsh-navbar-window-minimize`
[测试步骤] 1. 点击最小化按钮。2. 等待窗口状态变化。3. 读取窗口最小化状态与进程存活状态。
[预期结果] 1. 点击被接受。2. 状态变化。3. 最小化状态为真；应用进程仍存活。
[清理] 恢复窗口；`DELETE /session/<id>`

### [P2] 验证最大化按钮切换最大化

[Case ID] TC-DSK-L3-088
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/navbar.tsx:556-565`
[自动化] 待接线（同上）
[前置条件] 窗口非最大化；平台非 macOS
[测试数据] 选择器 `dsh-navbar-window-maximize`
[测试步骤] 1. 读取最大化状态。2. 点击最大化按钮。3. 再次读取。4. 再次点击并读取。
[预期结果] 1. 为未最大化。2. 点击被接受。3. 变为已最大化。4. 恢复为未最大化（按钮为切换语义）。
[清理] `DELETE /session/<id>`

### [P2] 验证关闭按钮按关闭行为隐藏到托盘

[Case ID] TC-DSK-L3-089
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/navbar.tsx:567-576`；`src/ui/config/components/close-action.tsx:24`
[自动化] 待接线（同上）
[前置条件] 设置中关闭行为为 `tray`（默认）；平台非 macOS
[测试数据] 选择器 `dsh-navbar-window-background`
[测试步骤] 1. 确认关闭行为为 `tray`。2. 点击后台化按钮。3. 等待窗口隐藏。4. 读取窗口可见性与进程状态。
[预期结果] 1. 确认为 `tray`。2. 点击被接受。3. 窗口隐藏。4. 窗口不可见；应用进程仍存活，服务仍在运行。
[清理] 通过托盘恢复窗口；`DELETE /session/<id>`

---

## 3. 托盘与退出

### [P2] 验证托盘「打开面板」恢复窗口

[Case ID] TC-DSK-L3-090
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/desktop/builder.rs:185`
[自动化] 待接线（同上）
[前置条件] 承接 TC-DSK-L3-089（窗口已隐藏到托盘）；平台为 Windows 或 Linux
[测试数据] 托盘菜单项 id `open`
[测试步骤] 1. 触发托盘菜单项 `open`。2. 等待窗口显示。3. 读取窗口可见性与 iframe 实例标识。
[预期结果] 1. 触发成功。2. 窗口显示。3. 可见性为真；iframe 实例标识与隐藏前一致（未重载）。
[清理] `DELETE /session/<id>`

### [P2] 验证「文件 → 退出」完整退出

[Case ID] TC-DSK-L3-091
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/navbar.tsx:249-257`、`:422-429`
[自动化] 待接线（同上）
[前置条件] 应用运行中；平台非 macOS
[测试数据] 菜单项 id `quit`；退出等待上限为测试侧参数（建议 30s）
[测试步骤] 1. 打开「文件」菜单并点击「退出」。2. 等待应用进程退出。3. 复查应用与 harness 进程。
[预期结果] 1. 点击被接受。2. 进程在等待上限内退出。3. 应用与 harness 进程均不再存在（无孤儿服务）。
[清理] 无

### [P3] 验证托盘「退出」完整退出并回收服务

[Case ID] TC-DSK-L3-092
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/desktop/builder.rs:186`；`src-tauri/src/desktop/window.rs:151-156`
[自动化] 待接线（同上）
[前置条件] 应用运行中；平台为 Windows 或 Linux
[测试数据] 托盘菜单项 id `quit`；退出等待上限同上
[测试步骤] 1. 记录 harness 子进程 pid。2. 触发托盘菜单项 `quit`。3. 等待应用进程退出。4. 复查应用与 harness 进程。
[预期结果] 1. 记录成功。2. 触发成功。3. 应用进程在等待上限内退出。4. 两者均不再存在。
[清理] 无

---

## 4. 边界

### [P4] 验证关闭行为设为退出时关闭按钮直接退出

[Case ID] TC-DSK-L3-093
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/ui/config/components/close-action.tsx:25-33`；`src/utils/close-action.ts`
[自动化] 待接线（同上）
[前置条件] 已通过设置把关闭行为改为 `quit`
[测试数据] 选择器 `dsh-config-close-action`、`dsh-navbar-window-background`
[测试步骤] 1. 确认关闭行为为 `quit`。2. 点击后台化按钮。3. 等待进程退出。
[预期结果] 1. 确认为 `quit`。2. 点击被接受。3. 应用进程在等待上限内退出（而非隐藏到托盘）。
[清理] 重启应用后把关闭行为改回 `tray`

### [P4] 验证窗口几何在重启后恢复

[Case ID] TC-DSK-L3-094
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/config/window_state.rs`；`src-tauri/src/desktop/builder.rs:467`
[自动化] 待接线（同上）
[前置条件] 无历史几何记录
[测试数据] 目标位置与尺寸由测试在合法屏幕范围内选取
[测试步骤] 1. 拉起应用并把窗口移动到目标位置与尺寸。2. 完整退出应用。3. 重新拉起应用。4. 读取窗口位置与尺寸。
[预期结果] 1. 移动成功。2. 退出完成。3. 启动成功。4. 位置与尺寸与目标值一致（允许 ±2px 误差）。
[清理] 恢复几何记录；`DELETE /session/<id>`

---

## 5. 选择器契约（待补）

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-navbar-window-minimize` | 最小化按钮 | 待补 |
| `dsh-navbar-window-maximize` | 最大化按钮 | 待补 |
| `dsh-navbar-window-background` | 后台化（关闭）按钮 | 待补 |
| `dsh-config-close-action` | 「关闭按钮行为」下拉 | 待补 |

---

## 6. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 三个窗口按钮 | 087、088、089 | 正向 | 「后台化」按钮与「文件 → 关闭」同语义，只覆盖前者 |
| 托盘菜单 | 090、092 | 正向 / 异常 | 托盘菜单的实际点击属系统表面，需以程序化触发菜单事件替代（见 G-D12-2） |
| 退出语义与回收 | 091、092 | 正向 / 异常 | 只断言进程消失，未断言「退出前保存几何」与「服务被优雅回收」的中间态 |
| `close_action` 分支 | 089、093 | 正向 / 边界 | `quit` 分支的退出路径与 091 同源 |
| 几何持久化 | 094 | 边界 | 多显示器场景下的位置越界裁剪**未覆盖** |

---

## 7. 缺口与假设

- **G-D12-1**：TC-DSK-L3-091/092/093 会终止应用，**无法在同一个 WDIO 会话内继续后续用例**。接线时这些用例必须放在 Spec 末尾，或每个用例独立建会话。
- **G-D12-2**：托盘菜单的实际点击无法通过 WebDriver 完成（属系统托盘表面，见 `00-overview.md` G9）。可行路径是程序化触发菜单事件（`MenuEvent`），或由测试编排直接调用与菜单项绑定的同一处理函数。后者会退化为「不测菜单绑定」，须在实现时明确取舍。
- **G-D12-3**：`close_action` 的归一化逻辑（`normalizeCloseAction`）与后端整对象写入（`update_app_config`）之间存在覆盖风险，属单元测试职责（`test/archive/close-action.test.ts` 已有归档版本）。
- **假设**：托盘菜单项 id 为 `open` 与 `quit`（`builder.rs:185-186`），Linux 实现（`linux_tray.rs:48-49`）使用相同 id。
