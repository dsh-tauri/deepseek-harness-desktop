# Scheduler 同步日志

用于记录 `source/dsh-automation` 能力同步到 `packages/dsh-tauri-scheduler` 的进度，避免后续重复对比或遗漏实现。

## 同步基线

- 参考项目：[`MichengAI/dsh-automation`](https://github.com/MichengAI/dsh-automation)
- 本次对比版本：`v0.1.51`（`ecfe1e6`，= 上游 `origin/main`）
- 已采纳基线：`f1bc91a`（`v0.1.32`）+ 宿主兼容跟进 `c426c3d`（`v0.1.35`，2026-09-10，适配 DSH `0.1.5-rc.1`）
- 2026-09-28 推进评估前沿至 `ecfe1e6`（`v0.1.51`）：`v0.1.33`–`v0.1.51` 全部已评估，仅采纳 3 项，其余不采纳或归档
- 当前版本：`1.0.0`
- 记录更新时间：2026-09-28

## 宿主兼容修复（DSH 0.1.5-rc.1）

### 现象

内核升级到 `0.1.5-rc.1` 后，面板的「立即执行」与「定时触发」全部失败：`$DSH_HOME/crons/runs`
中的运行记录错误恒为 `cannot get property "agent" without inject`。

### 根因

- `0.1.2-rc.1` 的 `@deepseek-ai/dsh-agent/lib/types/index.js` 注册了 DX accessor
  `ctx.accessor('agent', { get: () => undefined })`；`0.1.5-rc.1` 移除了该注册。
- 于是读取 `agentCtx.agent` 不再得到 `undefined`，而是被 Cordis 上下文代理抛出
  `cannot get property "agent" without inject`（`@deepseek-ai/cordis/lib/index.js:675`）。
- `@deepseek-ai/dsh-agent-loop/lib/index.js` 同步改为把 Agent 作为 setup 的第二参数传入
  （`setup?.(prepared.agent.ctx, prepared.agent)`），`agents.enter(agent, parentAgent)` 也不再从 ctx 读 Agent。
- 旧实现 `const agent = agentCtx.agent` 在 setup 阶段即抛错，`executeTask` 整体失败；
  立即执行与定时触发共用该路径，故同时失效。

### 修复（对齐上游 `c426c3d` / `v0.1.35`）

- `src/host/service/executor.ts`：新增 `SetupAgentLike` 与 `resolveSetupAgent(agentCtx, createdAgent)`；
  setup 签名改为 `(agentCtx, createdAgent?)`，取值 `createdAgent ?? agentCtx.agent`——`??` 短路保证
  新宿主上绝不触碰会抛错的 `agentCtx.agent`，旧宿主仍走上下文入口。
- `src/types/dsh.d.ts`：移除 `Context.agent` 声明，避免再把 accessor 当作稳定 API。
- `src/host/service/executor.test.ts`：新增 3 例覆盖「第二参数优先」「旧宿主回落」「两者皆无 → undefined」，
  其中第一例用会抛错的 getter 模拟 `0.1.5-rc.1` 的 Cordis 代理行为。

### 已核对仍存在（0.1.5-rc.1）的宿主 API

`agents.create` 的 `setup` 首参、`agents.withoutInitiator`、`agentPresets.mount(agentCtx, id)`、
`installModelSelection`（`@deepseek-ai/dsh-agent`）、`sessions.flush(session)`、
`ctx.permissionPresets`——除 `ctx.agent` 外执行路径无其它 API 漂移。

### 与上游的其它差异（本插件不适用）

- `cordis.patch.yml` 的 `connection.inject: [webServer, webRuntime]`：上游用它恢复 Web RPC 启动；
  本插件路由直接注册在自身作用域的 `ctx.webServer`（`inject` 已声明 `webServer`），无需该补丁。
- `knownSessionIds` 的 `canListStored` 判定与 `{ header }` 兜底：本插件没有会话枚举关联逻辑。

## 已同步

### P0

- [x] 移除 scheduler executor 固定 `UNATTENDED_TOOL_ALLOWLIST`。
- [x] 不再禁止 `bash` / `pwsh` 的 `run_in_background`。
- [x] 无人值守执行只应用 Host permission preset，并调用 `setApprovalPolicy('never')`。
- [x] 保留执行超时、取消与取消收敛逻辑。
- [x] 支持 `once`、`hourly`、`daily`、`interval`、`workdays`、`weekly`、`monthly`、`custom`。
- [x] `interval` / `custom` 支持固定 `anchor`，下一次执行按 anchor + N × step 计算。
- [x] 恢复逻辑将进程中断的 `running` 记录标记为 `interrupted`；`queued` 不作为已开始执行处理。

### P1

- [x] 执行状态增加 `interrupted`，同步中英文显示。
- [x] 任务卡片菜单增加显式 `Edit`。
- [x] 任务计划描述支持单次、每小时、每月、自定义周期。
- [x] 每月计划支持日期 `1–31` 与时间。
- [x] 自定义计划支持间隔天数 `1–366` 与时间。
- [x] 一次性计划使用 `datetime-local`，并在计划行内填充剩余宽度。
- [x] 恢复原有工具栏布局，不增加时间筛选 Select。

### P2/P3

- [x] 页面从隐藏状态恢复可见时刷新。
- [x] 页面重新获得焦点时刷新。
- [x] 保留已有删除确认、workspace 校验、卡片点击编辑、超时取消与并发上限。

## 明确未同步

以下能力依赖桌面端当前没有提供的 Archive Manager 或 session-folder 能力，本轮不实施：

- Web 专用 session folders。
- whole-group archive。
- host sync bridge。
- Archive Manager UI。

## 验证记录

### 并发上限「等待中」提示（2026-09-16）

```text
pnpm run lint                                       # 0 error（17 条既有 warning）
pnpm --filter dsh-tauri-scheduler typecheck   # tsc --noEmit 通过（0 error）
pnpm test -- --run                                  # 53 test files, 433 tests passed
pnpm --filter dsh-tauri-scheduler build        # tsdown 通过，publint 无问题
git diff --check                                    # 无输出
```

新增单测 `src/host/utils/waiting.test.ts`（5 例：容量为 0、名额内不等待、在跑数占用名额、
运行中/暂停/未到点均不等待）。

### DSH 0.1.5-rc.1 宿主兼容修复（2026-09-13）

```text
pnpm run test -- --run                          # 43 test files, 338 tests passed
pnpm run typecheck                              # tsc --noEmit 通过（0 error）
pnpm --filter dsh-tauri-scheduler build   # tsdown 构建通过，publint 无问题
pnpm exec eslint packages/dsh-tauri-scheduler/src --fix
```

Lint 当前只有既有 warning（6 条既有 React 规则提示），无新增 error。

### v0.1.32 同步（2026-09-07）

```text
pnpm run test -- --run       # 17 test files, 106 tests passed
pnpm --filter dsh-tauri-scheduler typecheck
pnpm --filter dsh-tauri-scheduler build
pnpm exec eslint packages/dsh-tauri-scheduler/src --fix
```

PR #412 的 Frontend、macOS、Ubuntu、Windows CI 均已通过。

## 内核侧交叉验证（0.1.5-rc.1）

内核自身消费方已经全部改用 setup 第二参数，可作为新 API 的权威样例：

- `@deepseek-ai/dsh-api-session-controller/lib/index.js:356-366`：
  `setup: async (agentCtx, agent) => { this.installSelection(agent); await presets.mount(agentCtx, resolvedId) }`。
- `@deepseek-ai/dsh-acp/lib/index.js:717`：`setup: async (agentCtx, agent) => { …agent.session.requestHeader()… }`。
- `@deepseek-ai/dsh-agent-loop/lib/index.js:1856`：`setup?.(prepared.agent.ctx, prepared.agent)`。

结论：`agentCtx` 只用于挂载预设/安装模型选择，Agent 一律走第二参数；`ctx.agent` 不再是可依赖入口。

## 后续同步流程

1. 获取参考仓库最新 tag 与提交：记录版本号和 commit SHA。
2. 对照参考项目的 `CHANGELOG.md`，按 P0 → P1 → P2/P3 分类新增能力。
3. 先更新本文件的“同步基线”和“待同步”项，再修改 host/client 实现。
4. 同步协议时同时检查：
   - `src/shared/constants.ts`
   - `src/host/types/index.ts`
   - `src/client/types/scheduler.ts`
   - `src/host/service/schedule.ts`
   - `src/host/service/executor.ts`
   - `src/client/components/task-create-dialog.tsx`
   - `src/client/locales/index.ts`
5. 完成后运行 lint、typecheck、test、build，并在本文件补充验证结果。
6. 将已完成项从“待同步”移动到“已同步”，保留未实施项及原因。

## v0.1.33–v0.1.42 评估与裁决（2026-09-16）

评估范围：`f1bc91a`（`v0.1.32`）..`e75499e`（`v0.1.42`），共 23 个提交；上游 `origin/main` 已停在 `e75499e`。

### 裁决结论

- **A 并发能力簇**（`1f38c56` / `207d2cc` / `3a4be24` / `88e20ed`）：**不采纳、不照搬**。保留本插件
  `SCHEDULER_MAX_CONCURRENT_RUNS = 4` 的全局上限，不引入上游的 `maxConcurrentRuns` 持久化字段与按任务并发。
  另立一条本地行为要求：**超出并发上限而未拉起的任务应显示「等待中」**（已同意，待实施）。
- **B 设置与模型菜单**（`5afa5a0`）：**不采纳**。本地保留模型选项描述行与现有信息密度。
- **C 插件自更新**（`81058eb` / `0c14fad`）：**不采纳**。桌面端已有分发/更新链路，不引入上游经
  `ctx.webServer` 暴露的自更新路由与 `pnpm` 拉起逻辑。

### 不采纳明细

| 提交 | 版本 | 结论 | 原因 |
| --- | --- | --- | --- |
| `1f38c56` | v0.1.39 | 不采纳 | 删除全局并发上限；本地保留 `SCHEDULER_MAX_CONCURRENT_RUNS = 4`。 |
| `207d2cc` | v0.1.40 | 不采纳 | 按任务并发 + 1 分钟间隔；不引入 `maxConcurrentRuns`。宿主 interval 下限本就是 1（`src/host/utils/schedule.ts:26`），UI `task-create-dialog.tsx:75` 的 `INTERVAL_OPTIONS` 保持从 5 起。 |
| `3a4be24` | v0.1.40 | 不采纳 | 工具 schema 去掉 `minimum`；本地 `src/host/tools/create-task.ts` 本就没有 `minimum`，无对应改动。 |
| `88e20ed` | v0.1.40 | 不采纳 | RPC 边界正整数校验；随并发特性一并放弃。 |
| `f4acaa4` | v0.1.41 | 不采纳 | 上游 sidebar 页签包裹方案；本地用 `src/client/register/panel.tsx` 的 `definePanel` 独立面板 + `src/client/register/session-icons.ts` DOM 注入，无 native-tabs 注册表。 |
| `c42700e` | v0.1.42 | 不采纳 | 同上；其「卸载时校验所有权再删」原则可在本地自检，但不构成必须改动。 |
| `0156a06` | v0.1.36 | 不采纳 | 会话枚举失败时保活；本地无会话枚举与会话关联清理逻辑（`sessionPersistence` / `knownSessionIds` 零引用）。 |
| `25e4e1b` | — | 部分已满足 | 会话枚举加固与 `cordis.patch.yml` 的 `connection` 补丁不适用本地（本地 patch 仅 `insert` 自身）；`trigger` 标签本地已是 `'schedule' \| 'manual'`（`src/host/types/index.ts:64`、`src/client/apis/index.type.ts:20`）。 |
| `f05c477` / `d60a711` | v0.1.37 / v0.1.38 | 不采纳 | 无 `src/` 改动，仅上游自身 peer/dev 依赖版本串与 `minimumReleaseAgeExclude` 登记；本地 `pnpm-workspace.yaml:46-70` 的 `dsh` catalog 已锁 `0.1.5-rc.2`。 |
| `5afa5a0` | v0.1.35 | 不采纳 | 纯视觉（模型描述行、菜单 hint、shell 尺寸）；本地保留现状。 |
| `81058eb` / `0c14fad` | v0.1.33 | 不采纳 | 插件自更新流程；桌面端已有分发/更新链路，避免双更新源与新增 loopback HTTP 写操作面。 |

归档（纯文档 / CI / release chore，无价值）：`e75499e`、`a8d87bf`、`d4b0109`、`a9f522c`、`ad0f77f`、`028f006`、`817dfd3`、`a1c6b9a`、`babc1c9`。

### 评估范围说明

上一轮（2026-09-13）直接从 `f1bc91a` 跳到 `c426c3d`，漏评 `f1bc91a..c426c3d` 之间触及 `src/` 的三个提交：
`81058eb`、`0c14fad`、`5afa5a0`。本轮已补评并给出裁决（均不采纳）。

### 本轮增量实施（2026-09-16）

- **并发上限提示**：调度器因 `SCHEDULER_MAX_CONCURRENT_RUNS = 4` 已满而未拉起任务时，任务卡片显示「等待中」。
  实现方式（裁决 A）：主机侧派生只读字段 `waiting`，不落盘。
  - 新增 `src/host/utils/waiting.ts`：`isTaskDue()` 与 `selectWaitingTaskIds()`，与 `tick()` 共用同一「到点且未在跑」判定；
    本次名额（`4 - running.size`）之内的任务不计入等待集，避免每个到点任务都闪一次「等待中」。
  - `src/host/service/scheduler.ts`：`tick()` 复用 `isTaskDue`；新增服务方法 `waitingIds()`。
  - `src/host/routes/tasks/get.ts`：任务列表按 `waitingIds()` 标注 `waiting: true`。
  - `src/host/types/index.ts`、`src/client/types/index.ts`、`src/client/apis/index.type.ts`：补 `waiting?: boolean`。
  - `src/client/components/task-card.tsx` + `task-card.cssr.ts`：卡片元信息行渲染「等待中」徽标。
  - `src/client/locales/index.ts`：新增 `waiting`（`等待中` / `Waiting`）。
  - 未采纳上游 `maxConcurrentRuns`（按任务并发）与「取消全局上限」，本地 `SCHEDULER_MAX_CONCURRENT_RUNS = 4` 保持不变。

## v0.1.43–v0.1.51 评估与裁决（2026-09-28）

评估范围：`e75499e`（`v0.1.42`）..`ecfe1e6`（`v0.1.51`），共 25 个提交。上游 `origin/main` 已推进到 `ecfe1e6`，
本轮同时推进子模块 gitlink 与工作区到该提交。

内核前提：本地 `pnpm-workspace.yaml` 的 `dsh` catalog 已锁 `0.1.7-rc.2`；上游 `v0.1.51` 的结论是
「rc.2 删除或改名的宿主导出与接口，本插件都没有使用」，故无兼容断点。

### 裁决结论

- **A 摘要订阅改走增量**（`116c953` + `a0c4cc6`）：**采纳**。内核 `0.1.7-rc.2` 把
  `snapshotEvents()` / `eventAt()` / `ownEvents()` 标为 `@deprecated`（`new calls are prohibited`），
  改为订阅 `session/event`，增量不可靠时回退快照。
- **B 插件卸载归为取消**（`0bde1a4`）：**采纳**（仅 `INACTIVE_EFFECT` 判定与增量事件裁剪；
  上游的 abort-signal 分支不适用，本地 `executor.run` 没有 signal 入参）。

### 不采纳明细

| 提交 | 版本 | 结论 | 原因 |
| --- | --- | --- | --- |
| `6fafbc7` | v0.1.43 | 不采纳 | 总览卡片打开 Codex UI 设置页；依赖宿主专属 `[data-dcu-settings-trigger]`，本地无对应设置页导航。 |
| `60b6f54` | v0.1.45 | 不采纳 | 自绘会话列表对齐官方工作区样式；本地侧栏只做图标 DOM 注入。 |
| `e8f14c0` | v0.1.45 | 不采纳 | 自绘列表转发宿主重命名/归档/删除；本地无自绘列表。 |
| `633b3d8` | v0.1.46 | 不采纳 | 设置页换 Ant Design；本地统一用 `dsh-tauri-ui`。 |
| `a20af37` | v0.1.46 | 不采纳 | 旧宿主会话菜单与自绘新建表单回归修复；本地无对应实现。 |
| `5e9634a` | v0.1.47 | 不采纳 | Cordis 工具链登记与死代码 UI 清理；本地依赖由 catalog 统一管理。 |
| `c6c7888` | v0.1.47 | 不采纳 | 图标与打包裁剪；本地构建产物结构不同。 |
| `3a4a153` | v0.1.48 | 不采纳 | 会话行样式对齐 0.1.7；纯视觉且对象不在本地。 |
| `6d6ca1b` | v0.1.49 | 不采纳 | 0.1.7 会话列表整段实现；本地无该列表。 |
| `334a860` | v0.1.49 | 不采纳 | 悬停卡片计时器；同属上游自绘列表。 |
| `2c01eea` | v0.1.49 | 不采纳 | 无行内操作插槽时页面不整页失败；本地面板不经该插槽。 |
| `95ff807` | v0.1.50 | 不采纳 | 宿主版本矩阵与 peer 收紧；本地 catalog 已锁 `0.1.7-rc.2`。 |
| `34cbc78` | v0.1.50 | 不采纳 | 同上的 peer/依赖串调整。 |
| `88d7cf7` | v0.1.51 | 不采纳 | CI 安装源与版本串；本地 CI 独立。 |

归档（纯文档 / release chore，无价值）：`ecfe1e6`、`e76e94e`、`57a4ac7`、`c3ba88d`、`fc8b100`、
`28c33f6`、`9dc137c`、`f871167`。

### 本轮实施

- `src/host/service/executor.utils.ts`
  - 新增 `watchSessionEvents(ctx, session, fromSeq)`：订阅 `session/event`，只收本会话、
    `seq >= fromSeq` 的 turn 边界事件（`turn/start` / `assistant/message` / `turn/end`），
    返回 `{ events, stop }`；宿主没有 `on` 时退化为空增量（走快照兜底）。
  - 新增 `summarizeCollectedRun(live, session, firstSeq)`；`summarizeRun` 改为薄封装
    `summarizeEvents(sessionEvents(session), firstSeq)`，`summarizeEvents` 允许事件缺少 `seq`。
  - 新增 `isPluginUnloadError(error)`：只认 `code === 'INACTIVE_EFFECT'`。
  - `sessionEvents()`（`snapshotEvents()` → `log` → `events`）保留为兜底，注释标注其为弃用面回退。
- `src/host/service/executor.ts`
  - `followup()` 之前挂上 watcher（`watched = watchSessionEvents(ctx, handle.agent.session, firstSeq)`），
    收尾改用 `summarizeCollectedRun`，外层 `finally` 里 `watched?.stop()` 解绑。
  - 外层 `catch` 区分插件卸载：`INACTIVE_EFFECT` 落 `cancelled` 与 `定时任务因插件卸载被取消。`，
    其余仍落 `failed`（`RunStatus` 本就含 `cancelled`，`src/host/types/index.ts:66`）。

### 与上游的有意差异（比上游更保守）

上游 `a0c4cc6` 在 `text !== '' || reason !== undefined` 时就信任增量。本地实测口径更严：
**只有拿到 `turn/end` 收尾原因才信任增量，否则一律回退快照**。原因是增量若丢掉了 `turn/end`
但正文仍在，按上游口径会把失败吞成成功，违反本地已有的「失败收尾不会被吞成成功」不变式
（`summarizeRun` 用例）。代价是异常收尾（核心不补写 `turn/end`）时多一次快照扫描。

另：上游 `116c953` 的 `deriveMessages` 会话归属判定（`ownsSession`）不在采纳范围——本地
source marker 是 `kind: 'scheduler'`，没有该逻辑。

### 验证记录（2026-09-28）

```text
pnpm --filter dsh-tauri-scheduler typecheck      # tsc 通过（0 error）
pnpm exec eslint <4 个改动文件>                    # 0 error / 0 warning
npx vitest run --project unit packages/dsh-tauri-scheduler
                                                 # 8 test files, 66 tests passed
git diff --check                                 # 无输出
```

未执行 `pnpm --filter dsh-tauri-scheduler build`：AGENTS.md「插件开发保护」明确禁止在插件包上执行构建
（用户可能处于 Dev 热重载），本轮以 typecheck + 单测覆盖；如需构建验证，请在非热重载时段单独执行。

新增单测：`watchSessionEvents`（3 例：只收本会话本轮的 turn 边界事件、无 `on` 时退化为空增量、`stop` 解绑）、
`summarizeCollectedRun`（2 例：增量带收尾原因时不再扫快照；增量缺收尾原因含「只剩正文」时回退快照且失败不被吞成成功）、
`isPluginUnloadError`（1 例）、`executor.run` 插件卸载记 `cancelled`（1 例）。

### 工具面精简（2026-09-29）

本地注入给 agent 的工具由 5 个收敛为 4 个，与官方 `@deepseek-ai/dsh-schedule` 的
`schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete` 一一对应（官方集合无 update 之外的差异项）。

- 新增 `src/host/tools/update-task.ts`（`scheduler_update`）：吸收原 `scheduler_toggle` 的启停语义
  （`enabled` 本就是 `TaskInput` 的普通字段，走 `task.update` 同一条路径），并补齐原本缺失的
  改名 / 改指令 / 改计划 / 改 workspace / permission / provider / model / reasoningEffort。
  显式传入的字段才并入 patch，缺省字段由 `defaults({}, patch, current)` 保持原值。
- `run_now` 开关保留原 `scheduler_run_now` 的立即运行能力；更新已落盘而运行失败时不回滚，
  如实返回 `更新已保存，但立即运行失败：<原因>`。
- 计划片段 schema 上移到 `src/host/utils/tool.ts` 的 `scheduleParameters`，create / update 共用。
- 删除 `src/host/tools/toggle-task.ts`、`src/host/tools/run-task.ts`。
- 宿主 HTTP 路由 `/tasks/toggle`、`/tasks/run` 与面板调用**有意保留**：本轮只收敛注入给 agent 的工具面。

验证记录（2026-09-29）：

```text
pnpm --filter dsh-tauri-scheduler typecheck                 # tsc 通过（0 error）
pnpm exec eslint src/host/apply.ts src/host/utils/tool.ts src/host/tools
                                                            # 0 error / 0 warning
npx vitest run --project unit packages/dsh-tauri-scheduler  # 9 test files, 74 tests passed
```

新增单测 `src/host/tools/update-task.test.ts`（8 例）：工具名、`task_id` 唯一必填与字段集、
只并入显式字段、`enabled` 启停语义、`run_now` 触发时机、更新失败不触发、更新成功后触发失败如实回报。

### 调度工具名称与子代理限制对齐（2026-10-11）

桌面公开工具名统一为 `schedule_create`、`schedule_list`、`schedule_update`、`schedule_delete`，不保留 `scheduler_*` 可调用别名。宿主注册、参数中的工具引用、客户端创建卡片匹配统一消费 `src/shared/constants.ts` 的 `SCHEDULE_TOOL_NAMES`；插件包名、HTTP 路径、存储键、错误码与 CSS 前缀不变。

根因取证：已安装的 `@deepseek-ai/dsh-web-app@0.2.1-alpha.2` 在 `presets/standard.patch.yml:93-115`、`presets/ptc.patch.yml:93-115`、`presets/cordis.patch.yml:92-114` 独立为 `tool-subagent` 与 `tool-subagent-fork` 配置 `toolFilter.deny`，其中四项均为 `schedule_*`。`@deepseek-ai/dsh-tool-subagent/lib/index.js:395-405` 从插件配置构造请求并透传该 filter（不是模型传参），随后 `@deepseek-ai/dsh-subagent/lib/types/manager.js:388` 将其放入 composition，`lib/types/child-agent.js:169-170` 调用 `childCtx.tools.restrict(composition.toolFilter)`。当桌面只注册 `scheduler_*` 时，严格校验报未知 `schedule_*`，在子作用域创建阶段失败；没有调度工具被调用。

`cordis.patch.yml` 对官方 `schedule`、`ui-schedule` 的永久禁用保持不变，它只禁用这些 loader 条目，不改写 Web 预设里其他条目的配置。此次使用同一公开工具名后，现有核心限制可以正确隐藏子代理的桌面调度工具，父作用域仍可调用；不删除 deny、不忽略未知项、不加壳层补丁。

回归检查先在旧注册名下实跑，复现精确的 `tools.restrict() names unknown global tools "schedule_create", "schedule_delete", "schedule_list", "schedule_update"`，再验证迁移后的真实 ToolRuntime 能建立限制作用域且保留父作用域工具。测试使用内存 Context，不读写真实用户目录；本地未执行 Build。

验证：源码 typecheck 与全仓 lint 通过；`vitest run --project unit --sequence.shuffle --sequence.seed=<1101..1105> packages/dsh-tauri-scheduler test/plugin-patch-targets.test.ts` 连续五次通过，每次 35 个文件 / 809 个用例。

## 待同步项

无。`f1bc91a..ecfe1e6` 的全部提交已评估并由用户逐条裁决（见上），本地行为要求「等待中」已实施。

