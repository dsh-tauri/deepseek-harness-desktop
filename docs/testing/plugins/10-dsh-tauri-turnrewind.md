# dsh-tauri-turnrewind：回合级撤销的三个端点

> 层级：L2 插件宿主 E2E → L3 桌面端宿主 E2E
> 自动化：`test/e2e/plugins/turnrewind-routes.e2e.ts`（待建立）；客户端与 L3 见各用例标注
> 前置：`pnpm build:plugins`；真实撤销链路另需 git 仓库与会话数据
> 运行：L2 `pnpm test:e2e:plugin`；L3 见 `00-overview.md` §5.2

本插件的判定全部依赖**会话与工作区上下文**，而 scratch 宿主当前不造会话。因此本文件的 L2 用例刻意只覆盖**在无会话条件下即可判定**的分支：入参校验、会话缺失、方法矩阵。真实撤销链路列入缺口。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| `PLUGIN_ID = 'dsh-tauri-turnrewind'` | `packages/dsh-tauri-turnrewind/src/shared/constants.ts:10` |
| 3 条路由：`GET /summary`、`GET /live`、`POST /turns/undo` | `packages/dsh-tauri-turnrewind/src/host/routes/index.ts:19` |
| 缺 `sessionId` → 400 `缺少 sessionId`（三处） | `packages/dsh-tauri-turnrewind/src/host/routes/live/get.ts:15`、`packages/dsh-tauri-turnrewind/src/host/routes/summary/get.ts:22`、`packages/dsh-tauri-turnrewind/src/host/routes/turns/undo/post.ts:25` |
| 会话不存在 → 404 `会话不存在或尚未就绪` | `packages/dsh-tauri-turnrewind/src/host/routes/summary/get.ts:26`、`packages/dsh-tauri-turnrewind/src/host/routes/turns/undo/post.ts:33` |
| `turn` 非正整数 → 400 `turn 必须是正整数` | `packages/dsh-tauri-turnrewind/src/host/routes/turns/undo/post.ts:29` |
| undo 业务码：409 `TURNREWIND_TURN_ACTIVE` / `ALREADY_UNDONE` / `EXPIRED` / `CONFLICT` / `WORKSPACE_BUSY`，403 工作区漂移，500 预检失败 | `packages/dsh-tauri-turnrewind/src/host/service/undo.ts:38`、`packages/dsh-tauri-turnrewind/src/host/service/undo.ts:49`、`packages/dsh-tauri-turnrewind/src/host/service/undo.ts:63`、`packages/dsh-tauri-turnrewind/src/host/service/undo.ts:84`、`packages/dsh-tauri-turnrewind/src/host/service/undo.ts:91`、`packages/dsh-tauri-turnrewind/src/host/service/undo.ts:53`、`packages/dsh-tauri-turnrewind/src/host/service/undo.ts:82` |
| summary 上限：200 个文件 / 20 条跳过路径 | `packages/dsh-tauri-turnrewind/src/host/routes/summary/get.ts:15`、`packages/dsh-tauri-turnrewind/src/host/routes/summary/get.ts:17` |
| 资格原因码 `GIT_REQUIRED` / `GIT_UNAVAILABLE` / `UNSAFE_WORKSPACE` | `packages/dsh-tauri-turnrewind/src/shared/constants.ts:16`、`packages/dsh-tauri-turnrewind/src/shared/constants.ts:22`、`packages/dsh-tauri-turnrewind/src/host/config/constants.ts:58` |
| 客户端槽位：`conversation.input.dock`（running chip）、`conversation.chat.turnTail`（回合卡片） | `packages/dsh-tauri-turnrewind/src/client/constants/index.ts:15`、`packages/dsh-tauri-turnrewind/src/client/register/turn-tail.ts:25` |
| DOM 标记：`data-turnrewind-card` / `data-turnrewind-running` / `data-status` / `data-skipped` | `packages/dsh-tauri-turnrewind/src/client/components/turn-changes-card.tsx:142`、`packages/dsh-tauri-turnrewind/src/client/components/running-changes-chip.tsx:38`、`packages/dsh-tauri-turnrewind/src/client/components/turn-changes-card.tsx:118`、`packages/dsh-tauri-turnrewind/src/client/components/turn-changes-card.tsx:231` |
| live 轮询 1200ms | `packages/dsh-tauri-turnrewind/src/client/constants/index.ts:21` |

---

## 2. L2：宿主路由

### [P3] [反向] 验证三个端点缺 sessionId 均返回 400

[Case ID] TC-REW-L2-001
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-turnrewind/src/host/routes/live/get.ts:15`、`packages/dsh-tauri-turnrewind/src/host/routes/summary/get.ts:22`、`packages/dsh-tauri-turnrewind/src/host/routes/turns/undo/post.ts:25`
[自动化] 是（`test/e2e/plugins/turnrewind-routes.e2e.ts`）
[前置条件] 插件已构建并挂载
[测试数据] `GET /summary`、`GET /live`（不带查询串）；`POST /turns/undo`，body `{ "turn": 1 }`
[测试步骤] 1. 逐一发起请求。2. 每次读状态码与 `error` 文案。
[预期结果] 1. 三次均返回 400。2. 三次 `error` 均恰为 `缺少 sessionId`。3. `POST` 用例中未发生任何文件系统改动。
[清理] 无

### [P3] [反向] 验证未知会话的摘要与撤销均返回 404

[Case ID] TC-REW-L2-002
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-turnrewind/src/host/routes/summary/get.ts:26`
[自动化] 是
[前置条件] 同 TC-REW-L2-001
[测试数据] `GET /summary?sessionId=does-not-exist`；`POST /turns/undo` body `{ "sessionId": "does-not-exist", "turn": 1 }`
[测试步骤] 1. 两次发起请求。2. 读状态码与 `error` 文案。
[预期结果] 1. 两次均 404。2. `error` 均恰为 `会话不存在或尚未就绪`。
[清理] 无

### [P4] [反向] 验证非法 turn 值在查会话之前就被拒

[Case ID] TC-REW-L2-003
[层级] L2（真实 dsh 进程）
[类型] 边界
[追踪] `packages/dsh-tauri-turnrewind/src/host/routes/turns/undo/post.ts:29`
[自动化] 是
[前置条件] 同 TC-REW-L2-001
[测试数据] `{ "sessionId": "does-not-exist", "turn": 0 }`、`{ … "turn": -1 }`、`{ … "turn": "1" }`
[测试步骤] 1. 逐一发起请求。2. 每次读状态码与 `error`。
[预期结果] 1. 三次均 400（顺序上先于 404 的会话查询）。2. `error` 均恰为 `turn 必须是正整数`。
[清理] 无

### [P4] 验证三条路径的方法集合互不相同

[Case ID] TC-REW-L2-004
[层级] L2（真实 dsh 进程）
[类型] 边界
[追踪] `packages/dsh-tauri-turnrewind/src/host/routes/index.ts:19`
[自动化] 是
[前置条件] 同 TC-REW-L2-001
[测试数据] 对 `/summary`、`/live`、`/turns/undo` 各发一次 `OPTIONS`
[测试步骤] 1. 逐一 `OPTIONS`。2. 读 `allow` 头。
[预期结果] 1. `/summary` 与 `/live` 的 `allow` 含 `GET`、`HEAD`、`OPTIONS`。2. `/turns/undo` 的 `allow` 含 `POST`、`OPTIONS` 而**不含** `GET`。3. 三条均返回 204。
[清理] 无

---

## 3. L2：客户端（真实浏览器页面，未接线）

### [P2] 验证回合结束后出现变更卡片

[Case ID] TC-REW-C-001
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-turnrewind/src/client/components/turn-changes-card.tsx:142`
[自动化] 未接线（`00-overview.md` G2）
[前置条件] iframe 内 dsh 界面已加载；工作区为 git 仓库顶层；至少完成一个回合
[测试数据] 无
[测试步骤] 1. 等待回合结束。2. 查询 `[data-turnrewind-card]`。3. 读其值与 `data-status` 明细。
[预期结果] 1. 卡片存在且 `data-turnrewind-card` 等于该回合序号。2. 卡片内文件行均为 `data-status="…"` 之一。3. 无 `pageerror`。
[清理] 关闭页面

### [P2] 验证回合运行中显示 running chip

[Case ID] TC-REW-C-002
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-turnrewind/src/client/components/running-changes-chip.tsx:38`
[自动化] 未接线（G2）
[前置条件] 同 TC-REW-C-001，但回合仍在进行
[测试数据] 无
[测试步骤] 1. 在回合进行中查询 `[data-turnrewind-running]`。2. 回合结束后再次查询。
[预期结果] 1. 进行中存在该标记且值等于当前回合。2. 回合结束后标记消失。
[清理] 关闭页面

### [P3] [反向] 验证非 git 工作区时卡片展示原因而非空白

[Case ID] TC-REW-C-003
[层级] L2（真实浏览器页面，未接线）
[类型] 异常
[追踪] `packages/dsh-tauri-turnrewind/src/client/components/turn-changes-card.tsx:231`
[自动化] 未接线（G2）
[前置条件] 会话工作区不是 git 仓库顶层
[测试数据] 无
[测试步骤] 1. 完成一个回合。2. 查询卡片内容。
[预期结果] 1. 卡片存在但无可撤销文件行。2. 文案对应 `gitRequiredReason`（非空字符串，且不是 `unavailable` 之类的内部码）。3. `pageerror` 为空。
[清理] 关闭页面

---

## 4. L3：桌面端宿主（真实 Tauri 窗口）

### [P2] 验证桌面端回合卡片可见且撤销按钮可用

[Case ID] TC-REW-L3-001
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `packages/dsh-tauri-turnrewind/src/client/register/turn-tail.ts:25`
[自动化] 待接线（`desktop` project 未配置，`00-overview.md` G4）
[前置条件] 应用就绪；工作区为 git 仓库顶层；已产生一个带文件改动的回合
[测试数据] 无
[测试步骤] 1. 建 WebDriver 会话并切到 iframe。2. 查询 `[data-turnrewind-card]`。3. 点击其撤销按钮并确认。
[预期结果] 1. 卡片存在且文件计数与 `GET /summary` 返回一致。2. 撤销后再次读 `summary`，该回合 `undoneAt` 非空。3. 工作区文件回到该回合前状态（抽样比对 1 个文件）。
[清理] 恢复改动；`DELETE /session/<id>`

---

## 5. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 三处缺参校验 | TC-REW-L2-001 | 异常 | — |
| 会话缺失判定 | TC-REW-L2-002 | 异常 | — |
| `turn` 校验顺序 | TC-REW-L2-003 | 边界 | — |
| 方法矩阵 | TC-REW-L2-004 | 边界 | — |
| 卡片与运行态 | TC-REW-C-001、TC-REW-C-002、TC-REW-L3-001 | 正向 | 需要真实 git 仓库与回合数据 |
| 非 git 降级 | TC-REW-C-003 | 异常 | 需要非 git 工作区 |
| undo 的 7 类业务码（409/403/500） | — | — | **未覆盖**：需要真实账本、并发与漂移构造，见 G-REW-1 |
| `GET /live` 读数 | — | — | **未覆盖**：无会话时语义未确认，见 G-REW-2 |

---

## 6. 缺口与假设

- **G-REW-1**：撤销的业务码矩阵（`packages/dsh-tauri-turnrewind/src/host/service/undo.ts:38` 起）需要真实账本与工作区漂移。当前 scratch 宿主无法制造这些前置，**整段未覆盖**，是本套文档最大的功能盲区。
- **G-REW-2**：`GET /live` 只读内存缓存（`packages/dsh-tauri-turnrewind/src/host/service/capture.ts:207`），对未知 `sessionId` 是否返回 200 `active:false` 还是 404，源码未体现；确认前不写用例，避免编造预期。
- **G-REW-3**：`turn-tail` 复用官方 id `@deepseek-ai/dsh-client-ui-deliverables`（`packages/dsh-tauri-turnrewind/src/client/register/turn-tail.ts:28`）。若官方插件同时装载，需先确认两者不争抢同一行。
- **假设**：用例断言的 `data-turnrewind-*` 属性属于插件自有前缀，不受宿主类名变化影响。
