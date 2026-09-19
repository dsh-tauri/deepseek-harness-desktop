# 跨插件与桌面端壳层集成

> 层级：L3 桌面端宿主 E2E（辅以一条 L2 多插件用例）
> 自动化：`test/e2e/specs/desktop/plugin-integration.e2e.ts`（待建立）
> 前置：debug 二进制 + `dist/`；`<DSH_E2E_HOME>/home/.dsh.dev` 无残留实例；WebDriver 端口空闲
> 运行：待接线（`desktop` project 未配置，见 `00-overview.md` G4）

前面各文件都假设「单个插件在干净宿主里工作」。本文件回答最后一个问题：**十个插件同时挂载、加载失败、被禁用或被安全模式拦截时，桌面端壳层是否仍然可用**。这是唯一以「壳层可用性」而非「插件功能」为断言对象的文件。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 插件加载由 profile 的 `dsh.profile.bundles` 决定 | `src-tauri/src/service/plugin/installed.rs:44` |
| 禁用＝从 bundles 移除（包体保留） | `src-tauri/src/service/plugin/disable.rs:194` |
| 已装插件清单 / 启用 / 禁用命令 | `src-tauri/src/bridge/plugin.rs:127`、`src-tauri/src/bridge/plugin.rs:217`、`src-tauri/src/bridge/plugin.rs:230` |
| 内置插件清单共 10 条，启动自愈 | `src-tauri/resources/internal-plugins.json:3`、`src-tauri/src/bridge/plugin.rs:95` |
| 废弃插件启动时自动卸载 | `src-tauri/resources/deprecated-plugins.json:2` |
| iframe 地址＝`http://127.0.0.1:<port>?t=<ts>`，**不含 token** | `src/store/modules/harness/utils.ts:37`、`src/store/modules/harness/store.ts:375` |
| iframe 桥只接受直接父级且 origin 完全一致的消息 | `src/hooks/use-iframe-message.ts:25` |
| iframe→Tauri 调用白名单共 9 条命令，越权静默忽略 | `src/hooks/use-invoke-iframe.ts:35`、`src/hooks/use-invoke-iframe.ts:52` |
| boot 卡死探测：子 frame 专用，8s 未消失即上报 `stalled` | `src-tauri/src/desktop/plugin_boot.js.inc:123` |
| 重载预算 3 次 | `src/store/modules/harness/constants.ts:31` |
| 垫片注入：非 Windows 全 frame 初始化脚本（5 个），Windows 经 `FrameCreated` 注入 3 个 | `src-tauri/src/desktop/builder.rs:566`、`src-tauri/src/desktop/notification.rs:324` |
| 安全模式命令 | `src-tauri/src/desktop/builder.rs:872` |

---

## 2. 用例

### [P1] 验证全部内置插件挂载后 dsh 界面仍能进入应用壳

[Case ID] TC-XP-L3-001
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/resources/internal-plugins.json:3`、`src-tauri/src/desktop/plugin_boot.js.inc:112`
[自动化] 待接线（`00-overview.md` G4）
[前置条件] `get_dsh_plugins` 返回包含 10 个内置插件；应用首启完成
[测试数据] 无
[测试步骤] 1. 启动应用并建立 WebDriver 会话。2. 等待 iframe 加载完成。3. 查询 iframe 内是否仍显示 `Loading plugins` 或 `Failed to load plugins`。4. 收集壳层收到的 `dsh://plugin-boot:stalled` / `failed` 事件。
[预期结果] 1. 会话建立成功。2. 无插件加载失败页。3. 壳层未收到 `stalled` 或 `failed` 上报。4. iframe 内出现应用主体（非 boot splash）。
[清理] `DELETE /session/<id>`

### [P2] 验证禁用插件后不再被加载

[Case ID] TC-XP-L3-002
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/disable.rs:194`
[自动化] 待接线（G4）
[前置条件] 选择 `dsh-tauri-session`（不承载壳层必需能力）
[测试数据] 插件 id `dsh-tauri-session`
[测试步骤] 1. 记录禁用前 `get_dsh_plugins` 中该插件的启用状态。2. 调用 `disable_dsh_plugin`。3. 读 profile 的 `dsh.profile.bundles`。4. 重启应用并再次读 `get_dsh_plugins`。
[预期结果] 1. 禁用后 bundles 中不再包含该插件名。2. 重启后该插件仍为禁用态。3. 其宿主路由返回 404（与 `02-dsh-tauri-core.md` TC-CORE-L2-006 的判定一致）。
[清理] `enable_dsh_plugin` 恢复启用；`DELETE /session/<id>`

### [P3] [反向] 验证插件运行期报错被上报且壳层给出恢复入口

[Case ID] TC-XP-L3-003
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/layout/components/iframe.tsx:103`
[自动化] 待接线（G4）
[前置条件] 可注入一个必然抛错的插件 client 产物（测试替身）
[测试数据] 替身插件在 `apply()` 中抛错
[测试步骤] 1. 挂载替身插件并启动。2. 观察壳层是否收到 `dsh://plugin-error`。3. 读取壳层展示的恢复入口（修复/禁用）。
[预期结果] 1. 上报事件到达壳层且携带插件标识。2. 壳层**没有**白屏：主界面仍可用。3. 恢复入口可点击并触发对应命令。4. 其余插件的槽位产物仍存在（错误被隔离）。
[清理] 卸载替身插件；`DELETE /session/<id>`

### [P4] [反向] 验证白名单外的 iframe 调用被静默忽略

[Case ID] TC-XP-L3-004
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/hooks/use-invoke-iframe.ts:52`
[自动化] 待接线（G4）
[前置条件] iframe 内可执行脚本（经驱动注入）
[测试数据] 通过 `postMessage` 请求一条白名单外的命令，例如 `read_file`
[测试步骤] 1. 从 iframe 发送 `dsh://tauri:invoke` 消息，命令名为 `read_file`。2. 等待 5s。3. 检查是否有回复与副作用。
[预期结果] 1. 壳层不返回 `dsh://tauri:reply`（或返回错误而**不执行**）。2. 无文件被读取的副作用。3. 应用不崩溃。
[清理] 无

### [P3] [反向] 验证安全模式下用户插件不加载

[Case ID] TC-XP-L3-005
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/desktop/builder.rs:872`
[自动化] 待接线（G4）
[前置条件] 存在至少一个用户安装插件
[测试数据] 无
[测试步骤] 1. 调用 `enter_safe_mode`。2. 重启应用。3. 读 `get_dsh_plugins` 与 iframe 内容。
[预期结果] 1. 用户插件不参与加载。2. 界面可进入（不因插件缺失而白屏）。3. 壳层提供退出安全模式的入口。
[清理] 退出安全模式；`DELETE /session/<id>`

### [P4] 验证 boot 卡死会被探测并触发有限次重载

[Case ID] TC-XP-L3-006
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/desktop/plugin_boot.js.inc:123`、`src/store/modules/harness/constants.ts:31`
[自动化] 待接线（G4）
[前置条件] 人为让 client bundle 请求挂起（阻断探测 URL）
[测试数据] 无
[测试步骤] 1. 启动应用并阻断插件 bundle 请求。2. 等待 ≥ 8s。3. 统计 iframe 重载次数与壳层收到的上报。
[预期结果] 1. 8s 后收到 `dsh://plugin-boot:stalled`。2. 重载次数 ≤ 3。3. 超过预算后壳层停止重载并显示失败入口，而非无限刷新。
[清理] 恢复网络；`DELETE /session/<id>`

### [P3] 验证内嵌界面地址不携带启动 token

[Case ID] TC-XP-L3-007
[层级] L3（真实 Tauri 窗口）
[类型] 回归
[追踪] `src/store/modules/harness/utils.ts:32`
[自动化] 待接线（G4）
[前置条件] 应用就绪
[测试数据] 无
[测试步骤] 1. 读 iframe 的 `src`。2. 检查是否含 `token` / `auth` 等查询参数。
[预期结果] 1. `src` 形如 `http://127.0.0.1:<port>/?t=<数字>`。2. 不含任何 token 参数（安全回归：token 只经壳层内存传递）。
[清理] `DELETE /session/<id>`

### [P4] 验证多插件同时挂载时路由互不遮蔽

[Case ID] TC-XP-L2-001
[层级] L2（真实 dsh 进程）
[类型] 边界
[追踪] `packages/dsh-tauri/src/host/routes/index.ts:135`
[自动化] 是（`packages/dsh-tauri/test/routes-contract.e2e.ts` 扩展）
[前置条件] 一次挂载多个插件
[测试数据] `DSH_E2E_PLUGIN=dsh-tauri-pet`，`DSH_E2E_ALSO=dsh-tauri-rightclick,dsh-tauri-session`
[测试步骤] 1. 启动宿主。2. 分别请求三个插件各自的一条路由。3. 读状态码。
[预期结果] 1. 宠物 SSE 路由返回 200。2. 右键 `POST /open/url` 对非法入参返回 400（证明路由存在且非 404）。3. 会话 `GET /session/archive` 返回 200。4. 三者互不返回 404。
[清理] 停止宿主

---

## 3. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 内置插件清单与自愈 | TC-XP-L3-001 | 正向 | 依赖 10 个插件全部构建 |
| 禁用/启用链路 | TC-XP-L3-002 | 正向 | 会改用户 profile，需在隔离数据目录执行 |
| `dsh://plugin-error` 上报 | TC-XP-L3-003 | 异常 | 需要测试替身插件 |
| invoke 白名单 | TC-XP-L3-004 | 边界 | 需要驱动注入脚本 |
| 安全模式 | TC-XP-L3-005 | 异常 | 会改用户状态，需隔离数据目录 |
| boot 卡死探测 | TC-XP-L3-006 | 边界 | 需要网络阻断能力 |
| iframe 地址不含 token | TC-XP-L3-007 | 回归 | — |
| 路由互不遮蔽 | TC-XP-L2-001 | 边界 | 可并入 `02` 的文件执行 |

---

## 4. 缺口与假设

- **G-XP-1**：本文件多数用例会**改写 `<DSH_E2E_HOME>/home/.dsh.dev` 下的 profile**（禁用/安全模式）。执行前必须确认无 dev 实例运行，并在用例收尾恢复原状；未恢复即视为用例失败。
- **G-XP-2**：TC-XP-L3-003 与 TC-XP-L3-006 需要**测试替身插件**（必然抛错 / 让 bundle 挂起）。仓库当前无此类 fixture，属新增基础设施，需单独批次授权。
- **G-XP-3**：Windows 只注入 3 个垫片、非 Windows 注入 5 个（`src-tauri/src/desktop/notification.rs:324`）。跨平台差异会对 `iterator helpers` / `AbortSignal.any` 相关行为有影响，本文件不覆盖该差异，登记为已知盲区。
- **假设**：iframe 与宿主同源（`http://127.0.0.1:<port>`），因此 WebDriver 可直接切 frame 并派发事件；若 CSP 收紧，`use-iframe-message.ts:25` 的 origin 校验会成为断言前置。
