/**
 * register/index.adapter.ts — DSH 客户端升级迁移适配层（`defineRegister` 的第三个参数）。
 *
 * 用法：
 * ```ts
 * const feature = defineRegister((controller, ctx, adapter) => {
 *   // 新建会话：官方服务 → DOM 退级，明确回报走了哪一级
 *   void adapter.startSession()
 *   // 打开文件夹：pickDirectory → create → startSession 全流程
 *   void adapter.addWorkspace({ openSession: true })
 *   // 跨版本同形的会话列表投影
 *   controller.add(adapter.sessions.list!.subscribe(() => sync()))
 *   if (adapter.has('workspaces.create')) { ... }
 * })
 *
 * ctx.effect(feature, 'demo: feature')
 * ```
 *
 * 四条设计约束：
 *
 * 1. **只按能力探测，不比对版本号**——`generation` 仅供诊断与日志，所有分支读服务形态；
 * 2. **迁移是按序执行的注册表**——新增一代 DSH 只需追加一条 `DshMigration`
 *    （`defineAdapter` 的 `migrations` 选项），既有迁移与消费方都不改；
 * 3. **探测绝不抛错**——Cordis 的 inject-only 守卫、半初始化上下文、缺失服务一律当作
 *    「能力不可用」，把退级决定权交回消费方（官方 API → 壳补丁 → DOM 补丁 → 禁用）；
 * 4. **官方服务的方法一律绑定到原对象再外抛**——核心服务是 class 实例，方法被解构后不能丢
 *    `this`，也绝不能让 Proxy 冒充 `this`（内部自调用与私有字段会炸）。
 *
 * 适配层是无状态投影：每次调用返回新实例，不注册监听、不持跨卸载状态，因此不需要 disposer，
 * 也不会与 `ctx.effect` 的清理路径冲突。
 */
import type {
  AdapterAddWorkspaceOptions,
  AdapterAddWorkspaceOutcome,
  AdapterAddWorkspaceRuntime,
  AdapterCapability,
  AdapterContext,
  AdapterGeneration,
  AdapterListProjection,
  AdapterMigrationFailure,
  AdapterOpenSession,
  AdapterOpenSessionOutcome,
  AdapterProbe,
  AdapterRuntimeObject,
  AdapterSessionId,
  AdapterSessionList,
  AdapterSessions,
  AdapterStartSession,
  AdapterStartSessionOutcome,
  AdapterSurface,
  AdapterWorkspaceId,
  AdapterWorkspaces,
  ClientAdapter,
  DefineAdapterOptions,
  DshMigration,
} from '../types/adapter'
import { NEW_SESSION_SELECTOR } from '../constants'
import { clickIfPresent } from '../utils/browser'

export type * from '../types/adapter'

/** 官方「添加工作区」按钮：工作区创建能力缺席时的 DOM 退级目标（只有本文件消费）。 */
const ADD_WORKSPACE_SELECTOR = 'button[aria-label="添加工作区"],button[aria-label="Add workspace"]'

/**
 * 桌面壳 composer 补丁的能力标记（与 `src-tauri/src/service/patch/composer.rs` 逐字一致）。
 *
 * 官方 `ConversationRoot` 对「不属于任何工作区的空白会话」把 composer 换成「选择工作区」
 * 触发器；桌面壳补丁放宽该判定并在 `<html>` 上写下这个标记。消费方据此决定「未分组」
 * 入口是否可用——不猜核心版本，也不看补丁文件。
 */
const COMPOSER_CWD_ATTRIBUTE = 'data-dsh-composer-cwd'

/** 适配层告警出口（默认 console.warn；宿主可注入以上报到插件面板）。 */
type AdapterWarn = (message: string, error?: unknown) => void

const defaultWarn: AdapterWarn = (message, error) => {
  if (error === undefined)
    console.warn(message)
  else
    console.warn(message, error)
}

/**
 * 守卫安全的服务读取：`ctx.get(name)` 优先（Cordis 对未声明键的 inject-only 守卫会抛错），
 * 回退属性读取；任何异常都等同于「服务不存在」。
 */
function readService(ctx: unknown, name: string): unknown {
  if (ctx === null || ctx === undefined)
    return undefined
  const kind = typeof ctx
  if (kind !== 'object' && kind !== 'function')
    return undefined
  const runtime = ctx as { get?: (name: string) => unknown } & AdapterRuntimeObject
  try {
    return typeof runtime.get === 'function' ? runtime.get(name) : runtime[name]
  }
  catch {
    return undefined
  }
}

/** 把对象的方法绑定到自身。 */
function bindMembers<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop) {
      const member = Reflect.get(t, prop)
      return typeof member === 'function' ? member.bind(t) : member
    },
  })
}

/**
 * 适配一个官方服务：方法绑定到**原对象**（绝不让 Proxy 充当 `this`）；
 * `list` 投影再包一层并缓存（`sessions.list` 的引用稳定性是 uSES 的前提）。
 */
function adaptService<T extends object>(service: T): T {
  const boundLists = new WeakMap<object, object>()
  return new Proxy(service, {
    get(t, prop) {
      const member = Reflect.get(t, prop)
      if (prop === 'list' && member !== null && typeof member === 'object') {
        const cached = boundLists.get(member)
        if (cached !== undefined)
          return cached
        const bound = bindMembers(member as object)
        boundLists.set(member, bound)
        return bound
      }
      return typeof member === 'function' ? member.bind(t) : member
    },
  })
}

/**
 * 跨版本 thenable 判定。
 *
 * legacy 与 modern 的 `startSession` 都返回 void，但投影实现可能返回 Promise：
 * 只 await 真正的 thenable，避免对同步返回值做无意义等待。
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
    return false
  return typeof (value as PromiseLike<unknown>).then === 'function'
}

/** 从标准面投影里取出输入动作（两代同形：`props.inputActions`）。 */
function readInputActions(projected: unknown): unknown {
  if (projected === null || typeof projected !== 'object')
    return undefined
  const props = (projected as { props?: unknown }).props
  if (props === null || typeof props !== 'object')
    return undefined
  const inputActions = (props as { inputActions?: unknown }).inputActions
  return inputActions === undefined ? undefined : { props: { inputActions } }
}

/**
 * 惰性读取 `uiSession.adapter`。
 *
 * 客户端服务按激活顺序到达：`dsh-tauri-ui` 只声明 `sessions`，会在 `ui-session`
 * （额外等 `remote`，由 `dsh-client-connection` 稍后提供）之前激活，因此**适配层创建期
 * 读到的 `uiSession` 可能缺席**。依赖它的投影一律在调用期重读，不缓存创建期快照。
 */
function uiSessionAdapter(probe: AdapterProbe): AdapterRuntimeObject | undefined {
  return probe.service<AdapterRuntimeObject>('uiSession')?.adapter as AdapterRuntimeObject | undefined
}

/**
 * 核心不暴露 per-session 的 `provideInfo`：官方能力优先，缺失时借已保留会话的 binding 补齐。
 *
 * 落点逐版本漂移：`≤0.1.5-rc.2` 在 `uiSession.adapter.resolve(id)`；`0.1.6-alpha.2` 起
 * `sessions.binding` 只在**被保留**的会话上存在，标准面改由 `uiSession.adapter.bindingSource`
 * 物化，因此这里用 `{ sessionId, binding }` 满足它的 SessionReference 读取路径（binding 未变即有效，
 * 与 `sessions.binding` 的「借出不续期」语义一致）。
 * 补不出也绝不因此让插件失败——这是可选桥，不是必需能力。
 */
function resolveProvideInfo(
  sessions: AdapterRuntimeObject,
  sessionId: string,
  probe: AdapterProbe,
): unknown {
  // 部分桌面运行时即使在 legacy 布局下也提供了完整投影：原生路径优先。
  const native = sessions.provideInfo
  if (typeof native === 'function') {
    try {
      const value = native.call(sessions, sessionId)
      if (value !== undefined)
        return value
    }
    catch {
      // 新建会话正在物化时可能瞬时抛错：继续走下面的兼容投影。
    }
  }

  const bindingFn = sessions.binding
  const binding = typeof bindingFn === 'function' ? bindingFn.call(sessions, sessionId) : undefined
  if (binding === undefined)
    return undefined

  const adapter = uiSessionAdapter(probe)

  // legacy：`uiSession.adapter.resolve(id)` 直接按 id 物化标准面。
  const resolveFn = adapter?.resolve
  if (typeof resolveFn === 'function') {
    try {
      return readInputActions(resolveFn.call(adapter, sessionId))
    }
    catch {
      // binding 可能在新会话物化期间消失：按不可用处理。
      return undefined
    }
  }

  // 0.1.6-alpha.2：`bindingSource` 只接受 SessionReference，用已借出的 binding 调用它。
  const bindingSourceFn = adapter?.bindingSource
  if (typeof bindingSourceFn === 'function') {
    try {
      const source = bindingSourceFn.call(adapter, { sessionId, binding }) as AdapterListProjection | undefined
      return readInputActions(typeof source?.getSnapshot === 'function' ? source.getSnapshot() : undefined)
    }
    catch {
      return undefined
    }
  }

  return undefined
}

/**
 * 布局世代探测——**只用于诊断与日志**，任何分支都不读它。
 *
 * 世代标记是「`uiWorkspace` 这个独立导航服务是否在场」：`≤0.1.2-rc.1` 线把导航与目录选择
 * 放在它上面，`0.1.5-rc.1` 起统一收进 `ctx.workspaces`。注意 `sessions.list` 嵌不嵌套**不是**
 * 世代信号（两代的 `list` 都带 `getSnapshot` / `subscribe`），它只是能力差异，由迁移自己探测。
 */
function detectGeneration(service: AdapterProbe['service']): AdapterGeneration {
  try {
    if (service('uiWorkspace') !== undefined)
      return 'legacy'
    if (service('sessions') !== undefined || service('workspaces') !== undefined)
      return 'modern'
  }
  catch {
    // 半初始化上下文：世代不明，交回能力探测判断。
  }
  return 'unknown'
}

/** 基线迁移：官方服务方法绑定到原对象（所有布局都跑，越早越好）。 */
const SERVICES_AUTO_BIND_MIGRATION: DshMigration = {
  id: 'services:auto-bind',
  description: '官方 sessions / workspaces 服务方法自动绑定 this',
  detect: () => true,
  apply(surface) {
    if (surface.sessions !== undefined)
      surface.sessions = adaptService(surface.sessions)
    if (surface.workspaces !== undefined)
      surface.workspaces = adaptService(surface.workspaces)
  },
}

/**
 * 把列表投影补到 `sessions` 顶层（老写法读 `ctx.sessions.getSnapshot / subscribe`）。
 *
 * 这是**能力**迁移而非版本迁移：两代核心的投影都挂在 `sessions.list` 上，顶层别名只是让旧式
 * 消费方免改；新版若已在顶层提供同形方法则原样保留。
 */
const SESSIONS_LIST_PROJECTION_MIGRATION: DshMigration = {
  id: 'sessions:list-projection',
  description: 'sessions.list 投影 → sessions.getSnapshot / subscribe 顶层别名',
  detect: (_probe, surface) =>
    surface.sessions?.list !== undefined && typeof surface.sessions.getSnapshot !== 'function',
  apply(surface) {
    const sessions = surface.sessions
    const list = sessions?.list as AdapterListProjection | undefined
    if (sessions === undefined || list === undefined)
      return
    surface.sessions = new Proxy(sessions as object, {
      get(target, prop) {
        if (prop === 'list')
          return list
        if (prop === 'getSnapshot')
          return () => list.getSnapshot()
        if (prop === 'subscribe')
          return (listener: () => void) => list.subscribe(listener)
        const member = Reflect.get(target, prop)
        return typeof member === 'function' ? member.bind(target) : member
      },
    }) as AdapterSessions
  },
}

/**
 * 把列表快照的 `current` 补回 `sessions.list`。
 *
 * `0.1.6-alpha.2` 起核心不再把选中态放进列表快照（改由 `uiSession.adapter.current` 持有），
 * 而桌面消费方（worktree 会话切换、composer 续跑、右键定位…）都按
 * `list.getSnapshot().current` 判断「当前会话」。核心自带 `current` 时原样优先（0.1.5 及更早），
 * 缺席时用 `uiSession.adapter.current` 的 binding key 补齐。
 *
 * 快照按（核心快照引用，current）缓存：uSES 的 `getSnapshot` 必须引用稳定，否则会无限重渲染。
 * `current` 源按调用期解析（见 {@link uiSessionAdapter}）：`ui-session` 可能晚于本适配层创建，
 * 订阅侧因此在每次列表发布时重挂，源一出现就接上。
 */
function projectListCurrent(
  list: AdapterListProjection,
  resolveCurrent: () => AdapterListProjection | undefined,
): AdapterListProjection {
  let lastSnapshot: unknown
  let lastCurrent: unknown
  let lastProjected: unknown
  const currentId = (): unknown => {
    const source = resolveCurrent()
    if (source === undefined)
      return undefined
    const value = source.getSnapshot()
    return value !== null && typeof value === 'object' ? (value as { key?: unknown }).key : undefined
  }
  return {
    getSnapshot: () => {
      const snapshot = list.getSnapshot()
      const owned = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { current?: unknown }).current : undefined
      const selected = owned ?? currentId()
      if (snapshot === lastSnapshot && selected === lastCurrent)
        return lastProjected
      lastSnapshot = snapshot
      lastCurrent = selected
      lastProjected = snapshot !== null && typeof snapshot === 'object' ? { ...snapshot, current: selected } : snapshot
      return lastProjected
    },
    subscribe: (listener) => {
      let offCurrent: (() => void) | undefined
      let boundCurrent: AdapterListProjection | undefined
      const followCurrent = (): void => {
        const source = resolveCurrent()
        if (source === boundCurrent)
          return
        offCurrent?.()
        boundCurrent = source
        offCurrent = typeof source?.subscribe === 'function' ? source.subscribe(listener) : undefined
      }
      const offList = list.subscribe(() => {
        followCurrent()
        listener()
      })
      followCurrent()
      return () => {
        offList()
        offCurrent?.()
      }
    },
  }
}

/** 核心列表快照是否自带 `current`（`0.1.5` 及更早自带，`0.1.6-alpha.2` 起交给 `uiSession`）。 */
function ownsCurrent(list: AdapterListProjection): boolean {
  const snapshot = list.getSnapshot()
  return snapshot !== null && typeof snapshot === 'object' && 'current' in snapshot
}

const SESSIONS_CURRENT_PROJECTION_MIGRATION: DshMigration = {
  id: 'sessions:current-projection',
  description: 'uiSession.adapter.current → sessions.list 快照的 current 投影',
  detect: (_probe, surface) => {
    const list = surface.sessions?.list
    return list !== undefined && !ownsCurrent(list)
  },
  apply(surface, probe) {
    const sessions = surface.sessions
    const list = sessions?.list as AdapterListProjection | undefined
    if (sessions === undefined || list === undefined)
      return
    const projected = projectListCurrent(list, () => currentSourceOf(probe))
    surface.sessions = new Proxy(sessions as object, {
      get(target, prop) {
        if (prop === 'list')
          return projected
        if (prop === 'getSnapshot')
          return () => projected.getSnapshot()
        if (prop === 'subscribe')
          return (listener: () => void) => projected.subscribe(listener)
        const member = Reflect.get(target, prop)
        return typeof member === 'function' ? member.bind(target) : member
      },
    }) as AdapterSessions
  },
}

/** `uiSession.adapter.current` 投影源；缺席（服务未到达或核心不自带该源）时返回 undefined。 */
function currentSourceOf(probe: AdapterProbe): AdapterListProjection | undefined {
  const current = uiSessionAdapter(probe)?.current as AdapterListProjection | undefined
  return current !== undefined && typeof current.getSnapshot === 'function' ? current : undefined
}

/**
 * 核心不暴露 per-session 的 `provideInfo`：用 `sessions.binding(id)` +
 * `uiSession.adapter`（legacy 的 `resolve`，0.1.6 起的 `bindingSource`）补齐
 * （消费方如 worktree 依赖它取 inputActions）。
 *
 * 探测只认 `binding`：`uiSession` 由投影在调用期解析，因此晚到达的 `ui-session` 不再让桥缺席；
 * 会话未被保留（`binding` 缺席）时仍诚实回报 undefined。原生 `provideInfo` 在场也照样装桥：
 * 它可能只覆盖部分会话，`resolveProvideInfo` 会原生优先、缺失时回退投影。
 */
const SESSIONS_PROVIDE_INFO_MIGRATION: DshMigration = {
  id: 'sessions:provide-info-bridge',
  description: 'sessions.binding + uiSession.adapter.resolve|bindingSource → sessions.provideInfo 兼容桥',
  detect: (_probe, surface) => typeof surface.sessions?.binding === 'function',
  apply(surface, probe) {
    const sessions = surface.sessions
    if (sessions === undefined)
      return
    surface.sessions = new Proxy(sessions as object, {
      get(target, prop) {
        if (prop === 'provideInfo')
          return (sessionId: string) => resolveProvideInfo(target as AdapterRuntimeObject, sessionId, probe)
        const member = Reflect.get(target, prop)
        return typeof member === 'function' ? member.bind(target) : member
      },
    }) as AdapterSessions
  },
}

/**
 * 按能力读取一个候选服务上的 `startSession`，返回**绑定到 owner** 的调用器。
 *
 * `uiWorkspace` 可能晚于适配层创建（见 {@link SESSIONS_OPEN_MIGRATION}），因此调用期重读。
 */
function startSessionAt(owner: AdapterRuntimeObject | undefined): AdapterStartSession | undefined {
  if (owner === undefined)
    return undefined
  const fn = owner.startSession
  if (typeof fn !== 'function')
    return undefined
  return (workspaceId?: AdapterWorkspaceId) => fn.call(owner, workspaceId)
}

/** 跨布局解析「新建会话」的官方入口（`uiWorkspace` 优先，`workspaces` 兜底，调用期解析）。 */
function resolveStartSessionCapability(surface: AdapterSurface): AdapterStartSession | undefined {
  return startSessionAt(surface.uiWorkspace) ?? startSessionAt(surface.workspaces)
}

/** 迁移写入的 `surface.startSession` 优先；缺席时调用期重解析（晚到达的服务也能接上）。 */
function surfaceStartSession(surface: AdapterSurface): AdapterStartSession | undefined {
  return surface.startSession ?? resolveStartSessionCapability(surface)
}

/**
 * legacy：`workspaces` 自身没有导航方法，由独立的 `uiWorkspace` 服务提供。
 *
 * 投影**无条件安装**、候选能力在调用期按需解析：`uiWorkspace` 可能晚于适配层创建，
 * 拿「创建期该服务是否在场」当安装判据会让 `workspaces.connectWorkspace` / `startSession`
 * 永久缺席（issue #756）。两个候选都没有该能力时返回 undefined，不静默吞掉消费方的调用。
 */
const LEGACY_WORKSPACES_MIGRATION: DshMigration = {
  id: 'legacy:workspaces-navigation',
  description: 'uiWorkspace.startSession / connectWorkspace → workspaces 导航投影（调用期解析）',
  detect: () => true,
  apply(surface) {
    const workspaces = surface.workspaces
    if (workspaces === undefined)
      return
    surface.workspaces = new Proxy(workspaces as object, {
      get(target, prop) {
        if (prop === 'startSession' || prop === 'connectWorkspace') {
          if (surface.uiWorkspace?.[prop] === undefined && typeof Reflect.get(target, prop) !== 'function')
            return undefined
          return (...args: unknown[]) => {
            const owner = surface.uiWorkspace
            const fn = owner?.[prop]
            if (typeof fn === 'function')
              return fn.call(owner, ...args)
            const fallback = Reflect.get(target, prop)
            return typeof fallback === 'function' ? fallback.call(target, ...args) : fallback
          }
        }
        const member = Reflect.get(target, prop)
        return typeof member === 'function' ? member.bind(target) : member
      },
    }) as AdapterWorkspaces
  },
}

/** 跨布局：把「新建会话」收敛成 `surface.startSession`（`uiWorkspace` 优先，`workspaces` 兜底）。 */
const NAVIGATION_MIGRATION: DshMigration = {
  id: 'navigation:resolve-start-session',
  description: 'uiWorkspace.startSession ?? workspaces.startSession → surface.startSession',
  detect: () => true,
  apply(surface) {
    // 逐个候选服务找「真的实现了 startSession」的那一个：只按服务在场判断会让
    // 半迁移宿主（uiWorkspace 只提供 pickDirectory）静默吞掉 workspaces 的原生导航。
    // 创建期一个都没有时保持缺席（不落投影），由 surfaceStartSession 在调用期接上晚到的服务，
    // 否则能力探测与退级阶梯（点官方按钮 → 明确回报不可用）会把「尚未物化」误判成「已支持」。
    if (resolveStartSessionCapability(surface) === undefined)
      return
    surface.startSession = (workspaceId?: AdapterWorkspaceId) => {
      const start = resolveStartSessionCapability(surface)
      if (start === undefined)
        throw new Error('startSession is unavailable: no uiWorkspace.startSession / workspaces.startSession capability')
      return start(workspaceId)
    }
  },
}

/**
 * `sessions.open` 兼容桥登记表（`surface` → 桥函数）。
 *
 * 桥带着 `open` 方法，`surface.sessions.open` 在桥缺席时会读回桥自身；能力探测与桥内部解析
 * 都要按函数身份把它排除，否则 `has('navigation.openSession')` 会永久自证为 true、
 * 桥也会递归调用自己。用 WeakMap 而不是给 `AdapterSurface` 加字段：这是纯诊断用途的
 * 内部登记，不进入公开契约。
 */
const openBridges = new WeakMap<AdapterSurface, unknown>()

/**
 * 解析一个候选落点上的 `open` 能力，返回**绑定到 owner** 的调用器。
 *
 * 调用期 `surface.sessions` 可能已是被投影包装的 Proxy，`open` 由内层桥提供；桥自身带着
 * `open` 方法，因此按函数身份 `exclude` 掉它，避免把桥当成「原生 open」而递归调用。
 */
function openCapabilityAt(owner: AdapterRuntimeObject | undefined, member: string, exclude: unknown): AdapterOpenSession | undefined {
  if (owner === undefined)
    return undefined
  const fn = owner[member]
  if (typeof fn !== 'function' || fn === exclude)
    return undefined
  return (sessionId: AdapterSessionId) => fn.call(owner, sessionId)
}

/** 按能力解析「打开已有会话」的官方入口（调用期解析，见 {@link SESSIONS_OPEN_MIGRATION}）。 */
function resolveOpenCapability(surface: AdapterSurface, exclude?: unknown): AdapterOpenSession | undefined {
  return openCapabilityAt(surface.uiWorkspace, 'openSession', exclude)
    ?? openCapabilityAt(surface.workspaces, 'open', exclude)
    ?? openCapabilityAt(surface.sessions, 'open', exclude)
}

/** 迁移表里解析出的 `surface.openSession` 快照（调用期重解析，见 {@link resolveOpenCapability}）。 */
function surfaceOpenSession(surface: AdapterSurface, exclude?: unknown): AdapterOpenSession | undefined {
  return resolveOpenCapability(surface, exclude) ?? surface.openSession
}

/**
 * `surface.openSession` 快照是否真的是官方能力（不是 `sessions.open` 兼容桥自己）。
 *
 * 桥缺席时 `surface.sessions.open` 读到的就是桥本身，能力探测必须把桥排除掉。
 */
function hasOpenCapability(surface: AdapterSurface): boolean {
  if (resolveOpenCapability(surface, openBridges.get(surface)) !== undefined)
    return true
  const snapshot = surface.openSession
  return snapshot !== undefined && snapshot !== openBridges.get(surface)
}

/** 跨布局：把「打开已有会话」收敛成 `surface.openSession`（解析结果仅作诊断快照）。 */
const NAVIGATION_OPEN_MIGRATION: DshMigration = {
  id: 'navigation:resolve-open-session',
  description: 'uiWorkspace.openSession ?? workspaces.open ?? sessions.open → surface.openSession',
  detect: () => true,
  apply(surface) {
    const resolved = resolveOpenCapability(surface)
    if (resolved !== undefined)
      surface.openSession = resolved
  },
}

/**
 * 把「打开已有会话」补回 `sessions.open`（旧式消费方免改）。
 *
 * `0.1.6-alpha.2` 起核心移除了 `sessions.open`，选中态改由 `uiWorkspace.openSession` 承担；
 * 桌面消费方（worktree 会话切换、桌宠新建会话、右键分叉等）仍按 `sessions.open(id)` 切换。
 *
 * 桥的**安装判据只看核心有没有 `sessions.open`**：`uiWorkspace` 可能晚于适配层创建，
 * 用「创建期是否解析出 openSession」当判据会让桥永久缺席。真正的落点在调用期按能力重解析，
 * 与 `provideInfo` / `current` 两条投影同一条约束。原生 `sessions.open` 在场时不装桥。
 *
 * 候选 owner 一律**读 `target`（内层投影）而不是 `surface.sessions`**：后者在本迁移之后就是
 * 本 Proxy，读回来会把桥自身当成原生能力。
 */
const SESSIONS_OPEN_MIGRATION: DshMigration = {
  id: 'sessions:open-bridge',
  description: 'uiWorkspace.openSession / workspaces.open → sessions.open 兼容桥（调用期解析）',
  detect: (_probe, surface) => typeof surface.sessions?.open !== 'function',
  apply(surface) {
    const sessions = surface.sessions
    if (sessions === undefined)
      return
    const bridge: (sessionId: AdapterSessionId) => unknown = (sessionId) => {
      const open = surfaceOpenSession(surface, bridge)
      // 能力全缺时明确抛错，不静默吞掉消费方的切换请求。
      if (open === undefined)
        throw new Error('sessions.open is unavailable: no uiWorkspace.openSession / workspaces.open / sessions.open capability')
      return open(sessionId)
    }
    openBridges.set(surface, bridge)
    surface.sessions = new Proxy(sessions as object, {
      get(target, prop) {
        if (prop === 'open') {
          // 核心可能在被捕获之后才补上原生 `open`（服务延迟物化）：原生永远优先于兼容桥，
          // 否则桥会永久遮蔽后到的原生能力，消费方拿到的仍是「不可用」。
          const native = Reflect.get(target, prop)
          return typeof native === 'function' ? native.bind(target) : bridge
        }
        const member = Reflect.get(target, prop)
        return typeof member === 'function' ? member.bind(target) : member
      },
    }) as AdapterSessions
  },
}

/**
 * 跨布局：「打开文件夹」三段能力聚合。
 *
 * 目录选择在 legacy 是 `uiWorkspace.pickDirectory`、modern 是 `workspaces.pickDirectory`；
 * 建工作区一直是 `workspaces.create`；开新会话复用「新建会话」解析出的入口。
 * 三段缺一即视为不可用，由消费方退级到点官方按钮。
 *
 * 聚合在**调用期**重算（见 {@link surfaceAddWorkspace}）：`uiWorkspace` 可能晚于适配层创建，
 * 创建期一次探测会让「打开文件夹」在晚到达的宿主上永久不可用。
 */
function addWorkspaceAt(surface: AdapterSurface): AdapterAddWorkspaceRuntime | undefined {
  const workspaces = surface.workspaces
  const create = workspaces?.create
  // 目录选择的宿主服务随版本迁移（详见文件头）：modern 在 workspaces 上，legacy 在 uiWorkspace 上。
  const pickOwner = typeof workspaces?.pickDirectory === 'function' ? workspaces : surface.uiWorkspace
  const pickDirectory = pickOwner?.pickDirectory
  const startSession = surfaceStartSession(surface)
  if (
    typeof pickDirectory !== 'function'
    || typeof create !== 'function'
    || pickOwner === undefined
    || startSession === undefined
  ) {
    return undefined
  }
  return {
    pickDirectory: () => pickDirectory.call(pickOwner) as Promise<string | null | undefined>,
    createWorkspace: input => create.call(workspaces, input),
    startSession: workspaceId => startSession(workspaceId),
  }
}

/** 迁移写入的 `surface.addWorkspace` 优先；缺席时调用期重算（晚到达的服务也能接上）。 */
function surfaceAddWorkspace(surface: AdapterSurface): AdapterAddWorkspaceRuntime | undefined {
  return surface.addWorkspace ?? addWorkspaceAt(surface)
}

const WORKSPACE_ADD_MIGRATION: DshMigration = {
  id: 'workspace:resolve-add-workspace',
  description: 'pickDirectory + workspaces.create + startSession → surface.addWorkspace',
  detect: () => true,
  apply(surface) {
    const runtime = addWorkspaceAt(surface)
    if (runtime !== undefined)
      surface.addWorkspace = runtime
  },
}

/**
 * 内置迁移（按序执行，后一条能看到前一条的投影）：
 * 1. 基线自动绑定 → 2. 会话列表投影别名 → 3. 列表 `current` 投影 → 4. `provideInfo` 兼容桥 →
 * 5. legacy 工作区导航投影 → 6. 跨布局导航解析 → 7. 跨布局「打开会话」解析 →
 * 8. `sessions.open` 兼容桥（安装只看核心有无 `sessions.open`，落点在调用期解析）→
 * 9. 跨布局「打开文件夹」解析。
 * 消费方可用 `defineAdapter(ctx, { migrations })` 追加，追加项在最后执行。
 */
export const DEFAULT_DSH_MIGRATIONS: readonly DshMigration[] = [
  SERVICES_AUTO_BIND_MIGRATION,
  SESSIONS_LIST_PROJECTION_MIGRATION,
  SESSIONS_CURRENT_PROJECTION_MIGRATION,
  SESSIONS_PROVIDE_INFO_MIGRATION,
  LEGACY_WORKSPACES_MIGRATION,
  NAVIGATION_MIGRATION,
  NAVIGATION_OPEN_MIGRATION,
  SESSIONS_OPEN_MIGRATION,
  WORKSPACE_ADD_MIGRATION,
]

/**
 * 迁移后的上下文投影：`sessions` / `workspaces` 换成适配后的服务面，其余成员原样透传；
 * 读取失败按 undefined（不把 Cordis 的 inject 守卫抛给消费方）。
 */
function createAdapterContext(
  ctx: unknown,
  sessions: AdapterSessions,
  workspaces: AdapterWorkspaces,
): AdapterContext {
  const kind = typeof ctx
  const base = (ctx !== null && (kind === 'object' || kind === 'function') ? ctx : {}) as AdapterRuntimeObject
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'sessions')
        return sessions
      if (prop === 'workspaces')
        return workspaces
      try {
        return Reflect.get(target, prop, receiver)
      }
      catch {
        return undefined
      }
    },
  }) as AdapterContext
}

/** 新建会话：官方导航 → 点官方按钮 → 明确回报不可用（绝不静默半工作）。 */
async function runStartSession(
  surface: AdapterSurface,
  workspaceId: AdapterWorkspaceId | undefined,
  warn: AdapterWarn,
): Promise<AdapterStartSessionOutcome> {
  const start = surfaceStartSession(surface)
  if (start !== undefined) {
    const value = start(workspaceId)
    // 异步实现回报解析后的结果（而不是把 pending Promise 当 value 外抛）。
    return { status: 'started', value: isThenable(value) ? await value : value }
  }
  if (clickIfPresent(NEW_SESSION_SELECTOR))
    return { status: 'delegated' }
  const reason = 'no workspace navigation service and no official new-session button'
  warn(`[dsh-adapter] startSession unavailable: ${reason}`)
  return { status: 'unavailable', reason }
}

/**
 * 读官方会话列表投影。
 *
 * 归档是「从列表里消失」而不是某个状态位，所以消费方只能靠 `ids` 判断会话还在不在。
 * 快照形态不合预期时返回 undefined，由调用方按「无法判断」退级，而不是猜一个结论。
 */
function readSessionList(surface: AdapterSurface): AdapterSessionList | undefined {
  const list = surface.sessions?.list
  if (list === undefined)
    return undefined
  const value = list.getSnapshot()
  if (value === null || typeof value !== 'object')
    return undefined
  const record = value as { ids?: unknown, current?: unknown }
  return {
    ids: Array.isArray(record.ids) ? record.ids.filter((id): id is string => typeof id === 'string') : [],
    ...(typeof record.current === 'string' ? { current: record.current } : {}),
    subscribe: listener => list.subscribe(listener),
  }
}

/** 打开已有会话：官方入口在场即打开；会话导航没有 DOM 退级目标，缺席只能明确回报。 */
function runOpenSession(surface: AdapterSurface, sessionId: AdapterSessionId, warn: AdapterWarn): AdapterOpenSessionOutcome {
  const open = surfaceOpenSession(surface, openBridges.get(surface))
  if (open === undefined) {
    const reason = 'no uiWorkspace.openSession / workspaces.open / sessions.open capability'
    warn(`[dsh-adapter] openSession unavailable: ${reason}`)
    return { status: 'unavailable', reason }
  }
  return { status: 'opened', value: open(sessionId) }
}

/** 打开文件夹：官方三段能力全流程 → 点官方按钮 → 明确回报不可用；目录选择器取消是正常结果。 */
async function runAddWorkspace(
  surface: AdapterSurface,
  options: AdapterAddWorkspaceOptions | undefined,
  warn: AdapterWarn,
): Promise<AdapterAddWorkspaceOutcome> {
  const runtime = surfaceAddWorkspace(surface)
  if (runtime === undefined) {
    if (clickIfPresent(ADD_WORKSPACE_SELECTOR))
      return { status: 'delegated' }
    const reason = 'no pickDirectory/create/startSession capability and no official add-workspace button'
    warn(`[dsh-adapter] addWorkspace unavailable: ${reason}`)
    return { status: 'unavailable', reason }
  }

  const path = await runtime.pickDirectory()
  // 用户在原生目录选择器里取消：正常结果，不是失败。
  if (path === null || path === undefined)
    return { status: 'cancelled' }

  const workspace = await runtime.createWorkspace({ path })
  const openSession = options?.openSession ?? true
  if (openSession) {
    const value = runtime.startSession(workspace.workspaceId)
    if (isThenable(value))
      await value
  }
  return { status: 'created', workspaceId: workspace.workspaceId, path, sessionStarted: openSession }
}

/**
 * 创建 DSH 升级迁移适配实例（`defineRegister` 的第三个参数就由它产生）。
 *
 * 探测与迁移全程不抛错：单条迁移失败只记入 `failures` 并告警，插件装配照常继续——
 * 一条投影失败不该让整个插件不可用，但也不能悄悄吞掉。
 *
 * @param ctx - 客户端上下文（可为 `undefined`：`defineRegister(setup)()` 直接调用时没有 ctx）。
 * @param options - 追加迁移与告警出口。
 * @returns 无状态适配实例（不注册监听，无需 disposer）。
 */
export function defineAdapter(ctx: unknown, options: DefineAdapterOptions = {}): ClientAdapter {
  const warn = options.onWarn ?? defaultWarn
  const service = <T = AdapterRuntimeObject>(name: string): T | undefined =>
    readService(ctx, name) as T | undefined

  const probe: AdapterProbe = { generation: detectGeneration(service), service }
  const surface: AdapterSurface = {
    sessions: service<AdapterSessions>('sessions') ?? {},
    workspaces: service<AdapterWorkspaces>('workspaces') ?? {},
    // 取值为 live：`dsh-client-ui-workspace` 额外等 `ui-session` / `connection`，可能晚于本适配层
    // 激活；缓存创建期快照会让依赖它的「打开会话」能力永久缺席（见 {@link SESSIONS_OPEN_MIGRATION}）。
    get uiWorkspace() {
      return service<AdapterRuntimeObject>('uiWorkspace')
    },
    // 取值为 live：`ui-session` 晚于本适配层激活，缓存创建期快照会让依赖它的迁移永久缺席。
    get uiSession() {
      return service<AdapterRuntimeObject>('uiSession')
    },
  }

  const migrations: string[] = []
  const failures: AdapterMigrationFailure[] = []
  for (const migration of [...DEFAULT_DSH_MIGRATIONS, ...(options.migrations ?? [])]) {
    try {
      if (!migration.detect(probe, surface))
        continue
      migration.apply(surface, probe)
      migrations.push(migration.id)
    }
    catch (error) {
      failures.push({ migration: migration.id, error })
      warn(`[dsh-adapter] migration "${migration.id}" failed; projection kept as-is`, error)
    }
  }

  const sessions = surface.sessions ?? {}
  const workspaces = surface.workspaces ?? {}

  // 用 Record 而非 switch 表达穷尽性：新增能力时编译期就会报缺少检查项。
  const capabilityChecks: Record<AdapterCapability, () => boolean> = {
    'sessions.list': () => typeof sessions.list?.getSnapshot === 'function',
    'sessions.provideInfo': () => typeof sessions.provideInfo === 'function',
    'sessions.create': () => typeof sessions.create === 'function',
    'sessions.refresh': () => typeof sessions.refresh === 'function',
    'sessions.refreshProjections': () => typeof sessions.refreshProjections === 'function',
    'workspaces.list': () => typeof workspaces.list?.getSnapshot === 'function',
    'workspaces.create': () => typeof workspaces.create === 'function',
    'navigation.startSession': () => surfaceStartSession(surface) !== undefined,
    'navigation.openSession': () => hasOpenCapability(surface),
    'navigation.addWorkspace': () => surfaceAddWorkspace(surface) !== undefined,
    'composer.workspace-less': () =>
      typeof document !== 'undefined'
      && document.documentElement.getAttribute(COMPOSER_CWD_ATTRIBUTE) === '1',
    'dom.newSession': () => typeof document !== 'undefined' && document.querySelector(NEW_SESSION_SELECTOR) !== null,
    'dom.addWorkspace': () => typeof document !== 'undefined' && document.querySelector(ADD_WORKSPACE_SELECTOR) !== null,
  }

  return {
    generation: probe.generation,
    migrations,
    failures,
    ctx: createAdapterContext(ctx, sessions, workspaces),
    sessions,
    workspaces,
    service,
    has: capability => capabilityChecks[capability](),
    resolveStartSession: () => surfaceStartSession(surface),
    resolveOpenSession: () => surfaceOpenSession(surface, openBridges.get(surface)),
    sessionList: () => readSessionList(surface),
    resolveAddWorkspace: () => surfaceAddWorkspace(surface),
    startSession: workspaceId => runStartSession(surface, workspaceId, warn),
    openSession: sessionId => runOpenSession(surface, sessionId, warn),
    addWorkspace: callOptions => runAddWorkspace(surface, callOptions, warn),
  }
}
