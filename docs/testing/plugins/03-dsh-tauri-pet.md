# dsh-tauri-pet：从 SSE 路由到桌面端桌宠窗口

> 层级：L2 插件宿主 E2E → L3 桌面端宿主 E2E
> 自动化：`test/e2e/plugins/session-stream.e2e.ts`（L2，SSE 首帧已落地）、`test/e2e/plugins/pet-client.e2e.ts`（客户端，待接线）、`test/e2e/plugins/pet-window.e2e.ts`（L3，待接线）
> 前置：`pnpm build:plugins`；L3 另需 debug 二进制 + `3081` 空闲 + `TAURI_WEBDRIVER_PORT`
> 编排：`test/e2e/support/dsh-host.ts`；L3 通道见 `test/e2e/support/wdio-probe.mjs`
> 运行：L2 `pnpm test:e2e:plugin`；L3 见 `00-overview.md` §5.2

这是**唯一同时贯穿 L2 与 L3 的插件**：宿主侧只有一条 SSE 路由，客户端却要经 Tauri 桥驱动一个独立窗口。复杂度梯度因此天然清晰：**HTTP 字节** → **客户端挂载** → **独立窗口**。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| `PLUGIN_ID = 'dsh-tauri-pet'` | `packages/dsh-tauri-pet/src/shared/constants.ts:9` |
| SSE 路径 `/api/desktop/dsh-tauri-pet/session/stream` | `packages/dsh-tauri-pet/src/shared/constants.ts:12` |
| 唯一路由 `GET`（`kind: 'exact'`） | `packages/dsh-tauri-pet/src/host/routes/index.ts:6` |
| 接入即 `pushComment('keepalive')` | `packages/dsh-tauri-pet/src/host/routes/session/stream/get.ts:24` |
| 心跳间隔 15s；重连提示 1s 只随首帧数据 | `packages/dsh-tauri-pet/src/shared/constants.ts:18`、`packages/dsh-tauri-pet/src/shared/constants.ts:15`、`packages/dsh-tauri-pet/src/host/routes/session/stream/get.ts:42` |
| 有消费者才挂会话总线（4 条监听） | `packages/dsh-tauri-pet/src/host/service/session-stream.ts:67` |
| 客户端守卫：**仅在 iframe 内生效** | `packages/dsh-tauri-pet/src/client/index.ts:24` |
| 槽位：`settings.section`（id `dsh-tauri-pet-settings`，order 230） | `packages/dsh-tauri-pet/src/client/register/pet-section.ts:11`、`packages/dsh-tauri-pet/src/client/constants/index.ts:4` |
| 槽位：`conversation.input.left`（id `dsh-tauri-pet-prefill`，order 230） | `packages/dsh-tauri-pet/src/client/register/prefill.ts:14`、`packages/dsh-tauri-pet/src/client/constants/index.ts:19` |
| 侧栏 DOM 补丁标记 `data-dsh-tauri-pet-icon`、`aria-pressed` | `packages/dsh-tauri-pet/src/client/constants/index.ts:38`、`packages/dsh-tauri-pet/src/client/register/sidebar-icon.utils.ts:15` |
| 侧栏就绪轮询：500ms × 最多 30 次，外加 MutationObserver 看护 | `packages/dsh-tauri-pet/src/client/constants/index.ts:40`、`packages/dsh-tauri-pet/src/client/constants/index.ts:41`、`packages/dsh-tauri-pet/src/client/register/sidebar-icon.ts:105` |
| Tauri 命令：`get_pet_status` / `set_pet_enabled` / `set_active_pet` / `set_pet_size` / `list_pets` / `import_pet` / `list_preset_pets` | `packages/dsh-tauri-pet/src/client/constants/index.ts:25` |
| 桥实现：postMessage + 15s 超时 | `packages/dsh-tauri/src/client/service/invoke.ts:12`、`packages/dsh-tauri/src/client/service/invoke.ts:44` |
| 桌宠窗口 label `pet`，页面 `pet.html` | `src-tauri/src/desktop/pet.rs:30`、`src-tauri/src/desktop/pet.rs:303` |
| 原生命令注册 | `src-tauri/src/desktop/builder.rs:945`、`src-tauri/src/desktop/builder.rs:952` |
| 尺寸范围 50–200 | `packages/dsh-tauri-pet/src/client/constants/index.ts:45`、`packages/dsh-tauri-pet/src/client/constants/index.ts:46` |

---

## 2. L2：宿主侧（HTTP 字节）

### [P1] 验证 SSE 路由连上后立刻下发就绪帧

[Case ID] TC-PET-L2-001
[层级] L2（真实 dsh 进程）
[类型] 正向
[追踪] `packages/dsh-tauri-pet/src/host/routes/session/stream/get.ts:24`；`plugin.test.md` §8 批次 3
[自动化] 是（`test/e2e/plugins/session-stream.e2e.ts:37`）
[前置条件] 插件已构建并挂载进 scratch profile；宿主已就绪
[测试数据] `GET /api/desktop/dsh-tauri-pet/session/stream`，`accept: text/event-stream`
[测试步骤] 1. 发起请求。2. 读状态码与 `content-type`。3. 读响应体前 4 个字符后中止流。
[预期结果] 1. 状态码 200。2. `content-type` 含 `text/event-stream`。3. 前 4 个字符匹配 `^:\s*keepalive`。
[清理] `reader.cancel()` 中止连接

### [P3] [反向] 验证同一路径拒绝未声明的方法

[Case ID] TC-PET-L2-002
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri/src/host/routes/index.ts:275`
[自动化] 是（`test/e2e/plugins/session-stream.e2e.ts:49`）
[前置条件] 同 TC-PET-L2-001
[测试数据] 同路径 `POST`，body `{}`
[测试步骤] 1. 发起请求。2. 读状态码与 `allow` 头。
[预期结果] 1. 状态码 405。2. `allow` 包含 `GET`。
[清理] 无

### [P4] 验证长连接期间按 15s 周期持续下发心跳注释帧

[Case ID] TC-PET-L2-003
[层级] L2（真实 dsh 进程）
[类型] 边界
[追踪] `packages/dsh-tauri-pet/src/host/routes/session/stream/get.ts:58`
[自动化] 是（同上文件，新增）
[前置条件] 同 TC-PET-L2-001；用例超时预算 ≥ 20s
[测试数据] 保持连接 17s
[测试步骤] 1. 建立 SSE 连接。2. 累计读取响应体，直到出现第 2 次 `keepalive` 或超时。
[预期结果] 1. 在 15s–17s 窗口内收到第 2 帧 `: keepalive`。2. 两帧之间无 `data:` 帧（无会话事件时不应伪造数据）。
[清理] 中止连接

### [P2] 验证连接断开后重连仍能立刻拿到就绪帧

[Case ID] TC-PET-L2-004
[层级] L2（真实 dsh 进程）
[类型] 回归
[追踪] `packages/dsh-tauri-pet/src/host/service/session-stream.ts:36`
[自动化] 是（同上文件）
[前置条件] 同 TC-PET-L2-001
[测试数据] 连续建立两次连接
[测试步骤] 1. 建立连接 A，读到 `: keepalive` 后立即中止。2. 间隔 200ms 建立连接 B。
[预期结果] 1. 连接 B 同样在首个响应块内返回 `: keepalive`。2. 宿主日志中不出现未捕获异常或 `ERR_STREAM_` 类错误。
[清理] 中止连接 B

### [P4] 验证两个并发消费者各自独立就绪

[Case ID] TC-PET-L2-005
[层级] L2（真实 dsh 进程）
[类型] 边界
[追踪] `packages/dsh-tauri-pet/src/host/config/runtime.ts:8`
[自动化] 是（同上文件）
[前置条件] 同 TC-PET-L2-001
[测试数据] 同时发起两次 GET
[测试步骤] 1. 并发建立连接 A、B。2. 分别读取首个响应块。
[预期结果] 1. 两条连接均返回 200 且各自收到 `: keepalive`。2. 任一连接中止后，另一条仍可继续读取（互不牵连）。
[清理] 中止两条连接

---

## 3. L2：客户端（真实浏览器页面，未接线）

> 本组依赖浏览器驱动（Playwright 库 API）。当前仓库未安装 `playwright`（见 `00-overview.md` G2），全部标注**未接线**，不得写成 `it()`。

### [P4] 验证顶层页面不注册任何桌宠槽位

[Case ID] TC-PET-C-001
[层级] L2（真实浏览器页面，未接线）
[类型] 边界
[追踪] `packages/dsh-tauri-pet/src/client/index.ts:24`
[自动化] 未接线（依赖 G2）
[前置条件] 直接打开 `dsh web` 页面（非 iframe）；插件已挂载
[测试数据] 无
[测试步骤] 1. 打开顶层页面并等待首屏完成。2. 查询 `settings.section` 内是否存在 `dsh-tauri-pet-settings`。3. 查询 `[data-dsh-tauri-pet-icon]`。
[预期结果] 1. 两者均不存在（`window.parent === window` 时 client 直接 return）。2. 页面无插件前缀的 `console.error`。
[清理] 关闭页面

### [P2] 验证 iframe 内桌宠设置分区正常渲染且无崩溃

[Case ID] TC-PET-C-002
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-pet/src/client/register/pet-section.ts:11`
[自动化] 未接线（依赖 G2）
[前置条件] 页面被壳层以 iframe 嵌入（`window.parent !== window`）；`slots` 服务可用
[测试数据] 无
[测试步骤] 1. 等待设置分区注册完成。2. 断言 id 为 `dsh-tauri-pet-settings` 的分区存在。3. 收集 `pageerror`。
[预期结果] 1. 分区存在且 order 为 230（与相邻分区排序一致）。2. `pageerror` 集合为空。
[清理] 关闭页面

### [P2] 验证侧栏桌宠入口按钮被插入到设置触发器右侧且状态可读

[Case ID] TC-PET-C-003
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-pet/src/client/register/sidebar-icon.ts:94`、`packages/dsh-tauri-pet/src/client/register/sidebar-icon.utils.ts:25`
[自动化] 未接线（依赖 G2）
[前置条件] 侧栏 `[data-slot="sidebar"]` 与 `.dshp-settings-trigger` 均已存在
[测试数据] 无
[测试步骤] 1. 等待 `[data-dsh-tauri-pet-icon]` 出现。2. 读该按钮的 `previousElementSibling`。3. 读 `aria-pressed`。
[预期结果] 1. 按钮存在且唯一（guard 属性防重复插入）。2. `previousElementSibling` 是 `.dshp-settings-trigger`。3. `aria-pressed` 为 `"true"` 或 `"false"` 之一，且与 `get_pet_status` 返回的 `enabled` 一致。
[清理] 关闭页面

### [P4] 验证侧栏长时间未就绪时停止轮询且不抛错

[Case ID] TC-PET-C-004
[层级] L2（真实浏览器页面，未接线）
[类型] 边界
[追踪] `packages/dsh-tauri-pet/src/client/register/sidebar-icon.ts:110`
[自动化] 未接线（依赖 G2）
[前置条件] 页面加载后人为移除/阻止侧栏渲染
[测试数据] 无
[测试步骤] 1. 在侧栏缺失的状态下等待 ≥ 16s（30 × 500ms）。2. 收集 `pageerror` 与未处理 rejection。
[预期结果] 1. 无异常抛出。2. 轮询停止后不再产生新的 DOM 查询副作用（以 `MutationObserver` 回调计数不再增长验证）。
[清理] 关闭页面

---

## 4. L3：桌面端宿主（真实 Tauri 窗口）

### [P1] 验证启用桌宠后出现独立的桌宠窗口

[Case ID] TC-PET-L3-001
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/desktop/pet.rs:30`、`src-tauri/src/desktop/pet.rs:303`；`plugin.test.md` §8 批次 4+
[自动化] 待接线（`desktop` project 未配置，见 `00-overview.md` G4）
[前置条件] debug 二进制与 `dist/` 就绪；`3081` 与 WebDriver 端口空闲；`TAURI_WEBDRIVER_PORT` 已设置；宿主 harness 已就绪
[测试数据] 通过设置页或桥命令将 `enabled` 置为 true
[测试步骤] 1. `POST /session` 建会话。2. 读 `GET /session/<id>/window/handles` 基线。3. 触发启用。4. 轮询窗口句柄集合。
[预期结果] 1. 基线恰为 `["main"]`。2. 触发后集合包含 `pet`。3. 过程中 `get_pet_status` 返回 `enabled: true`。
[清理] `set_pet_enabled(false)`，读窗口集合回到 `["main"]`；再 `DELETE /session/<id>`

### [P3] [反向] 验证未启用桌宠时不存在桌宠窗口

[Case ID] TC-PET-L3-002
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `packages/dsh-tauri-pet/src/client/service/pet.types.ts:6`
[自动化] 待接线（G4）
[前置条件] 干净数据目录（首个会话，`enabled` 默认关闭）
[测试数据] 无
[测试步骤] 1. 启动应用并建会话。2. 读窗口句柄集合。3. 读 `get_pet_status`。
[预期结果] 1. 窗口集合恰为 `["main"]`。2. `enabled` 为 false。
[清理] `DELETE /session/<id>`

### [P2] 验证侧栏入口按钮切换后窗口随之创建与销毁

[Case ID] TC-PET-L3-003
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `packages/dsh-tauri-pet/src/client/register/sidebar-icon.ts:48`
[自动化] 待接线（G4）
[前置条件] 同 TC-PET-L3-001；内置 DSH 界面已加载完侧栏
[测试数据] 点击 `[data-dsh-tauri-pet-icon]` 两次
[测试步骤] 1. 记录点击前窗口集合与 `aria-pressed`。2. 点击按钮。3. 轮询窗口集合与 `aria-pressed`。4. 再次点击。
[预期结果] 1. 首次点击后 `aria-pressed="true"` 且窗口集合包含 `pet`。2. 二次点击后 `aria-pressed="false"` 且窗口集合回到 `["main"]`。3. 无 `PET_WINDOW_CREATE_FAILED` / `PET_WINDOW_DESTROY_FAILED` 错误文案。
[清理] `DELETE /session/<id>`

### [P4] 验证桌宠尺寸边界被夹紧到 50–200

[Case ID] TC-PET-L3-004
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `packages/dsh-tauri-pet/src/client/constants/index.ts:45`、`packages/dsh-tauri-pet/src/client/constants/index.ts:46`
[自动化] 待接线（G4）
[前置条件] 桌宠已启用
[测试数据] 依次提交 `0`、`50`、`200`、`999`
[测试步骤] 1. 逐值调用 `set_pet_size`。2. 每次读 `get_pet_status().pet_size`。
[预期结果] 1. 越界值被夹紧到 50 或 200。2. 合法值原样回读。3. 过程中不出现窗口尺寸错误文案。
[清理] 恢复默认尺寸并 `DELETE /session/<id>`

---

## 5. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `plugin.test.md` §8 批次 3（SSE 首帧） | TC-PET-L2-001、TC-PET-L2-002 | 正向 / 异常 | 已落地 |
| `get.ts:58` 心跳 | TC-PET-L2-003 | 边界 | 用例耗时 ≥ 17s，不进冒烟子集 |
| `session-stream.ts:36` 消费者注销 | TC-PET-L2-004、TC-PET-L2-005 | 回归 / 边界 | 注销本身只能经重连间接观察 |
| `client/index.ts:24` iframe 守卫 | TC-PET-C-001 | 边界 | 依赖浏览器驱动 |
| `pet-section.ts:11` / `sidebar-icon.ts:94` | TC-PET-C-002、TC-PET-C-003 | 正向 | 依赖浏览器驱动 |
| `sidebar-icon.ts:110` 轮询兜底 | TC-PET-C-004 | 边界 | 需人为阻断侧栏 |
| `plugin.test.md` §8 批次 4+（桌面端窗口） | TC-PET-L3-001、TC-PET-L3-002、TC-PET-L3-003 | 正向 / 异常 | 依赖 `desktop` project |
| `constants/index.ts:45` 尺寸范围 | TC-PET-L3-004 | 边界 | — |

---

## 6. 缺口与假设

- **G-PET-1**：数据帧形状（`data: {"action","payload"}`，`packages/dsh-tauri-pet/src/host/types/index.ts:53`）与首帧 `retry: 1000` 需要真实会话事件才能观察。当前无「触发一次会话事件」的稳定手段，**未覆盖**；建议后续用 scratch profile 直接 POST 一次会话动作后再断言帧形状。
- **G-PET-2**：`window.handles` 是否包含 Tauri 的多 WebView 窗口（`pet`）尚未验证——`wdio-probe.mjs:146` 只在默认状态断言了 `["main"]`。若驱动只暴露主窗口，TC-PET-L3-001 需改用原生窗口枚举（Rust 侧）或前端 `get_pet_status().visible`。
- **G-PET-3**：`packages/dsh-tauri-pet/skills/` 在本 checkout 不存在，而 `cordis.patch.yml` 引用了它；技能相关的用户可见产物**不在覆盖范围**，直到该目录真实存在。
- **假设**：`sidebar-icon.utils.ts:25` 的 `aria-pressed` 与 store 中 `status.enabled` 同步（`sidebar-icon.ts:71` 订阅保证）。
