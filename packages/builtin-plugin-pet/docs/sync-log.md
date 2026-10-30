# dsh-tauri-pet 上游同步日志

> 用途：追踪 `source/dsh-pet` 与 `source/dsh-dafeiyu` 上游变更的采纳进度，
> 供后续轮次直接续接，避免重复调研。
>
> 约定：完成一次上游同步后，更新「同步记录」一节并刷新「同步基线」版本表；
> 未采纳的上游改动在「审查结论与未采纳项」记录原因，防止重复评估。

## 同步基线（固定版本）

| 上游仓库 | 已采纳基线 | 版本 | 用途 |
| --- | --- | --- | --- |
| `source/dsh-pet` | `631c531` | v0.2.12 | 预设资产与工作状态语义来源 |
| `source/dsh-dafeiyu` | `9c0588c` | v0.1.14 | 气泡文案/优先级逻辑参考（不下载资产） |

- **资产 ref 与代码基线解耦**：`src-tauri/resources/manifest.jsonc` 的 `pets.built-in` 素材地址内嵌 ref
  `e1ff8c1e4001878cbb80441262d530e16541f138`（须与 dsh-pet 的**已采纳资产基线**保持一致，
  新 WebM 资产在 `903dfde` 才入库，低于此的 ref 会取不到 6 个工作状态动画）；
  macOS 侧为 `dsh-pet-mov` 的 `be0f3bb494cb71a4c73f916c0b92d25a3ab4d002`。
  代码基线已推进到 `v0.2.12`，但**资产 ref 有意留在 `e1ff8c1`**：`e1ff8c1..v0.2.12` 期间
  `assets/webm`、`assets/mov` **零新增**，升级 ref 无动画收益，反而会让 `config` 指向含
  `whisperImageEnabled`/`chatImageEnabled`/`memes` 的新 `assets/config.jsonc`（本地渲染层不消费这些字段）。
- 子模块工作区 HEAD（与已采纳基线不必一致，仅作取证起点）：`source/dsh-pet` = `4c09729`（v0.2.10）、
  `source/dsh-dafeiyu` = `9c0588c`（v0.1.14）。
- 旧研究参考固定 `docs/plugins/expired/pet.todo.md:96` 指向 `899150e`，仅历史参考。

## 同步记录

### 2026 —— dsh-pet-component v0.2.4：仓库迁到 `dsh-tauri/`，单击语义改为「每次有效单击」

不是上游同步，而是渲染层依赖升级（`dsh-pet-component@^0.2.3` → `^0.2.4`），
记录在此以便核对单击语义与命令面。类型声明只增不改（`dist/index.d.mts` 净增 20 行），宿主侧无需改动。

- **仓库迁移**：0.2.4 的 `package.json` 把 `homepage`/`repository`/`bugs` 由 `hairyf/dsh-pet-component` 改为
  `dsh-tauri/dsh-pet-component`；`README.md`、`README.en.md`、`README.es.md` 的组件链接同步改名
  （本文档历史条目保留当时的旧名；`docs/specs/upstram.sync.md` 已固定禁止修改，其 §1.1 仍写作 `hairyf/`）。
- **单击语义**：原「双击（< `DOUBLE_CLICK_MS`）插播一次 waving、保留既有双击合约」改为**每次有效左键单击**
  都插播一次 waving（dsh 侧取动作池 `animations.clicks`，Codex 配置走 waving 行）。本仓 `src/pet/app.tsx`
  未使用单击/双击语义（`onHitboxPointerDown/Up` 交给 `useWindowDraggable`），观感变化仅是多一次动作插播。
- **新增对话输入（本仓未启用）**：`PetCommonProps` 新增 `dialogue?: boolean`、`onDialogue?: PetDialogueHandler`、
  `toastRef?: Ref<HTMLDivElement>`，`PetRef` 新增 `reply(text, options?)`，并导出 `PetReplyOptions`/`PetDialogueHandler`。
  启用 `dialogue` 后 500 ms 内的第二次有效单击打开输入 toast；本仓气泡仍走宿主 `pet.bubble`，故不启用。
- **供应链登记**：`minimumReleaseAgeExclude` 条目同步改为 `dsh-pet-component@0.2.4`（新版本未满最短发布时长）；
  **删除** `trustPolicyExclude: dsh-pet-component@0.2.3` —— 0.2.4 带 npm provenance 证明，不再被
  `trustPolicy: no-downgrade` 判为降级；删除后 `pnpm install --lockfile-only` 仍报
  `✓ Lockfile passes supply-chain policies (1171 entries)`。
- 校验：`pnpm typecheck`、`pnpm exec vitest run src/pet test/pet-asset-headers.test.ts`（97 passed）。

### 2026 —— 技能 `hatch-dsh-pet` 改述上游素材生成流程（上游 `README.md` @ `d73a2bb`，运行期基线不变）

用户指出原技能「不是对 dsh-pet 视频生成流程的描述」：它只讲本机 Codex 图集契约，第 2 步直说
「DSH 不自带图像生成工具」，把素材获取整个推给用户。现按上游 `PC2005-cloud/dsh-pet`
`README.md:430-528`「从零生成你自己的宠物（完整流程）」改写为 ① 提示词 → 源视频、
② 源视频 → 透明动画（`scripts/` 素材链，路线 A 自动抠像 / 路线 B PR 手工抠像）、
③ 动画 → 落点 三段；③ 的落点换成本机图集——上游是把 webm `cp` 进它自己的插件包
（`dsh-pet/assets/webm/`、`$DSH_HOME/dsh-pet/` pet pack），而本机只认
`<DSH_HOME>/pets/<petId>/` 的 8 列图集，视频宠物只能来自 `manifest.jsonc` 的远端 https 地址
（`src-tauri/src/bridge/preset_pet.rs` 的出厂校验强制）。

- 新增 `skills/hatch-dsh-pet/references/dsh-pet-video-flow.md`：上游流程逐条转述（提示词通用前缀与
  按秒分解、素材链命令与依赖 Python 3 + ffmpeg + numpy + scipy、②.5 macOS HEVC-alpha mov、
  ③ 发布/安装、方式四 pet pack、动作池名对照、项目结构、许可与非商用/署名条款），方便后续核对原文。
- 新增 `skills/hatch-dsh-pet/references/atlas-compose.md`：上游动作 → 本机 11 行的映射，
  以及 ffmpeg 等间隔取帧 / 全动作共用裁切框 / 缩放进 192×208 / 空格透明 / `tile=8x11` 拼图 /
  WebP 无损收缩的配方；帧数与 `atlas-layout.md` 的表严格对齐（逐帧时长写死在组件里）。
- `SKILL.md` 与 `references/atlas-layout.md` 相应改写：先分清「上游视频产线」与「本机图集落点」，
  再走 ①②③；`pet.json`、图集契约、失效表现、边界等本机契约事实逐条保留。
- **不涉及运行期**：代码基线仍为 `631c531`(v0.2.12)、资产 ref 仍为 `e1ff8c1`，
  未改任何 `src/**`、`src-tauri/**` 或 `manifest.jsonc`。
- `THIRD_PARTY_NOTICES.md` 补记上游素材条款（允许开源使用、**禁止商用**、二创须署名上游地址）。

### 2026 —— dsh-pet v0.2.7–v0.2.12 / dafeiyu v0.1.10–v0.1.14：采纳 2 项（goal 续跑轮判定、任务文案）

基线推进：dsh-pet `e1ff8c1`(v0.2.6) → `631c531`(v0.2.12)；dafeiyu `f4f4482`(v0.1.9) → `9c0588c`(v0.1.14)。
逐条评估后**只采纳 2 项**，其余全部不采纳（原因见「审查结论与未采纳项」）。**资产 ref 不动**，仍为 `e1ff8c1`。

- **goal 自动续跑轮的中间轮不再判成功**（上游 dsh-pet `db73c36`，v0.2.7 段）。
  本仓 `turn/end` 的 `reason.kind === 'completed'` 原先**无条件**写 `workStatus = 'success'`，
  于是多轮 goal 任务每收一轮尾都播雀跃庆祝，未完成的中间轮与真正完结无法区分。
  现按 goal 续跑轮判定：`user/message` 的 `source.kind === 'goal' && round > 0` 置 `goalRound`，
  `update_goal` 的 `action` 为 `complete`/`blocked` 时置 `goalClosing`；`turn/end(completed)` 改走
  `completedStatus()` —— 非 goal 轮 `success`，续跑轮未声明收尾只到 `result`，
  `complete`→`success`，`blocked`→`error`（阻塞不是崩溃，**不写** `lastAgentError`）。
  goal 标志在 `turn/end` 与 `settleIdle` 一并失效，避免漏发 `turn/end` 时泄漏到下一轮。
  - 判据取 `round > 0` 而非上游的 `kind === 'goal'`，与内核 `isGoalRound`
    （`source/deepseek-harness/packages/goal/goal-round-driver/src/index.ts:48`）一致：
    `round === 0` 是用户 `/goal` 触发的**激活轮**，终局语义按普通回合处理。
  - 上游同批的终态 TTL 60s 清理与展示优先级 `result:25 > success:20` 不需要：本仓 reducer 是
    纯函数、无定时器，档位优先级由渲染层 `dsh-pet-component` 持有（见「审查结论与未采纳项」）。
- **任务文案取最后一个 `in_progress` 并按码点截断**（上游 dsh-pet `bf7c4fb`，v0.2.12 段，issue #59）。
  上游该提交含四处修复，本地已具备其中三处（`task` 按会话存、`turn/start` 清 `task`、
  清单无 `in_progress`/`pending` 时清空并回落档位文案），故只移植本地确实缺失的两处：
  - `currentTaskFromTodo` 取**最后一个** `in_progress`：agent 常把新步骤标 `in_progress` 却忘标
    上一步 `completed`，取第一个会让文案永远停在最早那步；无进行中项时仍回落第一个 `pending`。
  - 文案按**码点**（`Array.from`）截断到 `PET_TASK_TEXT_MAX = 40` 并加省略号。气泡最大宽只有
    宠物宽的 0.5 倍，长 `todo` 原文会把气泡撑成多行；用码点而非 `slice` 避免劈开代理对或 emoji。
  - 不做上游的 `WorkStatusStore` 重构与类字段 `declare` 改写：本仓
    `states: Map<string, PetSessionState>` 已实现同等的会话隔离。
- 验证见文末「验证记录」。两处改动各带突变验证：把 `completedStatus` 换回常量 `success` 后
  7 例新增测试中 4 例变红；把 `findLast` 换回 `find` 后取值用例变红。

### 2026 —— dsh-pet-component v0.2.2：Codex 图集逐帧时长（idle 呼吸节奏对齐参考实现）

不是上游同步，而是渲染层依赖升级（`dsh-pet-component@^0.2.1` → `^0.2.2`），
记录在此以便核对帧节奏与命令面。类型声明只增不改（`dist/index.d.mts` 仅新增 6 行），宿主侧无需改动。

- **逐帧时长**：`CodexPetFrameSpec` 新增可选 `durations?: number[]`（第 N 项 = 第 N 帧的停留时长，
  缺项/非法项回落 `interval`）；`resolveCodexFrame` 把它并入解析结果，精灵图播放器取值优先级为
  `durations[index]` > `interval`，并把 `durations.join(',')` 纳入 effect 依赖。
- **idle 节奏**：内置 `CODEX_ACTIONS.idle` 由匀速 160 ms 改为 `[280, 110, 110, 140, 140, 320]`，
  对齐参考实现 `dsh-plugin-codex-pets` 的 `IDLE_DURATIONS`（首/末帧为长停留的「呼吸」帧）——
  此前匀速切帧看起来过快、从不停顿。宿主未自定义 idle 的 `interval`，直接受益。
- **一次性动作末帧**：提供 `durations` 时末帧时长本身即定格停留（对齐参考实现的 `lastDuration` 语义），
  不再于末帧后额外多停一个 `interval`；未提供 `durations` 的匀速动作行为不变。
- **宿主影响**：`<Pet>` props 与 `pet.bubble` 命令面均未变化，`src/pet` 与 `packages/dsh-tauri-pet` 无需改动；
  `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 登记同步改为 `dsh-pet-component@0.2.2`。
- 校验：`pnpm typecheck`、`pnpm exec vitest run src/pet test/pet-asset-headers.test.ts`。

### 2026 —— 修复「气泡一直停在兜底文案（正在分析）、思考与工具文案一闪而过」（核心 0.1.6 流式通道迁移）

不是上游同步，而是**核心事件通道变更**导致的回归，记录在此以免下次升级核心再踩。

- **现象**（用户反馈）：桌宠气泡长时间只显示静态兜底文案（会话 id 使 `seedNumber(id) % 3 === 0`
  时正好是「正在分析」），期间偶尔闪一下别的文案再切回去；真实会话里的思考文本与 Pwsh/工具
  调用始终看不到「思考 · …」「Pwsh · 命令」。
- **根因（有会话日志与 SSE 抓包证据）**：reducer 的活体文案只认 `session/event` 里的
  `assistant/chunk` 事件（`data.chunk.type === 'reasoning-delta'`）。核心 0.1.6-alpha.1 起
  逐 token 增量**不再是会话事件**：
  - 实测会话日志（`session.v3.jsonl.zstd`，343 帧解压后 2.2 MB）里 `assistant/chunk` = **0 条**，
    只有 76 条 `assistant/message` + 3 条 `assistant/attempt`（`data.stream` 是流结束后的紧凑记录）；
  - 22 秒 SSE 抓包（含 agent 持续推理）里 `liveActivity.kind` 只有 `tool`，`reasoning` = 0 条；
  - 活体增量改由 agent-scoped 通知 `agent/assistant-stream` 发布（载荷 `{ agent, frame }`，
    `frame.type === 'chunk'` 时 `frame.chunk` 就是模型原始 StreamChunk，与旧 `data.chunk` 同形）。
    核心自己的 `dsh-api-session-controller/lib/index.js` 就是靠 `ctx.on('agent/assistant-stream', …)`
    把前端 `assistant/live-chunk` 渲染出来的。
  - 于是思考阶段 `reasoningTail` 恒空 → `liveActivity` 缺失 → 气泡落到 `fallbackCopy`
    （`use-bubble-tracker.helpers.ts` 的候选顺序里 fallbackCopy 在 `session.message` 之前）。
- **修复**：
  - `src/host/service/session-stream.ts`：与会话总线同生命周期订阅 `agent/assistant-stream`
    （首个 SSE 消费者接入才挂、最后一个断开时一并注销），`frame.type === 'chunk'` 时按
    `agent.session` 解析 id/首次建档，再交给 reducer；已建档的热路径只传 id，逐 token 帧不走
    `peerOf`（投影标题解析）。
  - `src/host/service/session-stream.utils.ts`：`apply` 抽成闭包 `applyEvent`，新增 `chunk(peer, chunk)`
    折叠成一条合成 `assistant/chunk` 事件复用同一段增量语义（推理尾部窗口、500 ms 节流、去重只有一份），
    同时保留旧 `assistant/chunk` 事件分支以兼容 0.1.5 核心。
  - `src-tauri/src/bridge/pet.rs`：`consume_pet_session_stream` 的 reqwest 客户端加 `.no_proxy()`。
    实测桌面进程唯一长期保持的 TCP 连接是本机 HTTP 代理（mihomo `127.0.0.1:7890`），代理再连
    `127.0.0.1:3080` —— 本机 SSE 走了系统代理，日志里 `HTTP 502` / `HTTP 404` /
    `error decoding response body` 反复重连即由此而来；代理缓冲还会把逐条帧攒成一批，
    观感就是文案滞后抖动（与 `service/workflow/utils.rs` 的 `loopback_http_client` 同一理由）。
  - 测试：`session-stream.utils.test.ts` 新增 2 条（`chunk()` 与事件路径同语义 + 节流；
    text-delta/未知 chunk 不转发但进 `message`），`routes/index.test.ts` 新增 2 条
    （活体帧折叠成 `liveActivity.kind='reasoning'` 并下发；非流式增量不逐 token 转发），
    并把 `agent/assistant-stream` 的断开注销纳入既有生命周期用例。

### 2026 —— dsh-pet-component v0.2.1：气泡托管给组件（宿主只调 `pet.bubble`）

不是上游同步，而是渲染层依赖升级（`dsh-pet-component@^0.1.1` → `^0.2.1`），
记录在此以便核对气泡与动作的命令面。v0.2.1 只有两个修复（拖动接管时作废未播完的
一次性命令 `7c91d0d`、气泡度量下界抬到参考实现的固定值 `7ca0c3f`），
`dist/index.d.mts` 与 0.2.0 逐字节相同（sha256 `FFC04031…`），宿主侧无需改动。

- **气泡完全托管**：原三层拆分（`utils/bubble.ts` 文案 + `utils/bubble-tracker.ts` 603 行的
  「会话 → HeroUI toast 状态机」+ `hooks/use-bubble.ts` 订阅）收敛为
  `src/pet/hooks/use-bubble-tracker.ts`（React 壳）+ `.constants.ts`（文案库）+
  `.helpers.ts`（纯函数）。宿主只把会话快照收敛成动作档位与标题/正文/加载态，经
  `useControllablePet(petRef).bubble({ id, title, description, loading, motion })` 下发。
  叠加、原地更新、定时收起（终态 failed/error 4000、review 2500、success 3000 —— 与旧常量同值）、
  多会话动作优先级聚合（`BUBBLE_MOTION_PRIORITY`，与旧 `STATUS_PRIORITY` 同表）全在组件内。
  宿主的 `statusOf` / `STATUS_COALESCE_MS` 合并窗口 / `failedUntil` 终态脉冲 / `scheduleHide` /
  `dismissed` / 沉淀计时全部删除；桌宠窗口不再挂 `<ToastProvider custom>`。
- **动作随气泡走**：常驻气泡（`timeout: 0`）驱动声明式 `motion` prop；限时气泡（终态）由组件用
  命令面播一次，气泡收起不再掐断动画 —— 旧实现为绕开「成功动画被 3s 收起打断」而设的
  `TERMINAL_PULSE_TTL(10000)` 因此整体删除。`app.tsx` 的 `motion` prop 只剩拖动方向。
- **行为差异**：子代理会话此前「不弹 toast、但状态仍参与动作聚合」，v0.2.0 没有气泡就没有动作
  载体，故子代理现在既不弹气泡也不驱动动作（父会话在子代理运行期间本身有常驻气泡，观感不变）。
  另新增 `flush()`：`pet.bubble` 在 `<Pet>` 挂载前静默丢弃事件，宠物资源就绪后重放一次补齐。
- **碎碎念不接入**：不传 `onMuttering` 即完全无副作用（组件内 `onMuttering === undefined` 直接 return）。
- **唤醒锁入口随重构搬家**：桌宠窗口的 `useWakeLock()/useWatch/ release()` 抽成
  `src/pet/hooks/use-wakelock-release.ts`，`test/wake-lock.test.ts` 的 `WAKE_LOCK_ENTRIES`
  改指向该文件（issue #469 的不变量本身不变）。
- 校验：`pnpm exec vite build`（`pet.html` 入口 65 KB）、`pnpm exec vitest run`（53 files / 456 tests）、
  `pnpm exec eslint src/pet src/ui/pet test/wake-lock.test.ts vitest.config.ts --max-warnings=0`；
  `pnpm typecheck` 在 `src/` 无错（`packages/dsh-tauri-worktree` 的 `Cannot find module 'dsh-tauri'`
  一批是 worktree 未构建插件类型的既有问题，与本次改动无关）。
- **遗留（未在本次处理）**：`src/components/toast-provider.tsx` 的 `custom` 分支已无调用方，但删除它
  与「主窗口 toast 是否真的渲染」耦合 —— 该文件给主窗口传的是 `children = null`，而
  `@heroui/react` 的 `ToastProvider` 只在 `children === undefined` 时回落到
  `getDefaultChildren`（HeroUI `dist/components/toast/toast.js:398`），`null` 会原样渲染成空。
  即 `7171082c` 引入 `custom` 时可能顺带关掉了主窗口的 toast 内容，需独立核实后再一并清理。

### 2026 —— 预设宠物改为 dsh-pet-component 直连远端（移除下载/解压链路）

不是上游同步，而是渲染层换实现导致预设获取方式的整体变化，记录在此以便后续核对素材来源与命令面。

- **渲染层**：`src/pet` 整体换成 [`hairyf/dsh-pet-component`](https://github.com/hairyf/dsh-pet-component)
  的 `<Pet>`（npm `dsh-pet-component@^0.1.1`，内部用 `@reause/core`）；`src/pet/components/pet.tsx`
  （681 行）、`src/pet/config/index.ts`（294 行）、`hooks/use-pet.ts` 删除，动画池解析、
  双视频缓冲、雪碧图帧循环、IndexedDB 缓存、双击回应全部由组件接管。`src/pet` 只剩设置状态、
  会话气泡聚合、原生窗口拖拽（reause `useEventListener` + `useTimeoutFn`）与命中穿透。
- **预设不再下载/安装**：`src-tauri/resources/preset-pets.json` 改成组件 props 形状
  （`id` / `name` / `desc` / `image` / `kind` / `size` / `config` / `uri{default,mac}` /
  `ext{default,mac}`），Rust `bridge/preset_pet.rs` 从 2148 行缩到只剩读清单 + 校验；
  `download_preset_pet` / `update_preset_pet` / `get_preset_download_progress` /
  `get_preset_pet_config` / `get_preset_pet_assets` 与 `dsh-pet://` 自定义协议全部删除。
  `uri.mac` / `ext.mac` 继续指向 `dsh-tauri-desk/dsh-pet-mov` 的 HEVC-alpha `.mov`（issue #434 结论不变）。
- **CORS**：`src/pet/main.tsx` 把全局 `fetch` 换成 `@tauri-apps/plugin-http` 的实现
  （请求走 Rust），否则 `raw.githubusercontent.com` 不返回 `Access-Control-Allow-Origin`，
  组件拉配置与抓 blob 会整条失败；能力文件只放开 `https://*.githubusercontent.com/*` scope，
  媒体/图片的 CSP 增加 `blob:` 与 `https://*.githubusercontent.com`。
- **插件前端**：`utils/preset-card.ts`、`utils/availability.ts`（含各自测试）删除——
  预设恒可用、卡片只有「启用 / 已选」两态；store 去掉 `petsAvailable`，侧栏入口常驻。
- 校验：`pnpm typecheck`、`pnpm build`、`pnpm exec eslint src/pet packages/dsh-tauri-pet/src src/hooks/use-iframe-invoke.ts --max-warnings=0`、
  `pnpm exec vitest run`（295+）、`cargo test --lib`（530 passed）。

### 2026 —— 修复 macOS 预设宠物黑底（issue #434，分支 `fix/434-macos-hevc-alpha-mov-pet`）

不是上游同步，而是**素材编码格式**在 macOS 上不可用导致的黑底，记录在此以便后续核对素材来源。

- **现象**：macOS 启用预设桌宠后，宠物是一个黑色矩形（透明区域全黑），Windows/Chromium 正常，且无任何 error 事件。
- **根因**：预设宠物走 `<video>` 播放 VP9-alpha WebM，而 WKWebView（WebKit）解码时**直接丢弃 alpha 平面**
  并按不透明渲染（[WebKit #64837](https://github.com/WebKit/WebKit/pull/64837) 2026 才合入）。窗口/WebView/CSS
  透明链路与 Tauri 均无问题，黑底是视频像素层。Safari 原生支持的透明视频是 **HEVC-with-Alpha**
  （`AVVideoCodecType.hevcWithAlpha`，`hvc1`），而该编码器只有 macOS 有。
- **素材侧**：新建 [`dsh-tauri-desk/dsh-pet-mov`](https://github.com/dsh-tauri-desk/dsh-pet-mov)，
  用 GitHub Actions 的 macOS runner 把上游 `dsh-pet/assets/webm` 批量转码为 `mov/*.mov`
  （`ffmpeg -pix_fmt bgra` 解码 → `swift hevc_alpha_encoder.swift` 编码），
  仓库**只保留 `config.jsonc` 与 `mov/`**（113 个 mov，约 79 MiB）。流水线按周跟随上游 `main` 重编，
  产物由机器人提交回该仓库；桌面端以 codeload tarball 下载，不需要 Release。
- **桌面侧**：
  - `preset-pets.json` 新增 `platforms` 覆盖块：`macos` 换 `repo` = `dsh-tauri-desk/dsh-pet-mov`、
    `ref` = 该仓库已生成的提交、`assets` = `""`（仓库根即素材）、`sizeMb` = 79；其余平台不变。
  - `preset_pet.rs`：`read_platform_catalog` 按 `std::env::consts::OS` 并回覆盖块；
    解压层支持**空前缀**（整个仓库即素材，仍需剥掉 `<repo>-<ref>/` 与安全校验）；
    协议层放开 `mov/` 子目录与 `.mov` 扩展名，MIME 为 `video/quicktime`（WKWebView 才交给 AVFoundation）；
    `get_preset_pet_assets` 改为按 `mov/` → `webm/` 的优先级选源（文件名主名与 `config.jsonc`
    池条目一致，前端无需感知格式）。macOS 用户升级后清单 `ref` 变化会触发设置页的「更新」入口，
    更新即从 webm 安装切到 mov 安装。

### 2026 —— 修复「会话被用户中止后 toast 与动画一直持续」（分支 `fix/pet-abort-hang`）

不是上游同步，而是宿主收尾信号缺失导致的桌宠挂死，记录在此以便后续核对收尾语义。

- **现象**：用户中止一个刚起流的会话后，桌宠气泡（标题 + 档位文案）与循环工作动画
  （thinking/working 档）一直持续，直到会话被销毁或重开桌宠。
- **根因（有抓包与日志证据）**：桌宠展示态只认 `turn/end`，但核心 0.1.5-rc.1 在异常收尾时
  可能**永远不追加** `turn/end`。真实现场 `session-2a2abd15`（用户中止，等待 5 秒的会话）：
  - 宿主 `session/event` 只到 `assistant/attempt{stream:[]}` + `step/end`；SSE 抓包（订阅
    `/api/dsh-pet/session-stream`）在最后一条 `workStatus=thinking` 之后**再无该会话的任何帧**；
  - 会话日志里 `turn/end` 直到 2.5 分钟后该会话被重新加载时才出现，且是崩溃修复补写的
    `{kind:'interrupted'}`；崩溃修复属于构造 seed，**不会再发 `session/event`**，桌宠永远等不到。
  - 结论：`turn/end` 不能作为「回合收尾」的唯一信号，与 running-changes 宿主侧早就存在的
    `agent/status → idle` 兜底（`packages/dsh-tauri-experimental/src/host/apply.ts`）同源。
- **修复**：
  - `src/host/reducer.ts`：抽出 `settleIdle(state)`（turn/end 中断分支与 idle 兜底共用同一份
    收尾语义），新增 `idle(id)` —— 只在会话仍处于「回合内」（`running || turnActive || stepActive`）
    时才落定回空闲并去重转发；`turn/end` 已写好的终态档（success/error）与 blocked 等待态
    必须保留，否则刚弹出的失败/完成气泡与一次性动画会被立刻掐断。
  - `src/index.ts`：`attachSessionEvents` 增加 `ctx.on('agent/status', ...)`，`status==='idle'`
    时用 `agent.session.id` 调 `reducer.idle`；与 `session/event` / `session/disposed` 同生命周期
    （无消费者不订阅）。载荷形状 `{status, agent}` 来自核心 `agentEvents` 的 fused payload，
    0.1.2-rc.1 与 0.1.5-rc.1 一致（旧核心同样是 `dispatch.emit("agent/status", { status })`）。
  - `src/pet/hooks/bubble-copy.ts`：`sessionTitle()` 从 `use-bubble.ts` 迁入（纯函数可单测），
    标题缺失时回落 `UNTITLED_SESSION_TITLE`（「新会话」/「New session」），**不再回落
    `session.id`**（此前把 `session-xxxx-xxxx…` 漏成气泡标题）；`taskCopy()` 按用户反馈去掉
    dsh-dafeiyu 的句末语气词「呢」（`正在处理「…」` 不再以「呢」收尾，三个分支统一）。
  - 测试：reducer.test.ts 新增 4 条（漏发 turn/end 时清空并转发、终态/等待态不被改写、
    未知会话与重复通知不转发、create 仅凭 summary `running=true` 也能回落）；
    bubble-copy.test.ts 新增 3 条（标题优先级、缺失标题回落且不含 `session-`、前缀保留）。

### 2025 —— PR #414（已合并 main，分支 `dsh/pet-work-status`）

预设 ref 升级 + 工作状态 6 档 + 动画/气泡接线：

- `preset-pets.json`：ref 与 image URL 同步升级 `f0f772e` → `e1ff8c1`。
- host reducer（`packages/dsh-tauri-pet/src/host/reducer.ts`）：
  - 新增 `PetWorkStatus='thinking'|'working'|'result'|'waiting'|'success'|'error'`、
    `PET_WORK_STATUS_INDEX`、`PetToolActivity`、`toolActivityOf(name)`、
    `currentTaskFromTodo(data)`。
  - `reduceSessionEvent` 映射：turn/start→thinking（并清 task 与 lastAgentError）；
    step/start、assistant/chunk(reasoning-delta)、assistant/message→thinking；
    tool/call→working（`ask_user_question` 例外→waiting）；tool/result→
    **不写 lastAgentError**（工具级错误不污染回合级终态），openTools 剩→working、
    无→(waitingKind?waiting:result)；approval/asked→waiting、decided→
    (openTools 剩?working:thinking)；todo/write→task 变化即转发；turn/end：
    blocked→waiting、completed→success、error/max-tokens/timeout→error、
    其余(aborted)→undefined 清回空闲。
- 动画/气泡接线：`src/pet/pet-config.ts` `PRESET_SESSION_ANIMATIONS` 指向 6 个新
  webm 名；新增 `isLoopingAnimation` / `spriteStatusFallback`；
  `src/pet/hooks/bubble-copy.ts` 新增（对齐 dsh-dafeiyu 的 `seedNumber` /
  `statusCopy` / `activityCopy` / `taskCopy` / `toolActivityGroup`，
  `taskCopy` 句式：`正在${value}呢`）；`use-bubble.ts` `STATUS_PRIORITY` 对齐
  dsh-dafeiyu 档位（waiting=60>error=50>failed=45>review=40>working=30>result=25>
  thinking=20>running=12>success=10>idle 族=0），`sessionStatus` 优先 `workStatus`，
  并修复用户 bug：`session.running===true` 时 lastAgentError/粗 error 不判 failed
  （会话还在跑 toast 不能消失）；`app.tsx` loop 判定改 `isLoopingAnimation`。
- 测试：reducer.test.ts 19 条、pet-config.test.ts、bubble-copy.test.ts 新增。

### 2025 —— PR #415（未合并，分支 `dsh/pet-update`，12 files +408/-31）

宠物更新功能（检测到 dsh-pet hash 有更新时，已下载用户在「已选」按钮左侧点
「更新」，走同一下载/解压进度条；点击更新时若宠物正在使用则强制停用，
完成后重新启用）：

- Rust `src-tauri/src/bridge/preset_pet.rs`：
  - 新常量 `PRESET_REF_FILE='.preset-ref'`（安装目录根隐藏文件记录已安装版本）；
    `PresetPetListItem` 增 `update_available: bool`。
  - 新函数 `preset_reference(spec)`（ref 过滤空后 unwrap_or "main"）、
    `read_installed_ref(dir)`（空/空白→None）、`write_installed_ref(dir, reference)`、
    `preset_update_available(installed, catalog_ref, installed_ref)`（未安装→false；
    catalog ref 空→false；installed_ref≠catalog ref→true；老安装无记录→true）。
  - `install_staging(root,id,nonce,staging,target,replace)`：target 不存在→rename；
    存在且 !replace→`PET_PRESET_ALREADY_INSTALLED`；replace→两步 rename
    （target→`root/.preset-backup-{id}-{nonce}`，staging→target），失败回滚。
  - 新 `#[tauri::command] update_preset_pet(app, id)`：校验在 catalog+已安装+非 busy；
    快照 `get_pet_status` 得 `was_enabled`；若在用先 `set_pet_enabled(false)` 强制停用；
    `run_preset_download(replace=true)`；done 后 `reload_pet_window(app)`；
    `was_enabled` 时 `set_pet_enabled(true)` 重新启用。
  - `run_preset_download` 增 `replace: bool`；成功路径写 `.preset-ref`；
    `list_preset_pets` 计算 `update_available`；`download_preset_pet` 传 replace=false。
- Rust 其他：`src-tauri/src/desktop/pet.rs` 新增 `reload_pet_window(app)`
  （窗口存在时 `eval("location.reload()")` 刷新 WebView webm 缓存）；
  `desktop/builder.rs` 注册 `update_preset_pet`。
- 插件前端：`constants/index.ts` 增 `CMD_UPDATE_PRESET_PET='update_preset_pet'`；
  `types/index.ts` `PresetPetItem.update_available?`、`LocaleKey 'update'|'updateFailed'`；
  `service/pet.ts` 增 `updatePresetPet(id)`；`utils/preset-card.ts` 新增
  `resolvePresetCardUpdate(item, progress)`（installed && update_available && 非
  downloading/extracting）；`components/pet-settings.tsx`：`PetCard` 增
  `updateDisabled/updateLabel/onUpdate`，动作区包 `<span class="dshp-pet__card-actions">`
  （更新按钮在主动作左侧 `dshp-pet__card-actionUpdate`），`startUpdate(id)` 走
  `updatePresetPet`→`pollPresetDownload` 同一进度轮询，busy 恢复轮询；
  cssr 增 actions（flex gap 6px）与 actionUpdate（次级色）；locales 增
  `update:'更新'/'Update'`、`updateFailed:'更新预设宠物失败'/'Failed to update preset pet'`。
- 宿主壳：`src/hooks/use-iframe-invoke.ts` `ALLOWED_INVOKE_CMDS` 增
  `'update_preset_pet'`，与 service/pet.ts 一一对应注释仍成立。
- 测试：Rust 4 条（`installed_ref_round_trips_and_handles_missing`、
  `update_available_requires_installed_and_differs_from_catalog_ref`、
  `install_staging_replaces_existing_with_backup_and_rolls_back_on_failure`、
  `install_staging_first_install_and_non_replace_reject`）；`preset-card.test.ts`
  新增 `resolvePresetCardUpdate` 5 用例。
- 验证：cargo check --lib / cargo test --lib 493 passed / pnpm typecheck（含 filter）/
  eslint 零警告 / pnpm test 109 passed / pnpm --filter dsh-tauri-pet build 全过。

## 审查结论与未采纳项（防重复评估）

### 本轮新增（dsh-pet `e1ff8c1..631c531` / dafeiyu `f4f4482..9c0588c`，已逐条评估）

- **dsh-pet 渲染层全部不适用**：`867cfab`/`20d154d`/`9896027`/`1ec7d42`/`53886bd`/`01e4b1b`
  （档位候选数组/轮换/事件后恢复循环/终态气泡粘性/拖拽恢复）、`f6e0fce`/`22d664f`
  （`ANIMATION_EXT` 集中开关 + macOS mov 改由 dsh-pet 自身固定 tag Release 发布）、
  `70170a3`/`6dcf087`/`b3eb1c0`/`27011f0`/`e67cd5f`（memes 表情包配图）——
  本仓渲染/播放/气泡/档位选择**不在 `packages/dsh-tauri-pet`**，而是整包托管给 npm `dsh-pet-component`
  的 `<Pet>`（接线在 `src/pet/**`）。要跟进须升级该依赖，不是本包移植；终态气泡粘性
  （`1ec7d42`）在 `src/pet/hooks/use-bubble-tracker.ts` 的 `terminalShown` 已等价实现。
  macOS mov 的架构选择也不同：本仓用独立仓库 `dsh-tauri-desk/dsh-pet-mov` + 周更 Action，
  不采用上游的「同仓库固定 tag Release」。
- **dsh-pet Electron helper / 非本仓模块**：多显示器窗口逻辑（`cdf57a1`/`0038345`/`aac3a81`/
  `a11ece0`/`ac8b8fe`）、notify 走 host 转发（`6180c8a`）、helper 生命周期/穿透/熔断
  （`74bfc59`/`9a6902a`/`d3988fa`/`1670d2f`/`728dfcd`/`651a730`）、prepack 闸门（`a299370`）、
  GIF 脚本（`2c327dc`）、whisper/balance（`6199d9d`）、设置页与存储说明（`b8cb017`/`22db345`/`b715fa3`）。
- **dsh-pet 路由能力本包不存在**：本包只有**一条**路由（`session-stream`），没有 thumb 路由、
  素材/asset 路由、notify 路由，也没有 `/pet` 命令注册与本地预设下载链路，因此
  thumb `petId` 防穿越（`6f96508`/`f49f14a`）、素材 fetch+blob 与响应长度/缓存
  （`0073ad7`/`08fcff5`/`a3cd0de`）、`/pet` 依赖 `commandUi` 就绪（`b5417a1`）全部不适用。
- **资产 ref 升级无收益（保留 `e1ff8c1`）**：`e1ff8c1..v0.2.12` 期间 `assets/webm`、`assets/mov`
  **零新增**，`assets` 下唯一被改的既有文件是 `assets/config.jsonc`（新增
  `whisperImageEnabled`/`chatImageEnabled`/`memes` 映射），新增素材只有 `assets/memes/*.png`。
  升 ref 若不实现 memes 功能，拿不到任何新动画，只会引入本地不消费的配置字段。
- **dafeiyu `f4f4482..9c0588c` 零可移植文案**：新增代码集中在 `src/plugin.js`(+809)、
  `src/index.js`、`src/helper-process.js`、`lib/client.js`、`native/macos/Sources/PetController.swift`、
  `runtime/{asset_paths.py,helper.py}`、`scripts/import_dshpet_webm.py`、`assets/pet-manifest.json`(+2731)。
  其 `plugin.js` 新增中文只有 Schema 描述与 `bubbleMode`(always/hidden/custom)、`bubbleStates`、
  `includeSubagents`、`reducedMotion`、`soundEnabled`、`webOverlay` 等配置项，加一条占位文案
  （`stage:'等待任务'` / `message:'我在这儿等新任务哦'`），**文案表几无变化**。
  其中 `includeSubagents` opt-in 与本仓**相反**——本仓 `use-bubble-tracker.ts` 的 `apply()` 对
  `session.origin === 'subagent'` 直接 forget+close，属有意差异，勿跟改。
- **`source/dsh-plugin-codex-pets`**：`22e93f4..origin/main` 为空，无待评估项。
- **`source/BongoCat`**：上游已用 Rust + gpui 整体重写（`1c570a0f`，2.0.0），技术栈与本仓 Tauri
  完全不同；本仓只参考其「原生拖动 / DPI / 穿透」，期间数百条提交几乎全是 gpui/设置窗/CI/docs。

### 历史结论

- dsh-pet 的 `workStatusTick` 1s 轮询 `/dsh-pet-7340/work-status`（`ea0ca7e`）：
  **不需要**——本仓库已有事件驱动 host reducer，避免额外轮询。
- dsh-pet 其余提交（`33ca8f2` renderer 拆分、`12d9f44` 气泡样式、`26d8017` 透明窗黑框、
  `e1ff8c1` maxTokens、`a8c2cd0` reasoning-off）属其 Electron helper 或 host LLM 侧，
  与本仓库无关。
- dsh-dafeiyu：气泡文案/优先级逻辑已采纳（见 PR #414）；其 TASK 消息（todo/write →
  `taskCopy(task)` + 已完成 a/b 步）与 multi-session `#select()` 为多会话渲染方案，
  本仓库会话 Toast 一对一定位，未采纳。
- dsh-dafeiyu `taskCopy` 的句末语气词「呢」：**有意去掉**（用户反馈「正在处理 […] 后面的
  『呢』要去掉」）。句式结构（正在+原文 / 正在处理「原文」）仍与上游一致，只是不再带语气词；
  若后续再次同步上游文案，勿把「呢」带回来。

## 后续同步流程

1. 检查上游新提交：
   `git -C source/dsh-pet fetch origin && git -C source/dsh-pet log --oneline 631c531..origin/main`
   （dsh-dafeiyu 同理，起点 `9c0588c`）。
2. 若 dsh-pet 有新版本：评估影响面（`src/host/service/session-stream.utils.ts` 的事件映射、
   `src/pet/**` 与 `dsh-pet-component` 的渲染职责划分、资产入库 commit），
   确认新 WebM/config 字段后再决定是否升 `src-tauri/resources/manifest.jsonc` 的资产 ref。
   **资产 ref 与代码基线解耦**：只有出现新 WebM/mov 时才升 ref（见文首「同步基线」）。
3. 渲染/播放/气泡/档位选择改动**不在本包**：先看 `dsh-pet-component` 是否已具备，具备则升依赖，
   不具备再考虑搬进 `src/pet/**`。本包只负责 host 侧「会话增量 → 展示态」与 Tauri 窗口/资产命令。
4. 若资产 ref 升级：Rust `validate_preset_pet_config` 对未知字段自动放行，一般无需改
   Rust；按需补动画/气泡映射与测试。
   - 同时确认 macOS 侧 `manifest.jsonc` 的 `uri.mac` 是否要跟到 `dsh-pet-mov` 的新产物 commit
     （该仓库按周跟随上游 `main` 重编并把 mov 提交回自己的 `main`；两边 ref 都要升，
     否则 macOS 会停在旧动画集；该仓库无需 Release，桌面端直接下 codeload tarball）。
5. 验证四件套：
   `pnpm --filter dsh-tauri-pet typecheck`、`pnpm typecheck`、
   `pnpm exec eslint src/pet packages/dsh-tauri-pet/src/client packages/dsh-tauri-pet/src/host --max-warnings=0`、
   `pnpm test -- --run`、`pnpm --filter dsh-tauri-pet build`、
   `cargo check --manifest-path src-tauri/Cargo.toml --lib`、
   `cargo test --manifest-path src-tauri/Cargo.toml --lib`、`git diff --check`。
   注意：插件处于 dev 热重载时**禁止执行 build**（AGENTS.md 最高优先级）。
6. 完成后续回填本日志「同步记录」，并刷新「同步基线」与 `docs/specs/upstram.sync.md` §5 登记表。

## dsh-tauri-pet 同步日志（历史记录）

用于记录 `source/dsh-pet`、`source/dsh-dafeiyu` 能力同步到 `packages/dsh-tauri-pet` 的进度，避免后续重复对比或遗漏实现。

### 同步基线

- 参考项目：[`PC2005-cloud/dsh-pet`](https://github.com/PC2005-cloud/dsh-pet)（工作状态 6 档 + 预设资产）
- 本次对比版本：`v0.2.6`
- 本次对比提交：`e1ff8c1`
- 气泡文案参考：[`dsh-dafeiyu`](https://github.com/dsh-tauri-desk/dsh-dafeiyu) `v0.1.9`（`f4f4482`，仅参考不下载资产）
- 预设清单 ref：`src-tauri/resources/preset-pets.json` 的 `ref` = `e1ff8c1e4001878cbb80441262d530e16541f138`
  （新工作状态 WebM 在 dsh-pet `903dfde` 才入库，ref 必须 ≥ 该提交）
- 记录更新时间：2026-09-07

### 已同步

#### P0（预设资产与工作状态 6 档）

- [x] 预设 ref 升级 `f0f772e` → `e1ff8c1`，下载到 6 个新工作状态 WebM（思考冒泡/忙碌点按/清点归档/原地踱步张望/雀跃庆祝/垂头叹气冒汗）。
- [x] host reducer 细分档位：`PetWorkStatus = thinking | working | result | waiting | success | error`，事件映射
  （turn/start→thinking；tool/call→working（`ask_user_question` 例外→waiting）；tool/result→result/working；
  approval→waiting；turn/end：completed→success、error/max-tokens/timeout→error、blocked→waiting、其余→清回空闲）。
- [x] 工具级错误不再写 `lastAgentError`，不污染回合级终态；`turn/start` 清上一回合 `lastAgentError`。
- [x] 动画档位接线：`PRESET_SESSION_ANIMATIONS` 指向 6 个新动画名，`isLoopingAnimation` /
  `spriteStatusFallback`（thinking→waiting、working→running、result→review、success→waving、error→failed）。

#### P1（气泡对齐 dsh-dafeiyu）

- [x] 新增 `src/pet/hooks/bubble-copy.ts`：`seedNumber` / `statusCopy` / `activityCopy` / `taskCopy` /
  `toolActivityGroup`，**句式精确对齐 dsh-dafeiyu**（`正在${value}呢`，无空格）。
- [x] `use-bubble.ts` `STATUS_PRIORITY` 对齐 dsh-dafeiyu 档位：
  waiting=60 > error=50 > failed=45 > review=40 > working=30 > result=25 > thinking=20 > running=12 > success=10 > idle 族=0。
- [x] `sessionStatus` 优先 `workStatus`；修复 bug：`session.running === true` 时 lastAgentError/粗 error 不判 failed
  （会话还在跑时 toast 不消失）。
- [x] `app.tsx` loop 判定改 `isLoopingAnimation`；成功/失败终态动画播一次后回收。

#### P2（宠物更新）

- [x] Rust：`.preset-ref` 记录已安装版本；`preset_update_available` 判定更新可用；`install_staging(replace)` 两步
  rename + 备份回滚；`update_preset_pet` 命令：快照 `get_pet_status` → 在用则 `set_pet_enabled(false)` 强制停用 →
  `run_preset_download(replace=true)` → 成功 `reload_pet_window` → `was_enabled` 时 `set_pet_enabled(true)` 重新启用。
- [x] 前端：设置页「已选」按钮左侧「更新」按钮（`dshp-pet__card-actionUpdate`），复用 `pollPresetDownload`
  下载/解压进度条；`resolvePresetCardUpdate` 控制显隐；i18n `update` / `updateFailed`。
- [x] 宿主壳 `use-iframe-invoke.ts` `ALLOWED_INVOKE_CMDS` 增 `update_preset_pet`。
- [x] Rust `validate_preset_pet_config` 对未知字段自动放行，无需改动。

### 明确未同步（含原因）

- dsh-pet `workStatusTick` 1s 轮询 `/dsh-pet-7340/work-status`（`ea0ca7e`）：不需要——本仓库已有事件驱动 host reducer。
- dsh-pet 其余提交（`33ca8f2` renderer 拆分、`12d9f44` 气泡样式、`26d8017` 透明窗黑框、`e1ff8c1` maxTokens、
  `a8c2cd0` reasoning-off）：属其 Electron helper 或 host LLM 侧，与本仓库无关。
- dsh-dafeiyu TASK 消息（todo/write → `taskCopy(task)` + 已完成 a/b 步）与 multi-session `#select()`：本仓库会话
  气泡是一对一定位（各自 toast），未采纳其多会话顶选渲染方案；`taskCopy` 句式已吸收。
- 预设下载/更新安装目录内的其他备份清理：`update_preset_pet` 成功路径已清理备份，失败路径保留备份以便回滚判断。

### 验证记录

最近一次本地验证（本轮 dsh-pet v0.2.12 / dafeiyu v0.1.14 同步，提交 `677f66e8` + `7e7e3702`）：

```text
npx vitest run packages/dsh-tauri-pet/src/host/service/session-stream.utils.test.ts   # 41 passed
pnpm --filter dsh-tauri-pet typecheck                    # tsc 无输出
pnpm typecheck                                           # tsc --noEmit 无输出
pnpm exec eslint src/pet packages/dsh-tauri-pet/src/client packages/dsh-tauri-pet/src/host --max-warnings=0
pnpm test:unit -- --run                                  # 1742 passed | 16 failed | 4 skipped (165 files)
git diff --check
```

- `pnpm test:unit` 的 16 个失败**全部**落在 `packages/dsh-tauri-ssh`（`bootstrap.test.ts` / `ssh-config.test.ts` /
  `plugins-sync.test.ts`），属既有 Windows 环境失败（POSIX sh 执行、`~` 展开、部署树布局）；该包最后一次改动
  是 `ec23df70`，与本轮路径完全不相交（本轮只改 `packages/dsh-tauri-pet/src/host/service/session-stream.*`）。
  `packages/dsh-tauri-pet` 相关用例零失败。
- 未跑全量 `pnpm test -- --run`：`desktop` 项目的前置校验拒绝运行
  （`端口 3081 已被监听（debug 固定端口）`，即当前 dev/debug 实例在跑），本校验不自动杀进程。
- 未跑 `pnpm --filter dsh-tauri-pet build`：插件处于 dev 热重载，AGENTS.md 最高优先级规则禁止。
- 未跑 `cargo check/test`：本轮未改动 `src-tauri/**`（Rust 面与本轮两项修复无关）。
- 突变验证：`completedStatus` 换回常量 `success` → 7 例新增 goal 测试中 4 例变红；
  `findLast` 换回 `find` → 任务文案取值用例变红。

上一轮本地验证（PR #414 + #415 合并后全量）：

```text
cargo test --lib                        # 493 passed
pnpm test -- --run                      # 109 passed (17 files)
pnpm --filter dsh-tauri-pet typecheck
pnpm typecheck
pnpm --filter dsh-tauri-pet build
pnpm exec eslint src/pet packages/dsh-tauri-pet/src/client packages/dsh-tauri-pet/src/host --max-warnings=0
git diff --check
```

PR #414、#415 的 GitHub CI 均已通过。

### 后续同步流程

见本文档开头的「后续同步流程」（同一份流程只保留一处，避免两边路径漂移后各说各话）。

### 待同步项

当前没有已确认、且适用于桌面端的需求在案。下一次参考仓库更新时，从新的 changelog 重新评估；用户如提出新的宠物交互需求，先在此登记再实施。
