# dsh-tauri-panel-scheduler：定时任务面板与任务生命周期

> 层级：L2 插件宿主 E2E → L3 桌面端宿主 E2E
> 自动化：`packages/dsh-tauri-panel-scheduler/test/scheduler-routes.e2e.ts`（待建立）；客户端与 L3 见各用例标注
> 前置：`pnpm build:plugins`；会真实创建任务的用例需在网络/模型可用时才执行
> 运行：L2 `pnpm test:e2e:plugin`；L3 见 `00-overview.md` §5.2

本插件同时暴露 **HTTP 路由**、**5 个 Agent 工具** 与 **落盘任务账本**。渐进顺序：**只读清单** → **缺参与领域拒绝** → **落盘形态** → **面板呈现**。真实执行（跑一次任务）需要模型与网络，归入后续批次。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| `PLUGIN_ID = 'dsh-tauri-panel-scheduler'` | `packages/dsh-tauri-panel-scheduler/src/shared/constants.ts:9` |
| 10 条 exact 路由 | `packages/dsh-tauri-panel-scheduler/src/host/routes/index.ts:14` |
| `GET /tasks` 支持 `search`，阻塞项带 `waiting: true` | `packages/dsh-tauri-panel-scheduler/src/host/routes/tasks/get.ts:12` |
| `DELETE /tasks` 缺参/不存在均为 400 中文文案 | `packages/dsh-tauri-panel-scheduler/src/host/routes/tasks/delete.ts:6` |
| `POST /tasks/run` 三态 400（缺 id / 执行中 / 不存在） | `packages/dsh-tauri-panel-scheduler/src/host/service/scheduler.ts:23` |
| `GET /history` 按 `startedAt` 倒序 | `packages/dsh-tauri-panel-scheduler/src/host/service/runs.ts:15` |
| 任务账本 `$DSH_HOME/crons/tasks` 为 `{version:1,tasks:[…]}` | `packages/dsh-tauri-panel-scheduler/src/host/service/task.ts:124`、`packages/dsh-tauri-panel-scheduler/src/host/storage/index.ts:4` |
| 执行记录账本 `$DSH_HOME/crons/runs`，上限 200 | `packages/dsh-tauri-panel-scheduler/src/host/service/runs.ts:9`、`packages/dsh-tauri-panel-scheduler/src/host/service/runs.ts:60` |
| 调度 tick 1s，并发上限 4 | `packages/dsh-tauri-panel-scheduler/src/host/apply.ts:13`、`packages/dsh-tauri-panel-scheduler/src/host/service/scheduler.ts:10` |
| 任务校验：name ≤120、prompt ≤64000、schedule 合法 | `packages/dsh-tauri-panel-scheduler/src/host/service/task.ts:155` |
| Agent 工具：`scheduler_create/list/toggle/delete/run_now` | `packages/dsh-tauri-panel-scheduler/src/host/tools/create-task.ts:19`、`packages/dsh-tauri-panel-scheduler/src/host/tools/run-task.ts:6` |
| 面板 `definePanel` order 30；面板外 5s 轮询 | `packages/dsh-tauri-panel-scheduler/src/client/register/panel.tsx:34`、`packages/dsh-tauri-panel-scheduler/src/client/constants/index.ts:26` |
| 会话行时钟标记 `data-dsh-scheduler-icon="1"` | `packages/dsh-tauri-panel-scheduler/src/client/constants/index.ts:23`、`packages/dsh-tauri-panel-scheduler/src/client/register/session-icons.ts:46` |

---

## 2. L2：宿主路由

### [P1] 验证干净环境下任务清单为空

[Case ID] TC-SCH-L2-001
[层级] L2（真实 dsh 进程）
[类型] 正向
[追踪] `packages/dsh-tauri-panel-scheduler/src/host/routes/tasks/get.ts:8`
[自动化] 是（`packages/dsh-tauri-panel-scheduler/test/scheduler-routes.e2e.ts`）
[前置条件] scratch `DSH_HOME` 全新
[测试数据] `GET /api/desktop/dsh-tauri-panel-scheduler/tasks`
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 200。2. 响应体含 `tasks` 数组字段且为空。3. 无 `error` 字段。
[清理] 无

### [P2] 验证创建任务后清单与账本一致

[Case ID] TC-SCH-L2-002
[层级] L2（真实 dsh 进程）
[类型] 正向
[追踪] `packages/dsh-tauri-panel-scheduler/src/host/routes/tasks/post.ts:6`
[自动化] 是
[前置条件] 同 TC-SCH-L2-001
[测试数据] `{ "name": "e2e-smoke", "prompt": "say hi", "schedule": { "kind": "daily", "time": "09:00" } }`
[测试步骤] 1. `POST /tasks`。2. 读响应体 `task.id` 与 `task.nextRunAt`。3. `GET /tasks` 搜索 `e2e-smoke`。4. 读 scratch 目录下 `crons/tasks` 文件内容。
[预期结果] 1. 创建返回 200 且 `ok: true`。2. `task.id` 形如 `task-<uuid>`；`nextRunAt` 为未来时间戳。3. 清单中恰好 1 条同名任务。4. 账本文件为 `{"version":1,"tasks":[…]}` 且含该 id。
[清理] `DELETE /tasks` 删除该任务；断言清单回到空

### [P3] [反向] 验证创建任务缺字段返回 400

[Case ID] TC-SCH-L2-003
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-panel-scheduler/src/host/routes/tasks/post.ts:13`
[自动化] 是
[前置条件] 同 TC-SCH-L2-001
[测试数据] 依次提交 `{}`、缺 `prompt`、`schedule.kind` 为非法值
[测试步骤] 1. 逐一提交。2. 每次读状态码与响应体。
[预期结果] 1. 三次均 400。2. 每次响应体含非空 `error` 字符串。3. 清单仍为空（未落盘半成品）。
[清理] 无

### [P3] [反向] 验证删除任务的两类 400 文案可区分

[Case ID] TC-SCH-L2-004
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-panel-scheduler/src/host/routes/tasks/delete.ts:6`
[自动化] 是
[前置条件] 同 TC-SCH-L2-001
[测试数据] body `{}`；再以 `{ "id": "task-missing" }` 请求
[测试步骤] 1. 两次 `DELETE /tasks`。2. 读状态码与 `error` 文案。
[预期结果] 1. 第一次 `error` 为 `缺少任务 id`。2. 第二次 `error` 为 `任务不存在`。3. 两次状态码均为 400。
[清理] 无

### [P3] [反向] 验证立即执行不存在的任务返回 400

[Case ID] TC-SCH-L2-005
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-panel-scheduler/src/host/routes/tasks/run/post.ts:6`
[自动化] 是
[前置条件] 同 TC-SCH-L2-001
[测试数据] `POST /tasks/run`，body `{ "id": "task-missing" }`
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 400。2. 响应体 `error` 恰为 `任务不存在`。3. `GET /history` 无新增记录。
[清理] 无

### [P4] 验证执行记录删除的两类 400 文案可区分

[Case ID] TC-SCH-L2-006
[层级] L2（真实 dsh 进程）
[类型] 边界
[追踪] `packages/dsh-tauri-panel-scheduler/src/host/routes/history/delete.ts:6`
[自动化] 是
[前置条件] 同 TC-SCH-L2-001
[测试数据] body `{}`；再以 `{ "id": "run-missing" }` 请求
[测试步骤] 1. 两次 `DELETE /history`。2. 读状态码与 `error` 文案。
[预期结果] 1. 第一次 `error` 为 `缺少执行记录 id`。2. 第二次 `error` 为 `执行记录不存在`。3. 两次状态码均为 400。
[清理] 无

### [P4] 验证选项端点返回可用集合并随环境变化

[Case ID] TC-SCH-L2-007
[层级] L2（真实 dsh 进程）
[类型] 边界
[追踪] `packages/dsh-tauri-panel-scheduler/src/host/routes/options/get.ts:6`
[自动化] 是
[前置条件] 同 TC-SCH-L2-001
[测试数据] `GET /options`
[测试步骤] 1. 发起请求。2. 读状态码与响应体字段名。
[预期结果] 1. 状态码 200。2. 响应体为对象（非数组、非空）。

---

## 3. L2：客户端（真实浏览器页面，未接线）

### [P1] 验证调度面板渲染并含两个标签

[Case ID] TC-SCH-C-001
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-panel-scheduler/src/client/components/scheduler-panel.tsx:139`
[自动化] 未接线（`00-overview.md` G2）
[前置条件] iframe 内 dsh 界面已加载；`sidebar.panellist` 可用
[测试数据] 无
[测试步骤] 1. 打开调度面板。2. 查询 `.dshp-scheduler__shell` 与 `[role="tab"]`。3. 收集 `pageerror`。
[预期结果] 1. 面板根存在。2. tablist 内恰有 2 个标签，且恰有一个 `aria-selected="true"`。3. `pageerror` 为空。
[清理] 关闭面板

### [P2] 验证新建任务对话框的字段与校验提示

[Case ID] TC-SCH-C-002
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-panel-scheduler/src/client/components/task-create-dialog.tsx:183`
[自动化] 未接线（G2）
[前置条件] 同 TC-SCH-C-001
[测试数据] 名称留空提交一次，再填合法值提交一次
[测试步骤] 1. 点击「新建任务」。2. 直接提交。3. 查询 `.dshp-scheduler__modal` 内 `[role="alert"]`。4. 填写名称与指令后提交。
[预期结果] 1. 对话框出现且含名称输入、计划类型、指令文本域。2. 空提交后对话框仍在且出现 `[role="alert"]` 提示。3. 合法提交后对话框关闭且任务卡片列表新增 1 项。
[清理] 删除新建的任务

### [P2] 验证会话行出现调度图标且不重复插入

[Case ID] TC-SCH-C-003
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-panel-scheduler/src/client/register/session-icons.ts:46`
[自动化] 未接线（G2）
[前置条件] 侧栏存在至少一条会话行
[测试数据] 无
[测试步骤] 1. 等待会话行渲染。2. 查询 `[data-dsh-scheduler-icon]`。3. 触发一次重渲染后再查询。
[预期结果] 1. 图标存在。2. 单行内数量恒为 1。
[清理] 关闭页面

---

## 4. L3：桌面端宿主（真实 Tauri 窗口）

### [P1] 验证桌面端可打开调度面板并持久化任务

[Case ID] TC-SCH-L3-001
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `packages/dsh-tauri-panel-scheduler/src/client/register/panel.tsx:34`
[自动化] 待接线（`desktop` project 未配置，`00-overview.md` G4）
[前置条件] 应用就绪；`<DSH_E2E_HOME>/home/.dsh.dev` 下无同名任务
[测试数据] 任务名 `e2e-l3-smoke`
[测试步骤] 1. 建 WebDriver 会话并切到 iframe。2. 打开调度面板并新建任务。3. 关闭并重新打开面板。4. 直接以 HTTP 读 `GET /tasks`。
[预期结果] 1. 面板内出现该任务卡片（标题等于任务名）。2. 重开面板后仍可见（5s 轮询内收敛）。3. HTTP 清单同样包含该任务。
[清理] 删除任务；`DELETE /session/<id>`

---

## 5. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `tasks/get.ts` 只读清单 | TC-SCH-L2-001 | 正向 | — |
| `tasks/post.ts` 创建与落盘 | TC-SCH-L2-002 | 正向 | 真实执行（`run_now`）不在此列 |
| `tasks/post.ts` 校验 | TC-SCH-L2-003 | 异常 | 长度上限（120 / 64000）未覆盖，见 G-SCH-2 |
| `tasks/delete.ts` 两类文案 | TC-SCH-L2-004 | 异常 | — |
| `tasks/run/post.ts` 不存在 | TC-SCH-L2-005 | 异常 | `任务正在执行中` 需要真实并发，**未覆盖** |
| `history/delete.ts` | TC-SCH-L2-006 | 边界 | — |
| `options/get.ts` | TC-SCH-L2-007 | 边界 | 字段级断言待确认 |
| 面板与对话框 | TC-SCH-C-001、TC-SCH-C-002、TC-SCH-L3-001 | 正向 | 依赖浏览器驱动 / `desktop` project |
| 会话行图标 | TC-SCH-C-003 | 正向 | 依赖浏览器驱动 |
| 5 个 Agent 工具 | — | — | **未覆盖**：需要 Agent 会话与工具调用通道 |

---

## 6. 缺口与假设

- **G-SCH-1**：面板每 5s 轮询（`packages/dsh-tauri-panel-scheduler/src/client/constants/index.ts:26`），与用户操作存在竞态。TC-SCH-L3-001 因此断言「重开面板后可见」而非「立刻可见」，并在失败信息中附上最后一次 `GET /tasks` 结果。
- **G-SCH-2**：`name` ≤120、`prompt` ≤64000、`schedule.kind` 为 8 种枚举之一（`packages/dsh-tauri-panel-scheduler/src/shared/constants.ts:12`）。边界值用例（120/121、64000/64001）留待后续批次。
- **G-SCH-3**：`GET /options` 的字段集未在事实基线中确认；TC-SCH-L2-007 故意只断言形状，避免编造字段名。
- **G-SCH-4**：`custom` 计划的 cron 串产出路径未核实（`packages/dsh-tauri-panel-scheduler/src/host/utils/schedule.ts:78`），相关表单用例**未覆盖**。
- **假设**：`crons` 落盘根随 scratch `DSH_HOME` 隔离（`fsAtomicDriver` 以 `DSH_HOME` 为基，`packages/dsh-tauri/src/host/utils/driver.ts:9`）。
