# 远端核心统一管理计划

桌面壳以同一套原语管理本机 / 远端 dsh 核心。

- 涉及仓库：`deepseek-harness-desktop`（本文件所在仓库）
- 关键组件：`apps/desktop/src-tauri`（桌面壳 Rust）、`apps/desktop/src`（壳 UI）、
  `packages/builtin-plugin-remote`（`dsh-tauri-remote` 插件，SSH 侧实现）
- 状态：**P0（#1555、#1557）、P1（#1563、#1564）、P2-1（#1565）已合入；P2-2 远端核心切换 #1568 为草稿、人工评审未开始；P3-0 实例档案管理（issue #1600）本分支已实现、待提 PR；档案与核心管理的分工见第 4.8 节，实例档案管理见第 4.7 节**
- 阶段划分见第 6 节；每个阶段单独成 PR，后一阶段以前一阶段的设计或实现为 base

## 0. PR 拆分与依赖

本方案不从零堆一个大 PR，而是按可独立验收的边界推进：

| PR | 范围 | 前置 | 状态 |
| --- | --- | --- | --- |
| #1551 | 本设计、身份与状态语义 | 无 | MERGED |
| #1557 | 生成链、生成产物与仓库级类型检查 | 无领域依赖 | MERGED |
| #1555 | P0 只读契约、路由、生成客户端与 Rust 白名单 | #1557 | MERGED |
| #1561 | P1 远端 Core 与远端 Profile 只读查看 | #1555、#1557 | CLOSED（拆分为 #1563 / #1564） |
| #1563 | P1 远端 Core 只读查看 | #1555、#1557 | MERGED |
| #1564 | P1 远端 Profile 只读查看 | #1563 | OPEN |
| #1565 | P2-1 远端核心清单与按版本下载 | #1563 | MERGED |
| P2-2 | 远端核心切换与回滚 | P2-1 | NOT STARTED |
| P2-3 | 远端核心卸载 | P2-2 | NOT STARTED |
| #1578 | 远端实例身份（启动令牌、实例日志、pidfile、档案核对）与捆绑插件同步的占用约束 | 无 | MERGED（#1572、#1573、#1574） |
| #1581 | #1578 的遗留：捆绑插件的接线按档案单独记 | #1578 | MERGED |
| P3-0 | 实例档案管理：只读发现实例真实档案、已有实例按实展示且忽略默认档案、自拉实例设定档案 | #1578（实现不依赖 P2-2，可独立合入） | 本分支已实现，待提 PR（见第 4.7 节） |
| P3 | 远端插件与档案反向管理 | P3-0 | NOT STARTED |

这些 PR 都从 fork 分支向上游 `main` 提交；GitHub 不支持把上游 PR 的 base 指向 fork 分支。因此依赖关系由本表和每个 PR 的描述显式维护。前置合入后，后续 PR 必须同步最新 `main` 并重跑完整 CI，不能直接合并依赖未满足的红色 PR。

---

## 1. 背景

桌面端目前已有两块互不相通的「核心管理」：

- **本机核心**：`apps/desktop/src-tauri/src/service/core/*`（Rust）+ `service/download/*`，
  壳 UI 在 `apps/desktop/src/ui/config/core.tsx`，面板支持列版本、下载、切换、卸载、更新、asar 形态、随包内核。
- **远端核心**：`packages/builtin-plugin-remote/src/host/service/machine.ts`（TS），
  只有一个 `install` 原语（装/重装一份），没有版本清单、没有多版本、没有回滚，UI 藏在插件设置分区里。

问题：两者**语义上是同一类操作（把某个 dsh 发行版装进受管根目录、按档案拉起实例）**，
但实现分处两种语言、两条链路，用户在桌面壳里感受不到统一。

目标：让桌面壳的核心管理界面能**同时管理本机与远端的 dsh 核心**，且两边用同一套操作原语与契约。

---

## 2. 现状结论（代码实读）

### 2.1 调用链路

```
Tauri 桌面壳 (Rust)          apps/desktop/src-tauri/src/bridge/remote.rs
   │  仅做「转发 + 守卫」，不含 SSH 逻辑
   ▼ 本机 Harness 内核 (Node)      /api/tauri/remote/*  ← 20 个手写白名单端点
   ▼
内置插件 dsh-tauri-remote     packages/builtin-plugin-remote/src/host/**
   │  SSH 传输 (ssh2)：exec + 反向 stream
   ▼
远端 ~/.dsh-desktop/{runtime,dependencies} + 独立 dsh 实例
```

要点：**壳不能自己 SSH**。ssh2 在插件的 Node 侧，插件跑在本机核心进程里，
所以壳的一切远端操作必须经「壳 → 本机核心 HTTP → 插件 → SSH」四层。

### 2.2 本机 / 远端原语对照（语义同构、实现不同源）

| 原语 | 本机（Rust） | 远端（TS + SSH） | 可否复用 |
| --- | --- | --- | --- |
| 装 / 重装某版本 | `service/download/*` + `config/dependencies.rs` | `host/service/bootstrap.utils.ts` 生成 POSIX 脚本经 SSH 执行 | 否，两份代码 |
| 版本清单 | `service/download/github.rs: fetch_dsh_pkg_releases` | `host/utils/version.ts: listGithubReleases` | 逻辑同构，代码不同 |
| 版本兼容门槛 | `service/core/source.rs: app_core_meets_baseline`（0.2.2-rc.1） | `host/service/bootstrap.utils.ts: assertSupportedDshVersion` | 否，两份判定 |
| 「激活某版本」 | 改依赖根指向 `dependencies/<tag>` 槽位 | 目录互换 + 改写 `.active-tag` + 按端口停实例再拉起 | 语义一致，机制不同（P2-2） |
| 完整性校验 | release digest → `verify_sha256` | release digest / npm integrity / node SHASUMS | 同思路 |
| 安装布局 | `dependencies/{dsh,pnpm}`（AppData 依赖根） | `~/.dsh-desktop/{dependencies/dsh,dependencies/pnpm,runtime/bin/node}` | 同构，不同根 |
| 打包形态 | asar 归档 / 目录树两种（`core_asar` 开关） | **只有目录树** | 远端缺（非目标） |
| 平台矩阵 | win/mac/linux × x64/arm64（+ Windows MinGit） | linux-x64、linux-arm64、macos-x64 | 远端是子集 |
| 多版本 | 槽位制 `dependencies/<tag>`，可回滚 | 槽位制 `dsh-<tag>` + `.active-tag`，可切换回滚 | 语义同构，不同根/不同代码 |
| 激活标记 | `active_core` / `dsh_pkg_tag` + 依赖映射 | `~/.dsh-desktop/dependencies/.active-tag`（远端唯一事实来源） | 同思路 |
| 实例身份 | 本进程，无跨进程端口概念 | **主机 + 端口**，pidfile/日志/令牌按端口命名（#1578） | 远端特有 |

结论：**语义层是同一套原语，实现层不共用**。表格已按 P1/P2-1/P2-2 合入后的实际状态更新——
「版本清单 / 多版本 / 切换回滚 / 激活标记」远端均已落地；仍未实现的是 `removeSlot`（P2-3）与 asar / 随包 / 全平台（非目标）。

### 2.3 远端已具备的能力（不用重做）

- `machine.install()`：探测平台 → 选发行源 → 校验版本 → 装 node+pnpm+dsh 三件套 → 拷 `.env` 凭据 → 自动重连。
- `machine.connect()`：SSH 反向转发 + 本机回环 gateway（注入远端 web token）+ 指数退避重连。
- 捆绑插件同步：`host/utils/plugins-sync.ts` 把桌面捆绑插件以 `link:` 写进远端档案。
- 插件/Skills 单向同步：`host/service/sync.ts`（`dsh plugin --profile X add` + tar over stdin）。
- 远端档案：每机器一个 `profileName`（默认 `remote`），实例以 `--profile` 启动；
  pidfile 为 `~/.dsh/.dsh-remote-<端口>.pid`，**按端口命名，不再按档案拆**（#1578，见 4.7）。

### 2.4 仍存在的远端能力缺口

P1 / P2-1 / P2-2 已补齐版本清单、当前版本、槽位、指定版本安装与切换回滚（见 2.2）。剩下未闭合的：

- `installRef` 仍是**全局插件配置**（`host/config/schema.ts`），不是 per-machine（第 9 节待决 1）。
- 远端档案可只读列举（`core/profiles`），但不可创建 / 新增 / 删除；`profileName` 本身仍只是字符串。
- 远端插件只能「本机 → 远端」单向同步；没有远端插件列表，桌面看不到远端装了什么（P3）。
- `removeSlot` / 卸载远端副本：能力已声明，端点未实现（P2-3 `NOT STARTED`）。
- 远端 dsh 版本已透出到 UI（P1/P2 的 `CoreTarget` 槽位），不再是缺口。

---

## 3. 目标与边界

### 3.1 目标

1. 桌面壳的核心管理界面能**同时列出并操作本机核心与远端核心**，目标可切换。
2. 远端侧补齐本机已有的核心原语：列版本、查当前版本、指定版本安装、切换/回滚、重启远端实例。
3. 两边共用一份**中立视图模型与操作契约**，避免两套字段各说各话。

### 3.2 非目标（本轮不做）

- 不做「从远端机器反向管理另一台远端机器」（递归歧义，UI 侧禁用即可）。
- 不改 `source/deepseek-harness`（核心仓）——插件已自带远端逻辑，核心仓不需要动。
- 不追求远端支持 asar / 随包内核 / Windows Git / 全平台矩阵（做不到，也不做）。
- 不动本机核心既有代码路径（除非为了加 `capabilities` 字段而必要地扩展 `HarnessCore`）。

---

## 4. 设计

### 4.1 中立视图模型（先冻结契约，再实现）

本机现有类型是 Rust 的 `HarnessCore`（`service/core/source.rs`）：
`{ id, source: local|app, version, tag, path, dir, present, active, removable, preview, bundled, orphaned, error }`。

远端要输出**字段语义一致**的模型，统一为：

`CoreTarget` 只描述目标和目标能力，安装事实放入槽位数组。目标可用性和每个槽位状态都使用判别联合，客户端禁止自行组合 `present`、`active`、`error` 推导状态。

```ts
CoreTarget =
  | CoreTargetBase & {
      availability: "absent"
      slots: []
    }
  | CoreTargetBase & {
      availability: "present"
      slots: CoreSlotState[]
    }
  | CoreTargetBase & {
      availability: "unreadable"
      error
      path?
      slots: CoreUnreadableSlot[]
    }

CoreTargetBase {
  id              // 目标 ID，见 4.2
  scope           // "local" | "remote"
  machineId?      // remote 必有
  remoteProfile?  // remote 必有
  capabilities[]  // 目标支持的动作，见 4.3
  platforms[]     // 目标支持的平台
}

CoreSlotState =
  | {
      kind: "installed"
      slotKey       // 版本行稳定标识，见 4.2
      version
      tag?
      path?
      dir?
      active
      removable?
      preview?
      bundled?
      orphaned?
    }
  | { kind: "unsupported", slotKey, version, path?, error }
  | { kind: "unreadable", slotKey, path?, error }
```

`availability: "unreadable"` 表示目标级状态不完整，不能据此推导未安装。`slots` 可以保留身份已确认但自身不可读的槽位，供后续行操作定位；身份无法识别的读取失败仍返回空数组。目标级 `error` 描述全局读取失败，槽位级 `error` 描述该槽位自身的元数据或访问失败。

目标状态判定必须按以下优先级收敛：

1. `present + installed slot`：读取到有效 `version`，且版本满足最低门槛。
2. `present + unsupported slot`：读取到有效 `version`，但不满足最低门槛。
3. `unreadable`：安装入口存在，但包元数据缺失、损坏，或读取命令失败。
4. `absent`：远端明确报告包不存在，且入口探测也没有路径，槽位数组为空。

只有 `installed slot` 可以携带 `active: true`。读取失败、元数据损坏或“入口存在但包不存在”必须进入 `unreadable`，不能折叠为 `absent`，也不能被当成安装证据。P1 的多个已安装版本各占一个槽位，分别拥有状态和 `slotKey`。

本机侧 = Rust `HarnessCore` 适配到该模型；远端侧 = 插件新路由直接返回该模型。

### 4.2 目标身份：三维，不是开关

```
scope : local | remote
远端再分 : machineId × remoteProfileName   ← 契约身份保留两维；当前落地是一条机器条目绑定一个档案 + 一个端口，
                                              实例由端口唯一确定、档案由实例自报（#1578，见 4.7 / 4.8）
本机再分    : desktopProfile                   ← 本机核心面板本身已是「当前档案」作用域
                                                  (service/workflow/instances.rs: require_exclusive_profile)
```

「同机多档案各有独立实例」在当前数据模型下不自动成立（`machineProfiles` 是 `MachineId → MachineProfile`
单值映射）。真要支持，需为每档案建独立机器条目并各配不同端口，届时档案才重新成为选择维度之一。

Tauri 窗口 label 与 Core 目标 ID 是两套标识，不得互相推导：

- 窗口 label 使用 `bridge/remote.rs: profile_window_label` 的
  `remote-<profileHex>--<sanitizedMachineId>`，只用于窗口去重、聚焦和 capability 匹配。
- `CoreTarget.id` 使用独立的目标命名空间，作为 API 与 UI 的稳定契约身份：

- 本机：`local:<desktopProfile>`
- 远端：`remote:<machineId>:<remoteProfile>`

窗口 label 不得作为 `targetId` 传递；`CoreTarget.id` 也不得直接用作 Tauri 窗口 label。`id` 标识的是目标，不标识某一行版本。目标下的每个版本行另带稳定 `slotKey`；所有针对已有版本行执行的动作请求必须同时携带 `targetId + slotKey`，禁止通过数组下标、版本展示文案或“当前版本”隐式选择。

建议统一操作头：

```ts
CoreRowRef {
  targetId: string
  slotKey: string
}
```

`slotKey` 在安装时生成，后续改名、升级或重新排序都不得变化。P0 只暴露当前安装行时固定为 `current`；P1 引入多槽位后改用真实槽位标识。

首次安装是唯一例外：安装前目标下还没有可引用的槽位。安装请求只携带 `targetId + tag`，服务接受后创建槽位，并通过任务状态或事件流返回新槽位的 `slotKey`。`activate`、`removeSlot` 等已有行操作继续使用 `CoreRowRef`。

### 4.3 能力声明（capabilities）

本机与远端能力不对等，UI 必须按能力裁剪按钮，不能共用一套本机按钮：

| capability | 本机 | 远端 |
| --- | --- | --- |
| `listVersions` | ✅ | ✅（#1565） |
| `installVersion` | ✅ | ✅（#1565，需指定 tag） |
| `activate`（切换版本） | ✅ | ✅（#1568，目录互换 + 重启 + 重建连接） |
| `removeSlot` / 回滚 | ✅ | ❌ 未实现（P2-3；切换可回滚，但卸载副本无端点） |
| `asar` 形态 | ✅ | ❌ 永不 |
| `bundledCore`（随包内核） | ✅ | ❌ 永不 |
| `platforms` | 全平台 | linux-x64/arm64、macos-x64 |

远端能力集合由 `shared/core.ts: REMOTE_CORE_CAPABILITIES` 声明，当前为
`['listVersions', 'installVersion', 'activate']`——UI 按此裁剪按钮；`removeSlot` 尚未加入。

### 4.4 长任务事件流化（否则第一步就被超时打断）

现状：壳对写操作 600s 超时（`bridge/remote.rs`），插件 `installTimeoutMs` 默认 1800s（`host/config/schema.ts`），
SSH 自身还有超时 —— **三层口径不一致**，同步等 install 必然被壳提前掐断。

契约层统一为：长操作返回 `{ taskId }`，进度走事件流。安装接收 `targetId + tag`，完成后产生新 `slotKey`；针对已有槽位的操作接收 `CoreRowRef`。
现有 `machines/events` 的 `::dsh <stage> <line>` 格式（`host/service/bootstrap.utils.ts: parseBootstrapLine`）
可扩展成通用 task 流。

### 4.5 版本兼容过滤

「可用版本列表」直接过滤掉不兼容版本，而不是让用户装完才发现挂不住插件：

- 门槛：0.2.2 系列（对齐 `assertSupportedDshVersion` 与本机 `app_core_meets_baseline`）。
- 捆绑插件兼容：对齐 `service/core/source.rs: core_supports_bundled_plugins`
  （远端 dsh 版本过低会挂不住桌面捆绑插件）。

### 4.6 聚合位置：React 聚合，不在 Rust 聚合

- **不在 Rust 聚合**：`get_cores` 同时返回本机+远端虽可行（Rust 本就能调核心 HTTP），
  但会让本机核心面板从此依赖核心进程在线，且 `bridge/remote.rs` 的白名单是**手写**的，
  极易与生成的 TS 客户端漂移。
- **在 React 聚合**：`apps/desktop/src/apis/remote.ts` 已用 ofetch 直连本机核心；
  UI 同时取 `invoke('get_cores')`（本机）与新增的远端接口，再归一化。故障域分离，本机路径零改动。

### 4.7 实例档案：只读发现、按实展示、分场景校验（P3-0，本分支已实现，待提 PR）

> 状态：P3-0 已在本分支实现（issue #1600），尚未提交上游 PR。实现前本节曾被写成既成事实却写反了 #1574 方向，
> 经 #1600 纠正后按下列口径落地。#1574 的真实演进是「静默复用 → 核对不符报错」（提交 `761c61cb`），不是相反。

身份口径以 #1578 的结论为准：**远端实例的身份是「主机 + 端口」，一个端口上只可能有一个实例**。
档案不是实例的身份，而是实例服务哪份数据的属性（配置目录、插件、工作区、会话集合）。因此把档案从
「连接时校验的配置声明」重新定位为「实例自报、按实展示的事实」，按三层动作组织：

1. **只读发现**：`host/utils/instance.ts: readListenerState(session, port, expected)` 一次 exec 拿全监听进程身份，
   返回三态 `{ verdict: match | mismatch | unknown, actual, expected, port, pid, createdByDesktop }`（`ListenerState`）。
   Linux 读 `/proc/<pid>/cmdline`，macOS 读 `ps -ww -o command=`，取 `--profile`；认不出为 `actual: undefined`、不猜。
   契约层已暴露为 `GET /api/tauri/remote/core/instance`（`shared/core.ts: RemoteInstanceStatus`，`clientCount?` 留给 #1576）。
   这一步不写远端，与 #1575 的只读连接同向。旧的 `readListenerProfile` / `assertListenerProfile` 保留为薄封装。
2. **按实展示 + 分场景校验**：三态结果由各调用点按场景决定动作，而非统一弹确认（那会误伤没有 UI 上下文的自动就绪判定）：
   - 自己刚拉起的实例（`bootstrap.utils.ts` 的 `judgeReadiness`）：不符保留硬报错 `REMOTE_INSTANCE_PROFILE_MISMATCH`
     ——#1574 的核心保护，实例是自己起的，不符即异常；
   - force 强制重装（`machine.ts` 的 `performInstall`）：不符抛 `REMOTE_PROFILE_MISMATCH_CONFIRM_REQUIRED`，
     UI 预检 `GET core/instance` 后弹确认框，确认后带 `ackProfileMismatch` 重试放行并记警告事件；
   - 捆绑插件同步（`plugins-sync.ts`，后台 connect 路径无 UI）：不符记警告事件并跳过本次同步，不覆盖别人的实例、不阻断连接。
   档案列表（`GET core/profiles`，读 `~/.dsh/profiles/*`）与实例实际档案是两个维度：列表是磁盘上有哪些档案，
   实例档案是端口上的进程绑在哪份。列表可见不代表能确定绑定——远端缺 lsof/ss、实例由命令行或其他桌面端拉起、
   argv 无 `--profile` 时，列表正常但档案认不出（pidfile 已按 #1578 只按端口命名，argv 是唯一事实来源）。
   故「认不出」保留为 `unknown`、不阻断，UI 标「未知档案」；列表只有一个档案时可作提示，但须标明是推测。
   桌面档案面板与插件机器面板均按实例实际档案展示（`remote-profile.tsx` 的 `remoteCoreInstance` query）。
3. **显式写**：停实例、替换核心、同步捆绑插件、强制重装等会打断共享实例的操作，一律独立成显式步骤，
   执行前用发现结果和 #1576 的租约告知会打扰到谁；写操作之间由 #1578 的活动槽位占用锁互斥。

自检底线：默认档案是否参与比对，取决于它是否承载用户意图——这一语义调整由上述三态发现 + 分场景校验承载，
而非一句「默认档案不报错」。#1574 的既有保护在「自己拉起」场景完整保留，在「外部实例」场景由警告确认取代误判。

这一节是 #1550 中「实例不该独占、要独占的是对核心目录的写操作」的落地路径，归属 P3 开篇（P3-0）。
它同时是 #1575（只读连接）、#1576（租约告知）的共同入口：两者都需要一次只读的实例状态发现。

### 4.8 档案管理与核心管理的分工

两者常被混为一谈，但身份层、事实来源与能力边界都不同，这里集中收口，作为 4.2 / 4.3 / 4.7 / 6.1
分散结论的统一锚点：

| 维度 | 核心管理 | 档案管理 |
| --- | --- | --- |
| 管什么 | 装哪个 dsh 发行版、当前激活哪个副本 | 实例服务哪份数据（配置、插件、工作区、会话） |
| 身份层 | 目标 `local:<profile>` / `remote:<machineId>:<profile>` + 槽位 `slotKey`；进程由**主机 + 端口**唯一确定 | 档案是**数据层身份**，不是进程身份；由端口上的实例自报 |
| 事实来源 | 远端 `~/.dsh-desktop/dependencies/.active-tag` + `dsh-<tag>` 槽位目录，本机不镜像 | 监听进程 argv（`readListenerProfile` 读 `--profile`）实测 + 远端 `~/.dsh/profiles/<档案>` |
| 配置角色 | `installRef` / `tag` 是**选择参数**（装哪个版本） | 默认 `profileName` 是连接占位；P3-0 已按实展示、仅显式写操作才按三态校验（本分支实现，待提 PR） |
| 作用域 | 核心页：本机或某台远端机器，一次一个目标 | Profile 页：同构选择器；远端只读展示，本机才有新建/克隆/切换/删除/迁移 |
| 读写性质 | 清单 / 下载 / 切换 / 卸载是写操作，切换占槽位锁并重建连接 | P3-0：只读发现 + 按实展示（本分支实现）；停实例 / 改档案属显式写（#1575、#1576） |
| 当前能力 | 远端 listVersions / installVersion / activate 已实现；`removeSlot` 缺（P2-3） | 远端档案只读列举（#1564）+ 实例档案只读发现、按实展示（P3-0 本分支实现，待提 PR）；增删改与反向管理属 P3 |

一句话：**核心管理决定「用哪个引擎」，档案管理决定「引擎服务哪份数据」；前者按版本槽位切换，
后者按实例实测展示，两者的身份与事实来源互不替代。**

---

## 5. 影响范围

### 5.1 插件侧 TS（主要工作量）

`packages/builtin-plugin-remote/src/host/`

- 新增 `service/core.ts`：**从「机器中心」改成「核心中心」**。
  组合 `machine.openSession()`（SSH 会话）+ `utils/version.ts`（版本清单）+ 新的槽位/档案枚举；
  `machine.*` 退居为传输层。
- `service/bootstrap.utils.ts`：`buildInstallScript()` 扩出「装到指定槽位而非覆盖」，
  保持幂等与回滚（现有 `flatten_move` + `REINSTALL=1` 语义要扩）。
- 远端槽位：目录形态已定为 `~/.dsh-desktop/dependencies/dsh-<tag>`，激活指针用 `.active-tag`
  记录文件（不用 symlink，见 4.2 / 第 9 节已收口项）；档案数据在远端 `~/.dsh/profiles/<档案>`，本机不镜像。
- `config/schema.ts`：`installRef` 从**全局插件配置**下沉为 per-machine 参数（schema 级改动）。
- `service/state.ts`：`machines.json`（`host/config/runtime.ts` 的 `STATE_DOCUMENT`）增字段持久化远端已装版本/tag/digest/槽位。
- `server/routes/`：新增约 6–10 个路由 + `server/routes/index.types.ts` 契约。
- `client/apis/`：插件自己的设置页也要跟上（`client/apis/index.ts` / `index.type.ts` / `parsers.ts`，两份 API 客户端，别只改一边）。

### 5.2 契约生成链（低成本但必须跑）

- `packages/builtin-plugin-config/genapi.config.ts` → 重新生成
  `apps/desktop/src/apis/remote.ts` + `apps/desktop/src/apis/remote.types.ts`。

### 5.3 壳侧 Rust（小而关键）

`apps/desktop/src-tauri/src/bridge/remote.rs`

- `remote_method()` **手写白名单**要加新端点（最易漏）。
  现有单测 `remote_whitelist_matches_generated_endpoints`（`remote.rs:434`）已把生成清单与白名单逐条比对，
  端点增减会直接失败——它已覆盖原计划「生成的端点数与白名单一致」的守卫诉求，无需再加一条。
- 超时口径：写操作 600s 要与插件的 1800s 对齐（或改成长任务 + 事件流）。
- 若最终仍想在 Rust 侧聚合，再考虑扩 `service/core/source.rs: CoreSource`（`local|app` → 加 `remote`）；
  按 4.6 的结论默认**不做**。

### 5.4 壳侧 React（中等）

- `apps/desktop/src/ui/config/core.tsx`：加「远端核心」分组 / 目标选择器，按 capabilities 裁剪按钮。
- `apps/desktop/src/hooks/use-remote.ts`：机器状态轮询已有可复用；远端安装进度走事件流增量。

### 5.5 插件会被同步到远端机器（易漏的副作用）

`host/utils/plugins-sync.ts` 会把桌面捆绑插件（含 `dsh-tauri-remote` 自己）link 进远端档案，
所以新增的远端核心端点在**远端实例上也会存在**。
UI 侧必须按 `host/service/session.ts` 的 `role.remote`（`DSH_REMOTE_SESSION_ORIGIN`）禁用相关入口。
先例：`client/register/section.ts` 已有 `role.remote !== false` 的判断。

### 5.6 测试与文档

- 插件 vitest：`service/machine.ts`、`service/bootstrap.utils.ts`、`service/sync.ts` 相关用例。
- 壳 Rust：`bridge/remote.rs` 白名单单测。
- 壳 React：`apps/desktop/src/ui/config/core.test.tsx`。
- 文档：仓库 `README.md` 功能列表、`packages/builtin-plugin-remote` 文档、mintlify 站。

---

## 6. 阶段划分

| 阶段 | 内容 | 是否改行为 | 状态 |
| --- | --- | --- | --- |
| P0 | 冻结中立视图模型、状态判定与行身份；插件加只读路由骨架（`GET core/versions`、`GET core/current`）+ 契约与 genapi 生成 + Rust 白名单打通 | 否（纯新增） | MERGED |
| P1 | 全部远端机器、版本目录、当前槽位、远端档案及只读 UI；Core 与 Profile 页面复用同一机器选择交互 | 少量 | MERGED（#1563）+ OPEN（#1564） |
| P2-1 | 核心面板按目标管理本机或某台远端机器；远端清单与本机同构展示，并可按版本下载（长任务 + 事件流） | 少量 | MERGED（#1565） |
| P2-2 | 切换远端机器当前使用的版本（目录互换 + 重启实例 + 重建连接），回滚即切回 | 是 | NOT STARTED |
| P2-3 | 卸载远端机器上不再需要的版本副本 | 少量 | NOT STARTED |
| P3-0 | 实例档案管理：只读发现实例档案、已有实例按实展示（忽略默认档案）、自拉实例设定档案（第 4.7 节） | 少量（三态原语 + 只读契约 + 三处调用点 + 展示逻辑） | 本分支已实现，待提 PR |
| P3 | 远端插件与档案的反向管理（同步面板由单向变双向） | 是（最大） | NOT STARTED |

严格按 PR 依赖表推进；P3 视 P2 的稳定性再决定。P3-0 是 P3 的前置，也是 #1575 / #1576 的共同入口：
先有只读的实例状态发现，才谈得上「连接只读」「告知谁在用」与「手动管理实例」。

### 6.1 当前实现（#1563、#1564、#1565）

- 核心设置页用同一个面板管理本机或某台远端机器，一次只管理一个目标；两端能力一致（版本清单、下载，以及后续的切换与卸载）。
- 展示可用版本、当前槽位、Core 状态和 capabilities。
- Profile 设置页采用与核心设置页一致的作用域模型：页头选择「本机」或某台远端机器，
  一次只展示一个作用域。选中本机时由桌面壳提供完整功能（新建、克隆、切换、删除、迁移）；
  选中远端机器时只读展示该机器上的档案，并标记当前配置档案。
- 两个页面复用主界面右上角机器切换器的状态、地址和选择交互。
- 新增只读 `GET core/profiles` 契约，并同步生成客户端、端点清单和 Rust 白名单。
- 远端机器上可以并存多份核心副本（`dsh-<tag>` 目录），副本清单与本机同构；把某一份切成当前使用的那份仍属于 P2-2。
- 不可读目标可以保留身份已确认的不可读槽位；槽位身份无法识别时仍返回空数组。
- 远端 Profile 目录在枚举前显式验证可读性与搜索权限；真实权限不足会返回 `REMOTE_CORE_PROFILES_UNREADABLE`。
- 两个页面都用页头作用域选择器：作用域值把远端机器放进 `remote:` 命名空间，查询与刷新时还原真实机器 id；SSH Host 名为 `local` 时也不会和本机作用域冲突。
- 选中的远端机器消失时，两个页面的作用域都退回本机，不会停在空视图上。

### 6.2 当前验证（#1563、#1564）

- TypeScript typecheck 与全量 ESLint 通过。
- 全量单测 107 个文件、990 个用例通过。
- 档案作用域相关用例 12 个，连续 3 次复跑通过。
- 新增 `0400` 无搜索权限、`0300` 无读取权限的真实目录回归。
- Rust 远端桥接测试由上游 CI 运行，当前 19 个用例。
- 新增 Profile 端点重复运行 `genapi` 无工作区漂移。

---

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| Rust 手写白名单与生成的 TS 客户端漂移 → `REMOTE_METHOD_INVALID` | 加「生成端点数 == 白名单条目数」的守卫测试 |
| 三层超时（壳 600s / 插件 1800s / SSH）不一致，长安装被腰斩 | 契约层长任务一律 `taskId + 事件流` |
| 能力不对等导致误导 UI（按钮在、远端点不动） | 契约里显式 `capabilities[]`，UI 按能力裁剪 |
| 远端版本过低挂不住桌面捆绑插件 | 版本清单阶段就过滤，不兼容版本不出现在可选列表 |
| 远端安装需远端有外网 + curl/wget | 安装前置探测并给出可读提示（现有 `REMOTE_INSTALL_NO_DOWNLOADER`） |
| 远端插件被同步到远端机器运行，接口语义歧义 | 按 `role.remote` 禁用远端侧入口 |
| 本机核心面板被远端故障拖累 | React 层聚合、故障域分离；本机路径不依赖核心进程 |

---

## 8. 验收标准

### 8.1 P0

- 目标 `absent`/`present`/`unreadable` 与槽位 `installed`/`unsupported`/`unreadable` 都有负向或边界用例。
- 读取失败、损坏元数据和“入口存在但包不存在”不会被报告为未安装或已激活。
- `CoreTarget.id` 只标识目标；已有行操作使用 `targetId + slotKey`，首次安装使用 `targetId + tag` 并在任务中返回新槽位身份。
- 远端插件客户端、桌面生成客户端与 Rust 白名单的端点集合完全一致，并有漂移守卫。

### 8.2 P1 完成态

- 核心设置页显示本机核心和所有远端机器的只读 Core 信息。
- 每行展示 `slotKey`、版本、tag、激活/预览/不支持/不可读状态和能力标记。
- 远端档案可以跨机器查看，并标记当前机器配置档案。
- 远端区域按能力保持只读，不展示安装、切换、卸载和重启入口。
- 机器选择器复用主界面切换器的状态与地址展示，避免两套交互漂移。
- Rust 白名单与生成客户端一致，有守卫测试。

---

## 9. 待决问题

> 已收口的历史待决项不再保留在本节，结论已回写正文：槽位目录形态与激活指针 = 目录互换 +
> `.active-tag`（2.2 / 5.1）；「切换版本」= 重启实例，界面显式确认中断影响（4.3 / 6.1）；
> 长任务 = `taskId + core/tasks/events` 事件流（4.4）；已有实例按实际档案展示、忽略默认档案（4.7）。

### 核心管理（P0–P3）

1. `installRef` 下沉为 per-machine 后，插件级默认值是否保留（保留则语义是「默认 + 每机覆盖」）。**仍未定**。
2. 远端插件反向管理（P3）是否需要「远端插件列表」接口先于 P2 落地，取决于用户是否真的需要。**仍未定**。

### 实例与档案管理（P3-0，第 4.7 节）

> 以下两项已随 P3-0 实现收口（本分支，待提 PR）：契约字段定为 `verdict / actual / expected / port / pid /
> createdByDesktop`，`clientCount?` 留给 #1576；认不出档案统一为 `unknown`、UI 标「未知档案」不阻断。

3. ~~只读发现的实例状态契约要暴露哪些字段？~~ **已定**：端口、档案名、pid、是否本桌面创建；
   占用槽位由监听进程入口路径推断（后续可补），客户端数留 `clientCount?` 待 #1576 租约落地。
4. ~~认不出档案时如何呈现？~~ **已定**：`verdict: unknown`、不阻断，UI 标「未知档案」，沿用 #1578「不算错」口径；
   列表只有一个档案时可提示但标注为推测。
