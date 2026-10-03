import type { BridgeAddress } from '@/utils/bridge-protocol'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { defineStore } from 'valtio-define'
import { persist } from 'valtio-define/plugins/persist'
import { CONNECTION_STORAGE_KEY, HISTORY_LIMIT, RECENT_LIMIT } from '@/config/constants'
import { i18n } from '@/i18n'
import { isRecord, parseQrPayload } from '@/utils/bridge-protocol'

export type ConnectionStage = 'scanning' | 'idle' | 'connected'
export type HostHealth = 'checking' | 'available' | 'unavailable'

export interface HistoryEntry extends Omit<BridgeAddress, 'token'> {
  lastConnectedAt: number
}

export interface NotificationFocus {
  origin: string
  sessionId: string
  title: string
  tag: string
}

export interface ConnectionSnapshot {
  version: 1
  history: HistoryEntry[]
  guidedHosts: string[]
}

export interface ConnectionState {
  version: 1
  hydrated: boolean
  stage: ConnectionStage
  current: BridgeAddress | null
  history: HistoryEntry[]
  tokens: Record<string, string>
  health: Record<string, HostHealth>
  guidedHosts: string[]
  drawerOpen: boolean
  swipeHintVisible: boolean
  loading: boolean
  loadError: string | null
  notice: string | null
  scanGeneration: number
  viewGeneration: number
  pendingFocus: NotificationFocus | null
  focusGeneration: number
}

/** 持久化字段：插件按此顺序把 state 写成 `{version, history, guidedHosts}`。 */
const PERSISTED_PATHS = ['version', 'history', 'guidedHosts'] as const

export function parseConnectionSnapshot(value: unknown): ConnectionSnapshot {
  const snapshot: ConnectionSnapshot = { version: 1, history: [], guidedHosts: [] }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.history))
    return snapshot
  const entries = new Map<string, HistoryEntry>()
  for (const entry of value.history) {
    if (!isRecord(entry) || typeof entry.url !== 'string' || typeof entry.lastConnectedAt !== 'number')
      continue
    if (!Number.isFinite(entry.lastConnectedAt) || entry.lastConnectedAt < 0)
      continue
    const address = parseQrPayload(entry.url)
    if (!address)
      continue
    const previous = entries.get(address.id)
    if (!previous || entry.lastConnectedAt > previous.lastConnectedAt)
      entries.set(address.id, { id: address.id, url: address.url, host: address.host, port: address.port, lastConnectedAt: entry.lastConnectedAt })
  }
  snapshot.history = [...entries.values()].sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
  snapshot.history = snapshot.history.slice(0, HISTORY_LIMIT)
  const guidedHosts = value.guidedHosts
  if (Array.isArray(guidedHosts))
    snapshot.guidedHosts = snapshot.history.filter(entry => guidedHosts.includes(entry.id)).map(entry => entry.id)
  return snapshot
}

/**
 * valtio-define persist 插件的 AsyncStorage 适配器。
 * 插件自己负责 `JSON.stringify`，这里只做两侧归一化，保证磁盘负载与旧版自定义实现逐字节一致：
 * `{"version":1,"history":[...],"guidedHosts":[...]}`（永远不含令牌）。
 * 读写异常必须在这里吞掉并转成 notice —— 插件不会 await `setItem`，抛出去就是 unhandled rejection。
 *
 * 插件在每个 state 变更（含 `setDrawerOpen`/`setNotice`/`setHealth` 等瞬时 UI 状态）后都会调用 `setItem`，
 * 因此这里额外做**负载去重**：`persistedPayload` 记录最近一次已知落盘内容（`getItem` 读到即记录），
 * 负载不变直接返回。这样「持久化字段没变就不写盘」这条旧自定义实现的不变式得以保留，
 * 避免抽屉开合/轮询健康状态时产生大量重复写入。`setItem` 只统计最近一次成功写入。
 */
let persistedPayload: string | null = null

const connectionStorage = {
  async getItem(key: string): Promise<ConnectionSnapshot | null> {
    try {
      const serialized = await AsyncStorage.getItem(key)
      if (!serialized)
        return null
      const snapshot = parseConnectionSnapshot(JSON.parse(serialized))
      persistedPayload = JSON.stringify(snapshot)
      return snapshot
    }
    catch (error) {
      console.error('[connection] restore failed:', error)
      reportStorageFailure()
      return null
    }
  },
  async setItem(key: string, value: unknown): Promise<void> {
    try {
      const snapshot = parseConnectionSnapshot(typeof value === 'string' ? JSON.parse(value) : value)
      const serialized = JSON.stringify(snapshot)
      if (serialized === persistedPayload)
        return
      await AsyncStorage.setItem(key, serialized)
      persistedPayload = serialized
    }
    catch (error) {
      console.error('[connection] save failed:', error)
      reportStorageFailure()
    }
  },
}

/**
 * keep:test 清空负载去重缓存。测试在用例之间复位，才能让「首次写入 / 重复写入」可复现；
 * 生产代码不得调用（运行期缓存只由真实读写更新）。
 */
export function resetConnectionStorageCache(): void {
  persistedPayload = null
}

/**
 * 单例 store 的初始状态工厂。
 * `defineStore` 初始化与测试复位（`connection.$patch(createConnectionState())`）共用同一份定义，
 * 避免旧 `createConnectionStore()` 工厂被移除后测试各写一份初始态而漂移。
 */
export function createConnectionState(): ConnectionState {
  return {
    version: 1,
    hydrated: false,
    stage: 'idle',
    current: null,
    history: [],
    tokens: {},
    health: {},
    guidedHosts: [],
    drawerOpen: false,
    swipeHintVisible: false,
    loading: false,
    loadError: null,
    notice: null,
    scanGeneration: 0,
    viewGeneration: 0,
    pendingFocus: null,
    focusGeneration: 0,
  }
}

export const connection = defineStore({
  state: createConnectionState,
  getters: {
    recentFive(): HistoryEntry[] {
      return this.history.slice(0, RECENT_LIMIT)
    },
  },
  actions: {
    /** 由 `restoreConnections()` 在持久化快照与 SecureStore 令牌都落地后调用。 */
    markHydrated(tokens: Record<string, string>) {
      if (this.hydrated)
        return
      this.tokens = tokens
      this.hydrated = true
    },
    beginScan(): number {
      this.scanGeneration++
      this.viewGeneration++
      this.current = null
      this.stage = 'scanning'
      this.loading = false
      this.loadError = null
      this.notice = null
      this.drawerOpen = false
      this.swipeHintVisible = false
      return this.scanGeneration
    },
    cancelScan() {
      this.scanGeneration++
      if (this.stage === 'scanning')
        this.stage = 'idle'
    },
    finishScan(generation: number, notice: string) {
      if (generation !== this.scanGeneration || this.stage !== 'scanning')
        return
      this.stage = 'idle'
      this.notice = notice
    },
    accept(address: BridgeAddress, generation?: number): boolean {
      if (generation !== undefined && generation !== this.scanGeneration)
        return false
      const normalized = parseQrPayload(address.url)
      if (!normalized)
        return false
      const token = address.token ?? normalized.token ?? this.tokens[normalized.id]
      if (token) {
        normalized.token = token
        this.tokens[normalized.id] = token
      }
      this.scanGeneration++
      this.current = normalized
      this.stage = 'connected'
      this.loading = true
      this.loadError = null
      this.notice = null
      this.drawerOpen = false
      this.swipeHintVisible = false
      this.health[normalized.id] = 'available'
      this.viewGeneration++
      return true
    },
    markLoaded(generation: number, at = Date.now()) {
      if (!this.current || generation !== this.viewGeneration || this.loadError || !this.loading)
        return
      this.loading = false
      const { id, url, host, port } = this.current
      this.history = [{ id, url, host, port, lastConnectedAt: at }, ...this.history.filter(entry => entry.id !== id)].slice(0, HISTORY_LIMIT)
      const retained = new Set(this.history.map(entry => entry.id))
      this.guidedHosts = this.guidedHosts.filter(origin => retained.has(origin))
      this.swipeHintVisible = !this.guidedHosts.includes(id)
      this.health[id] = 'available'
    },
    markLoadFailed(generation: number, message: string) {
      if (!this.current || generation !== this.viewGeneration)
        return
      this.loading = false
      this.loadError = message
      this.swipeHintVisible = false
      this.health[this.current.id] = 'unavailable'
    },
    dismissHint() {
      if (!this.swipeHintVisible)
        return
      if (this.current && !this.guidedHosts.includes(this.current.id))
        this.guidedHosts.push(this.current.id)
      this.swipeHintVisible = false
    },
    setDrawerOpen(open: boolean) {
      this.drawerOpen = open
    },
    setHealth(id: string, health: HostHealth) {
      this.health[id] = health
    },
    setNotice(notice: string | null) {
      this.notice = notice
    },
    queueFocus(focus: NotificationFocus | null) {
      this.pendingFocus = focus
      this.focusGeneration++
    },
    disconnect() {
      this.scanGeneration++
      this.viewGeneration++
      this.current = null
      this.stage = 'scanning'
      this.loading = false
      this.loadError = null
      this.notice = null
      this.drawerOpen = false
      this.swipeHintVisible = false
      this.pendingFocus = null
    },
    /** 当前应当落盘的快照（含归一化），磁盘格式与旧版实现一致。 */
    serialize(): ConnectionSnapshot {
      return parseConnectionSnapshot({
        version: this.version,
        history: this.history.map(({ id, url, host, port, lastConnectedAt }) => ({ id, url, host, port, lastConnectedAt })),
        guidedHosts: [...this.guidedHosts],
      })
    },
  },
  persist: {
    key: CONNECTION_STORAGE_KEY,
    storage: connectionStorage,
    paths: [...PERSISTED_PATHS],
  },
})

// 手动水合：令牌只能进 SecureStore，所以先把快照读回来，再由 restoreConnections() 补令牌并 markHydrated。
connection.use(persist({ hydrate: false }))

// 读写失败时用 store 的 notice 提示用户；定义在 connection 之后以满足 ts/no-use-before-define
// （函数声明会被提升，connectionStorage 在运行期调用它时 connection 已初始化）。
// 只在 notice 变化时写入，避免「写盘失败 → notice 变更 → 再次写盘失败」的循环。
function reportStorageFailure() {
  const message = i18n.t('connection.storageFailed')
  if (connection.notice !== message)
    connection.setNotice(message)
}
