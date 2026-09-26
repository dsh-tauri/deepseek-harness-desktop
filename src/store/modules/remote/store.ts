/**
 * 远端机器模块（壳层）：机器列表轮询、iframe 切换目标（activeId/粘性隧道
 * URL）与降级态。数据面完全来自本地实例 `/api-ssh`（dsh-tauri-ssh 插件，
 * S1 契约）——壳不自存任何机器，连接/隧道/bootstrap 全部由插件引擎推进。
 *
 * 节奏（KISS，无推送通道）：秒级轮询 + 窗口聚焦触发刷新（监听在组件侧
 * hook 装配）；本地实例不可达时进入降级态（保留列表、静默重试，不弹错误
 * 风暴），恢复后自动复原。插件侧 SSH 开关未启用（或本地实例没有该 API）时
 * 清空远端视图并隐藏壳层切换器，而不是谎报「本地实例不可达」。切换语义
 * （断开回本地、重连粘性、就绪即切）由纯函数 `reconcileSwitcher` 承担
 * （见 logic.ts）。
 * @module store/remote/store
 */

import type { SshApiClient } from './api'
import type { SshMachineRow, SshProgressPhase } from './types'
import { defineStore } from 'valtio-define'
import { harness } from '../harness'
import { createSshApiClient, SshApiHttpError } from './api'
import { reconcileSwitcher } from './logic'

/** 轮询间隔（毫秒）：秒级即可让切换器跟上连接/重连状态流转。 */
const POLL_INTERVAL_MS = 2000

/** machine.events 增量游标（模块级，不属于 UI 状态）。 */
let eventSeq = 0

/** 连接尝试代次：取消/新尝试作废旧 connectAndSwitch 的落定（成功与失败都静默）。 */
let connectEpoch = 0

/** 引擎/网络错误的可读摘要（与 ssh-ui 的 messageOf 同语义）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 模块级轮询句柄（与 harness store 的定时器管理模式一致）。 */
let pollTimer: ReturnType<typeof setInterval> | undefined

/** 数据面客户端：默认走全局 fetch 与 harness 的 serviceUrl（测试可替换）。 */
let api = createSshApiClient(
  (input, init) => fetch(input, init),
  () => harness.$state.serviceUrl,
)

/** 当前数据面客户端（管理面板复用同一实例；测试经 bindSshApiForTests 替换）。 */
export function sshApi(): SshApiClient {
  return api
}

/** 测试注入口：替换数据面客户端并复位切换状态（仅测试使用）。 */
export function bindSshApiForTests(client: Partial<SshApiClient> & Pick<SshApiClient, 'listMachines' | 'connect' | 'disconnect'>): void {
  api = {
    save: async () => {},
    remove: async () => {},
    test: async () => ({ ok: true }),
    events: async () => ({ items: [] }),
    ...client,
  }
}

export const remote = defineStore({
  state: () => ({
    /** 全部机器（手动机器 + ~/.ssh/config 别名，按名排序）。 */
    machines: [] as SshMachineRow[],
    /** SSH 功能是否已启用（插件侧开关）；未启用时壳层不渲染切换器。 */
    enabled: false,
    /** iframe 当前指向的远端机器（null = 本地实例）。 */
    activeId: null as string | null,
    /** 点击未连接机器后待切换的目标（连接就绪后升为 activeId）。 */
    pendingId: null as string | null,
    /** 远端弹窗启动寻址的挂起目标（refresh 成功且机器出现即切换；手动操作撤销） */
    pendingBootMachineId: null as string | null,
    /** 活动机器最近已知的隧道 URL（重连窗口粘性保留，避免指向空端口）。 */
    activeTunnelUrl: '',
    /** `/api-ssh` 是否可达；不可达时切换器降级（禁用远端项 + 提示）。 */
    available: true,
    /** 连接进度弹窗：本次连接实际走过的管线阶段（落定后保留供失败复盘）。 */
    connectTrail: [] as SshProgressPhase[],
    /** 连接进度弹窗：machine.events 实时日志尾（增量轮询追加）。 */
    connectLog: [] as string[],
    /** 连接失败定格：目标机器 + 直接原因（弹窗呈现与重试入口）。 */
    connectFailed: null as { id: string, error: string } | null,
    /** 进行中手动关了弹窗：隐藏到落定；失败时重新弹出（原因必须可见）。 */
    connectDismissed: false,
    /** 单飞标志：上一轮未完成时跳过本轮，避免请求堆积。 */
    refreshing: false,
    booted: false,
  }),
  actions: {
    /** 首次挂载切换器时启动轮询（StrictMode 重复挂载下只执行一次）。 */
    boot() {
      if (this.booted)
        return
      this.booted = true
      void this.refresh()
      pollTimer = setInterval(() => {
        // 窗口隐藏时跳过本轮（平台 WebView 报告可见性才生效；恢复可见由
        // 组件侧 visibilitychange 触发的即时刷新兜底）
        if (typeof document !== 'undefined' && document.hidden)
          return
        void this.refresh()
      }, POLL_INTERVAL_MS)
    },

    /** 拉取机器列表并推进切换语义；不可达时进入降级态（静默，保留列表）。 */
    async refresh() {
      if (this.refreshing)
        return
      this.refreshing = true
      try {
        const { enabled, machines } = await api.listMachines()
        this.available = true
        this.enabled = enabled
        // 未启用：机器列表与远端视图一并清空（连接已由主机侧断开），壳层隐藏
        // 切换器；挂起中的启动寻址保留，启用后随下一轮成功轮询兑现。
        if (!enabled) {
          this.machines = []
          this.activeId = null
          this.activeTunnelUrl = ''
          this.pendingId = null
          return
        }
        const next = reconcileSwitcher(
          { activeId: this.activeId, pendingId: this.pendingId, activeTunnelUrl: this.activeTunnelUrl },
          machines,
        )
        this.machines = machines
        this.activeId = next.activeId
        this.pendingId = next.pendingId
        this.activeTunnelUrl = next.activeTunnelUrl
        // 启动寻址（远端弹窗 remote-<id>）：实例就绪前 refresh 会连续失败，
        // 一次性「拉一轮再切」抢跑必然落空——挂起目标随每次成功轮询推进，
        // 机器一出现即切（已连接直切/未连接发起连接），用户手动操作则撤销
        if (this.pendingBootMachineId !== null
          && this.machines.some(machine => machine.id === this.pendingBootMachineId)) {
          const target = this.pendingBootMachineId
          this.pendingBootMachineId = null
          // 必须等本轮 refresh 收尾再切：switchTo 的连接路径
          // （connectAndSwitch）内部会再 refresh，嵌套调用会被
          // refreshing 重入守卫吞掉导致永不切换
          setTimeout(() => this.switchTo(target), 0)
        }
        await this.trackConnectProgress()
      }
      catch (err) {
        // 本地实例可达但没有 SSH API（插件未加载 / 未启用）：SSH 不可用，
        // 不是「本地实例不可达」——静默隐藏切换器，不弹误导性的降级提示。
        if (err instanceof SshApiHttpError) {
          this.available = true
          this.enabled = false
          this.machines = []
          this.activeId = null
          this.activeTunnelUrl = ''
          this.pendingId = null
        }
        else {
          // 本地实例不可达（启动中/已停止）：降级但保留既有列表，静默重试
          console.warn('[remote] /api-ssh unreachable:', err)
          this.available = false
        }
      }
      finally {
        this.refreshing = false
      }
    },

    /** 连接进行中：累积实际走过的 progress 阶段 + 增量拉取事件日志。 */
    async trackConnectProgress() {
      const id = this.pendingId ?? this.connectFailed?.id
      if (id === undefined || id === null)
        return
      const machine = this.machines.find(item => item.id === id)
      const phase = machine?.progress?.phase
      if (phase !== undefined && this.connectTrail[this.connectTrail.length - 1] !== phase)
        this.connectTrail = [...this.connectTrail, phase]
      try {
        const { items } = await api.events(id, eventSeq)
        for (const item of items) {
          eventSeq = Math.max(eventSeq, item.seq + 1)
          this.connectLog = [...this.connectLog, item.line]
        }
      }
      catch {
        // 事件通道失败不阻断连接进度（列表轮询仍在推进）
      }
    },

    /** 关闭连接进度弹窗：清日志/阶段/失败定格（不影响进行中的连接）。 */
    dismissConnect() {
      this.connectTrail = []
      this.connectLog = []
      this.connectFailed = null
      // 仍在连接中：仅隐藏到落定（失败会重新弹出），成功/失败后自然复位
      if (this.pendingId !== null)
        this.connectDismissed = true
    },

    /**
     * 取消进行中的连接：抬代次（在飞的 connectAndSwitch 落定静默）+ 中止
     * 引擎侧尝试（manager 的 disconnect 会取消在飞 connect）。弹窗随
     * pendingId 清空关闭；无失败定格。
     */
    cancelConnect(machineId: string) {
      if (this.pendingId !== machineId)
        return
      connectEpoch += 1
      this.pendingId = null
      this.dismissConnect()
      this.connectDismissed = false
      void api.disconnect(machineId)
        .catch(err => console.warn('[remote] cancel disconnect failed:', err))
        .finally(() => void this.refresh())
    },

    /**
     * 切换视图：已连接直接切换；进行中（连接/重连）挂起等待；否则发起
     * 连接（阻塞到隧道就绪，见 S1 契约——不会指向空端口）。
     */
    switchTo(machineId: string) {
      this.pendingBootMachineId = null
      if (!this.available)
        return
      const machine = this.machines.find(item => item.id === machineId)
      if (machine === undefined)
        return
      if (machine.state === 'connected' && machine.tunnelBaseUrl !== undefined) {
        this.activeId = machineId
        this.activeTunnelUrl = machine.tunnelBaseUrl
        this.pendingId = null
        return
      }
      if (machine.state === 'connecting' || machine.state === 'testing' || machine.state === 'reconnecting') {
        // 引擎已在推进（用户连接或自动重连）：挂起等待，轮询 reconcile 接管
        if (this.pendingId !== machineId)
          this.beginTracking(machineId)
        return
      }
      // disconnected / given-up：重新连接（given-up 可经再次 connect 退出）
      this.beginTracking(machineId)
      void this.connectAndSwitch(machineId)
    },

    /** 开始跟踪一台机器的连接：复位日志/阶段/游标并挂起。 */
    beginTracking(machineId: string) {
      connectEpoch += 1
      this.pendingId = machineId
      this.connectFailed = null
      this.connectDismissed = false
      this.connectTrail = []
      this.connectLog = []
      eventSeq = 0
    },

    /** 连接一台机器并在就绪后切换；失败定格原因（进度弹窗呈现重试入口）。 */
    async connectAndSwitch(machineId: string) {
      const epoch = connectEpoch
      try {
        const link = await api.connect(machineId)
        // 已被取消或被新尝试取代：静默（不动 activeId/失败定格）
        if (epoch !== connectEpoch)
          return
        await this.refresh()
        const machine = this.machines.find(item => item.id === machineId)
        if (machine !== undefined && machine.state === 'connected') {
          this.activeId = machineId
          this.activeTunnelUrl = machine.tunnelBaseUrl ?? link.tunnelBaseUrl
          this.pendingId = null
          // 成功：弹窗随 pendingId 清空自动关闭，日志/阶段一并复位
          this.dismissConnect()
          this.connectDismissed = false
        }
      }
      catch (err) {
        // 用户取消（或新尝试取代）：引擎报 "cancelled by disconnect"，不定格失败
        if (epoch !== connectEpoch)
          return
        console.warn('[remote] connect failed:', err)
        this.pendingId = null
        this.connectFailed = { id: machineId, error: messageOf(err) }
        // 失败必须可见：进行中手动关过弹窗也重新弹出
        this.connectDismissed = false
        // 拉取引擎落定的失败态（given-up + lastError）供切换器呈现
        void this.refresh()
      }
    },

    /**
     * 远端弹窗启动寻址：窗口 label 为 remote-<machineId> 时由壳层调用——
     * 登记挂起目标并立即触发一轮拉取；机器在任一成功轮询中出现即切
     * （已连接直切；未连接发起连接，进度弹窗照常）。挂在 refresh 成功分支
     * 而非一次性 await：新窗口启动时实例健康检查往往尚未就绪，抢跑的
     * refresh 只会失败落空。幂等：重复调用以最后一次为准。
     */
    openInitialMachine(machineId: string) {
      this.pendingBootMachineId = machineId
      void this.refresh()
    },

    /** 退回本地实例视图（不断开远端连接；同时撤销挂起中的切换）。 */
    backToLocal() {
      this.pendingBootMachineId = null
      this.activeId = null
      this.activeTunnelUrl = ''
      this.pendingId = null
    },

    /** 断开一台机器：活动机器先退回本地视图，再向引擎发断开。 */
    async disconnect(machineId: string) {
      if (this.activeId === machineId)
        this.backToLocal()
      if (this.pendingId === machineId)
        this.pendingId = null
      try {
        await api.disconnect(machineId)
      }
      catch (err) {
        console.warn('[remote] disconnect failed:', err)
      }
      finally {
        void this.refresh()
      }
    },
  },
})

/** 停止轮询并复位（测试收尾用；壳层生命周期内不调用）。 */
export function disposeRemoteForTests(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
  remote.booted = false
  remote.machines = []
  remote.enabled = false
  remote.activeId = null
  remote.pendingId = null
  remote.pendingBootMachineId = null
  remote.activeTunnelUrl = ''
  remote.available = true
  remote.refreshing = false
  remote.connectTrail = []
  remote.connectLog = []
  remote.connectFailed = null
  remote.connectDismissed = false
  eventSeq = 0
  connectEpoch = 0
}
