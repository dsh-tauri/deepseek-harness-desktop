# 窗口启动

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/desktop/01-window-boot.e2e.ts`（待建立）
> 前置：见 `00-overview.md` §5.1；`dist/` 与 debug 二进制已按最新源码重建
> 运行：`vitest --project desktop -- test/e2e/desktop/01-window-boot.e2e.ts`（`desktop` project 待配置，见 G2）

本文件是全部用例的地基：窗口能起来、壳层能渲染、前置校验能拦住不该跑的运行。任何一条失败都意味着后续用例的失败不可归因。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 主窗口标题 `Deepseek Harness Desktop` | `src-tauri/src/desktop/builder.rs:484` |
| 主窗口初始尺寸 `1280×840` | `src-tauri/src/desktop/builder.rs:485` |
| 主窗口最小尺寸 `860×620` | `src-tauri/src/desktop/builder.rs:486` |
| 壳层导航栏高度常量 `SHELL_NAV_HEIGHT = 44` | `src-tauri/src/desktop/builder.rs:44` |
| 导航栏根元素 `h-11`（与上者同真值，由 Rust 单测守门） | `src/layout/components/navbar.tsx:347` |
| 壳层根容器 `flex h-screen w-screen` | `src/layout/index.tsx:144` |
| DEV 标记 Chip 仅在 `import.meta.env.DEV` 下渲染 | `src/layout/components/navbar.tsx:512-516` |
| 首次挂载自动启动 harness（StrictMode 去重） | `src/layout/index.tsx:81`、`src/store/modules/harness/store.ts:119-124` |
| 启动阶段枚举 `checking/installing/starting/preinstall/ready/error` | `src/store/modules/harness/types.ts:4` |
| Debug 端口常量 `DSH_DEV_PORT = 3081` | `src-tauri/src/config/constants.rs:53` |
| 端口被占用时逐级递增 | `src-tauri/src/service/workflow/launch.rs:66`、`:84-86` |
| 端口 NOT fixed 的正式声明 | `src-tauri/capabilities/default.json:4` |

---

## 2. 窗口与壳层

### [P1] 验证应用启动后主窗口存在且标题正确

[Case ID] TC-DSK-L3-001
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] 批次 01；`src-tauri/src/desktop/builder.rs:484`
[自动化] 待接线（`test/e2e/desktop/01-window-boot.e2e.ts`）
[前置条件] 二进制存在；默认端口实测空闲；无残留桌面实例
[测试数据] 期望标题 `Deepseek Harness Desktop`
[测试步骤] 1. 拉起应用并建立 WDIO 会话。2. 读取窗口句柄集合与当前窗口标题。
[预期结果] 1. 会话建立成功。2. 句柄集合为 `["main"]`。3. 标题等于 `Deepseek Harness Desktop`。
[清理] `DELETE /session/<id>`，再按进程树结束应用

### [P1] 验证壳层根节点渲染且页面无未捕获错误

[Case ID] TC-DSK-L3-002
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] 批次 01；`src/layout/index.tsx:144`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-001 通过
[测试数据] 根节点选择器 `dsh-shell-root`；控制台错误白名单为空
[测试步骤] 1. 注入控制台错误收集器。2. 等待壳层根节点出现。3. 首屏稳定后读取收集器。
[预期结果] 1. 收集器注入成功。2. 根节点在超时内出现且可见。3. 收集器为空（无未捕获错误）。
[清理] `DELETE /session/<id>`

### [P2] 验证壳层导航栏高度为 44px

[Case ID] TC-DSK-L3-003
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/desktop/builder.rs:44`；`src/layout/components/navbar.tsx:347`；issue #524
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-001 通过
[测试数据] 导航栏根节点 `dsh-navbar-root`；期望高度 `44`
[测试步骤] 1. 等待导航栏根节点出现。2. 读取其边界矩形高度。
[预期结果] 1. 节点出现。2. 高度等于 `44`（与 `SHELL_NAV_HEIGHT` 一致；两处一致性另由 Rust 单测 `shell_nav_height_matches_navbar_height_class` 守门）。
[清理] `DELETE /session/<id>`

---

## 3. 几何约束

### [P2] 验证主窗口初始尺寸为 1280×840

[Case ID] TC-DSK-L3-004
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/desktop/builder.rs:485`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-001 通过；无历史窗口几何持久化记录
[测试数据] 期望宽 `1280`、高 `840`
[测试步骤] 1. 清空窗口几何持久化记录。2. 拉起应用。3. 读取窗口内尺寸。
[预期结果] 1. 清空成功。2. 会话建立成功。3. 内尺寸等于 `1280×840`（允许 ±1px 取整误差）。
[清理] 恢复被清空的几何记录；`DELETE /session/<id>`

### [P2] 验证窗口最小尺寸约束为 860×620

[Case ID] TC-DSK-L3-005
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/desktop/builder.rs:486`
[自动化] 否（手工）——embedded driver 的 `SetWindowRect` 绕过 tao 的最小尺寸约束（见 G-D01-4）
[前置条件] TC-DSK-L3-001 通过
[测试数据] 手工拖拽窗口左下角至小于 `860×620`
[测试步骤] 1. 手动拖拽窗口边缘缩小。2. 读取实际内尺寸。
[预期结果] 1. 拖拽被限制。2. 实际宽不小于 `860`，高不小于 `620`。
[清理] 恢复窗口尺寸；`DELETE /session/<id>`

### [P4] 验证生产构建不显示开发环境标记

[Case ID] TC-DSK-L3-006
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/layout/components/navbar.tsx:512-516`
[自动化] 是
[前置条件] 运行的是 `vite build` 产物（本通道恒成立）
[测试数据] 标记节点 `dsh-navbar-dev-chip`
[测试步骤] 1. 拉起应用。2. 查询标记节点是否存在。
[预期结果] 1. 会话建立成功。2. 标记节点不存在（`import.meta.env.DEV` 为 false）。
[清理] `DELETE /session/<id>`

> 正向（dev 构建下标记可见）需 `tauri dev` 前端通道，本套件不可覆盖，见 G-D01-5。

---

## 4. 启动前置校验

### [P3] [反向] 验证二进制缺失时启动失败并给出可判定错误

[Case ID] TC-DSK-L3-007
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `docs/specs/desktop.test.md` §1「严格归因」
[自动化] 待接线（同上）
[前置条件] 故意使用不存在的二进制路径
[测试数据] 路径 `src-tauri/target/debug/__missing__.exe`
[测试步骤] 1. 以不存在的路径请求启动。2. 捕获启动结果。
[预期结果] 1. 启动被拒绝。2. 抛出可判定错误且错误信息包含该路径。3. 不出现「会话已建立」。
[清理] 无

### [P3] [反向] 验证默认端口被占用时前置校验直接失败且不强杀进程

[Case ID] TC-DSK-L3-008
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `docs/specs/desktop.test.md` §6「前置校验」；`src-tauri/src/service/workflow/launch.rs:66`
[自动化] 待接线（同上）
[前置条件] 测试自行占用默认端口（模拟残留实例）
[测试数据] 占用端口 `3081`；占用者进程 PID
[测试步骤] 1. 占用 `3081`。2. 执行前置校验。3. 断言校验结果。4. 断言占用者进程仍存活。
[预期结果] 1. 占用成功。2. 校验返回失败并指明端口被占用。3. 失败信息可判定。4. 占用者进程未被终止（不自动强杀用户进程）。
[清理] 释放测试自身持有的端口占用

---

## 5. 选择器契约

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-shell-root` | `src/layout/index.tsx` 最外层容器 | 已补 |
| `dsh-navbar-root` | `src/layout/components/navbar.tsx` 根容器 | 已补 |
| `dsh-navbar-dev-chip` | 导航栏 DEV 标记 Chip | 已补 |

> 仅 `01` 批次声明的选择器已补齐；`02` 及后续批次所需选择器在各自批次落地时同步补，不提前铺设。

---

## 6. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `builder.rs` 主窗口构建（标题/尺寸/最小尺寸） | 001、004、005 | 正向 / 边界 | 几何持久化恢复归 `12` |
| `desktop.test.md` §1 严格归因 | 002、007 | 正向 / 异常 | 控制台错误的「可接受警告」白名单需在接线时定义 |
| issue #524（栏高一致性） | 003 | 正向 | Rust 单测已守门，本用例是真实渲染下的同一断言 |
| `desktop.test.md` §6 前置校验 | 008 | 异常 | 校验由测试编排实现，不属应用行为 |
| DEV 标记 | 006 | 边界 | — |

---

## 7. 缺口与假设

- **G-D01-1**：窗口内尺寸断言受 DPI 缩放影响，`1280×840` 与 `860×620` 为逻辑像素；WebDriver 读回的 CSS 像素需乘 `devicePixelRatio` 还原（实测 150% 下 inner 为 `854×560`，×1.5 = 1281）。
- **G-D01-2**：TC-DSK-L3-002 的「无未捕获错误」需要一份可接受警告白名单（如 WebView2 的无关警告），当前未定义，接线时必须先确定，否则用例会因环境噪声假失败。
- **G-D01-3**：TC-DSK-L3-008 校验的是**测试编排**的前置行为，不是应用行为；放在本文件的理由是它与启动路径同批推进。若后续拆出独立的编排骨架文件（对应插件套件的 `01-host-lane-skeleton.md`），应随之迁移。
- **G-D01-4**：TC-DSK-L3-005 在本通道**不可自动断言**。embedded driver 的 `SetWindowRect` 直接落 `SetWindowPos`，绕过 tao 的最小尺寸约束——请求 `400×300` 会真的变成 `400×300`（实测）。该用例改标手工，自动覆盖需原生 API 或真实拖拽注入。
- **G-D01-5**：TC-DSK-L3-006 只能验反向。本通道前端由 `vite build` 产出，`import.meta.env.DEV` 恒为 false，DEV 标记本就不该出现；正向（dev 构建可见）需 `tauri dev` 或 browser mode 通道。
- **假设**：默认端口为 `3081`，但按 `capabilities/default.json:4` 与 `launch.rs:66`，端口可配置且会递增；本文件的前置校验按「实测空闲」执行，不断言端口恒定。
