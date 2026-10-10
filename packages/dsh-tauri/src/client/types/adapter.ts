/**
 * client/types/adapter.ts — DSH 客户端升级迁移适配层的公开契约。
 *
 * 实现见 `client/register/index.adapter.ts`（`defineAdapter` / `defineRegister` 第三个参数）。
 *
 * 存在的理由：官方核心的客户端服务布局逐版本漂移，同一件事在不同版本落在不同服务上——
 * 目录选择在 `≤0.1.2-rc.1` 线由独立的 `uiWorkspace` 提供，`0.1.5-rc.1` 起收进
 * `ctx.workspaces.pickDirectory`；会话列表投影在旧版嵌在 `sessions.list` 上，新版
 * `sessions.list` 本身就是 ObservableSnapshot 契约。消费插件不该散落
 * `if (version)` 分支与 `as unknown as` 断言。
 *
 * 本契约只描述「能力」，不描述「版本」：成员按需可选，探测不到即视为不可用。
 * 消费方按退级阶梯自行决定（官方 API → 桌面壳补丁 → DOM 补丁 → 禁用），
 * 或直接用 `startSession` / `addWorkspace`，由适配层替它走完整条退级链路。
 */

/** 运行期服务对象的宽松读取目标（官方 client 服务的结构随版本漂移）。 */
export type AdapterRuntimeObject = Record<string, unknown>

/** 会话 id / 工作区 id 的结构等价物（不绑定具体核心版本的 branded 类型）。 */
export type AdapterSessionId = string
export type AdapterWorkspaceId = string

/**
 * 探测到的服务布局世代——**只用于诊断与日志**，任何分支都不读它：
 * `legacy` 对 `≤0.1.2-rc.1` 线（导航在独立 `uiWorkspace`、列表投影嵌在 `sessions.list`），
 * `modern` 对 `0.1.5-rc.1` 起（导航与目录选择统一在 `workspaces`）。
 */
export type AdapterGeneration = 'legacy' | 'modern' | 'unknown'

/** 官方列表服务的稳定投影（`list.subscribe` / `list.getSnapshot`）。 */
export interface AdapterListProjection<TSnapshot = unknown> {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => TSnapshot
}

export interface AdapterSessionCreateOptions {
  workspaceId?: AdapterWorkspaceId
  cwd?: string
  sessionId?: AdapterSessionId
}

/** 已适配的 `ctx.sessions` 面；成员按能力可选，缺失即视为不可用。 */
export interface AdapterSessions extends AdapterRuntimeObject {
  /** `useSessions` 标准 feed（跨版本同形）。 */
  list?: AdapterListProjection
  /** legacy 投影：由 `list.getSnapshot` 派生（新核心请直接用 `list.getSnapshot`）。 */
  getSnapshot?: () => unknown
  /** legacy 投影：由 `list.subscribe` 派生。 */
  subscribe?: (listener: () => void) => () => void
  /** legacy 投影：per-session 信息查询（新核心已由 `provide` / `currentProvideInfo` 取代）。 */
  provideInfo?: (sessionId: AdapterSessionId) => unknown
  /** 稳定会话 binding（legacy 的 `provideInfo` 兼容投影依赖它）。 */
  binding?: (sessionId: AdapterSessionId) => unknown
  create?: (options?: AdapterSessionCreateOptions) => Promise<AdapterSessionId>
  refreshProjections?: (sessionId: AdapterSessionId) => Promise<void>
  refresh?: () => unknown
  open?: (sessionId: AdapterSessionId) => unknown
  fork?: (...args: unknown[]) => unknown
}

/** 已适配的 `ctx.workspaces` 面；成员按能力可选，缺失即视为不可用。 */
export interface AdapterWorkspaces extends AdapterRuntimeObject {
  list?: AdapterListProjection
  /** 登记一个已有路径为工作区。 */
  create?: (input: { path: string }) => Promise<{ workspaceId: AdapterWorkspaceId } & AdapterRuntimeObject>
  /** 新建会话（modern 原生 / legacy 由 `uiWorkspace` 投影）。 */
  startSession?: (workspaceId?: AdapterWorkspaceId) => unknown
  /** 连接的复用或新建空白会话（modern 原生 / legacy 由 `uiWorkspace` 投影）。 */
  connectWorkspace?: (workspaceId: AdapterWorkspaceId) => unknown
  /** 拉起宿主原生目录选择器（modern 原生 / legacy 在 `uiWorkspace` 上）。 */
  pickDirectory?: () => Promise<string | null | undefined>
  /** 打开已有会话（0.1.6-alpha.2 起改由 `uiWorkspace.openSession` 承担，此处为兼容候选）。 */
  open?: (sessionId: AdapterSessionId) => unknown
  archiveSession?: (...args: unknown[]) => unknown
  delete?: (...args: unknown[]) => unknown
}

/**
 * 「打开文件夹」三段能力的聚合面。
 *
 * 与官方「添加工作区」流程（`pickDirectory()` → `create({ path })` → `startSession(id)`）
 * 逐步一致；三段缺一即视为不可用，由消费方退级到点官方按钮。
 */
export interface AdapterAddWorkspaceRuntime {
  pickDirectory: () => Promise<string | null | undefined>
  createWorkspace: (input: { path: string }) => Promise<{ workspaceId: AdapterWorkspaceId }>
  startSession: (workspaceId: AdapterWorkspaceId) => unknown
}

/**
 * 官方会话列表的稳定投影。
 *
 * 这是判断「某条会话是否还在」的唯一官方依据：归档的会话会直接从 `ids` 消失，
 * 而不是被标记成某个状态。
 */
export interface AdapterSessionList {
  /** 官方活动会话 id（已归档的不在其中）。 */
  ids: readonly AdapterSessionId[]
  /** 当前选中的会话 id。 */
  current?: AdapterSessionId
  /** 订阅列表变化。 */
  subscribe: (listener: () => void) => () => void
}

/** 跨版本导航入口（legacy 的 `startSession` 返回 void，modern 也返回 void）。 */
export type AdapterStartSession = (workspaceId?: AdapterWorkspaceId) => unknown

/**
 * 跨版本「选中已有会话」入口。
 *
 * 落点随版本迁移：`≤0.1.5-rc.2` 在 `sessions.open`，`0.1.6-alpha.2` 收进
 * `uiWorkspace.openSession` 并移除了 `sessions.open`。
 */
export type AdapterOpenSession = (sessionId: AdapterSessionId) => unknown

/** 守卫安全的服务读取器（`ctx.get(name)` 优先，回退属性读取，异常即不可用）。 */
export interface AdapterProbe {
  /** 读官方服务；Cordis 的 inject-only 守卫抛错时返回 undefined。 */
  service: <T = AdapterRuntimeObject>(name: string) => T | undefined
  /** 由原始上下文探测出的布局世代（迁移执行前算好，只作诊断）。 */
  generation: AdapterGeneration
}

/** 迁移可读写的适配中间态：迁移按序把服务投影到这里，最终冻结为 `ClientAdapter`。 */
export interface AdapterSurface {
  sessions?: AdapterSessions
  workspaces?: AdapterWorkspaces
  uiWorkspace?: AdapterRuntimeObject
  uiSession?: AdapterRuntimeObject
  startSession?: AdapterStartSession
  openSession?: AdapterOpenSession
  addWorkspace?: AdapterAddWorkspaceRuntime
}

/**
 * 一条 DSH 升级迁移。
 *
 * 约定：`detect` 只读上下文（能力探测），`apply` 只写表面投影；两者都应为幂等、无副作用的
 * 纯投影——不注册监听、不写官方服务、不依赖调用顺序以外的状态。
 */
export interface DshMigration {
  /** 稳定 id（诊断、测试与 `adapter.migrations` 断言的键）。 */
  id: string
  /** 该迁移负责的版本差异（文档用）。 */
  description?: string
  detect: (probe: AdapterProbe, surface: AdapterSurface) => boolean
  apply: (surface: AdapterSurface, probe: AdapterProbe) => void
}

/** 迁移执行失败记录：不中断插件装配，但绝不静默。 */
export interface AdapterMigrationFailure {
  migration: string
  error: unknown
}

/** 可探测的适配能力；消费方据此选退级路径，而不是猜版本号。 */
export type AdapterCapability
  = | 'sessions.list'
    | 'sessions.provideInfo'
    | 'sessions.create'
    | 'sessions.refresh'
    | 'sessions.refreshProjections'
    | 'workspaces.list'
    | 'workspaces.create'
    | 'navigation.startSession'
    | 'navigation.openSession'
    | 'navigation.addWorkspace'
    | 'composer.workspace-less'
    | 'dom.newSession'
    | 'dom.addWorkspace'

/** `adapter.startSession()` 的结果：明确回报走了退级阶梯的哪一级。 */
export type AdapterStartSessionOutcome
  = | { status: 'started', value: unknown }
    | { status: 'delegated' }
    | { status: 'unavailable', reason: string }

/** `adapter.openSession()` 的结果：官方入口在场即打开，缺席明确回报不可用。 */
export type AdapterOpenSessionOutcome
  = | { status: 'opened', value: unknown }
    | { status: 'unavailable', reason: string }

/** `adapter.addWorkspace()` 的结果：明确回报走了退级阶梯的哪一级。 */
export type AdapterAddWorkspaceOutcome
  = | { status: 'created', workspaceId: AdapterWorkspaceId, path: string, sessionStarted: boolean }
    | { status: 'cancelled' }
    | { status: 'delegated' }
    | { status: 'unavailable', reason: string }

export interface AdapterAddWorkspaceOptions {
  /** 建好工作区后是否立即在其上开新会话（官方流程为 true，默认 true）。 */
  openSession?: boolean
}

/** 迁移后的上下文投影：`sessions` / `workspaces` 已换成适配后的服务面。 */
export interface AdapterContext extends AdapterRuntimeObject {
  sessions?: AdapterSessions
  workspaces?: AdapterWorkspaces
}

/** DSH 升级迁移适配实例（`defineRegister` 的第三个参数）。 */
export interface ClientAdapter {
  /** 探测到的布局世代（诊断用）。 */
  readonly generation: AdapterGeneration
  /** 本次实际应用的迁移 id（按执行顺序）。 */
  readonly migrations: readonly string[]
  /** 探测或迁移失败的记录（失败即告警，不中断装配）。 */
  readonly failures: readonly AdapterMigrationFailure[]
  /** 迁移后的上下文投影（旧写法可继续经它取服务）。 */
  readonly ctx: AdapterContext
  /** 适配后的会话服务面（服务缺席时为空对象，消费方可直接可选链）。 */
  readonly sessions: AdapterSessions
  /** 适配后的工作区服务面（服务缺席时为空对象）。 */
  readonly workspaces: AdapterWorkspaces
  /** 读任意官方服务（守卫安全）。 */
  service: <T = AdapterRuntimeObject>(name: string) => T | undefined
  /** 能力探测：不猜版本号，缺什么就报什么。 */
  has: (capability: AdapterCapability) => boolean
  /** 解析出的官方「新建会话」入口；缺席返回 undefined（调用方自行退级）。 */
  resolveStartSession: () => AdapterStartSession | undefined
  /** 解析出的官方「打开已有会话」入口；缺席返回 undefined（调用方自行退级）。 */
  resolveOpenSession: () => AdapterOpenSession | undefined
  /** 读官方会话列表投影；列表能力缺席时返回 undefined（调用方按「无法判断」处理）。 */
  sessionList: () => AdapterSessionList | undefined
  /** 解析出的官方「打开文件夹」能力；三段缺一返回 undefined。 */
  resolveAddWorkspace: () => AdapterAddWorkspaceRuntime | undefined
  /** 新建会话：官方服务 → 点官方按钮 → 明确回报不可用。 */
  startSession: (workspaceId?: AdapterWorkspaceId) => Promise<AdapterStartSessionOutcome>
  /** 打开已有会话：官方服务 → 明确回报不可用。 */
  openSession: (sessionId: AdapterSessionId) => AdapterOpenSessionOutcome
  /** 打开文件夹：官方三段能力全流程 → 点官方按钮 → 明确回报不可用。 */
  addWorkspace: (options?: AdapterAddWorkspaceOptions) => Promise<AdapterAddWorkspaceOutcome>
}

export interface DefineAdapterOptions {
  /** 追加迁移；在 `DEFAULT_DSH_MIGRATIONS` 之后按序执行（可覆盖既有投影）。 */
  migrations?: readonly DshMigration[]
  /** 告警出口（默认 console.warn；宿主可注入以把适配降级上报到插件面板）。 */
  onWarn?: (message: string, error?: unknown) => void
}
