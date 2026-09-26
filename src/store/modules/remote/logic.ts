/**
 * 切换器与内容区着色的纯逻辑（无副作用，供 store/组件复用与单测）：
 *
 * - 色点语义（S3 词汇表消费）：机器标识色优先 → 已连接绿 → 重连中/进行中
 *   琥珀 → 放弃/失败红 → 其余中性灰；
 * - 边框着色：活动机器勾选 tintBorder 且有标识色时返回颜色，否则不描边；
 * - 切换 reconcile：把一份最新机器列表折叠进 { activeId, pendingId,
 *   activeTunnelUrl } 三元组——断开/放弃自动回本地、重连窗口粘性保留隧道
 *   URL（端口稳定策略见引擎 preferredTunnelPort）、待切换机器就绪即切换。
 * @module store/remote/logic
 */

import type { SshMachineRow } from './types'

/** 切换器的三个视图状态键（reconcile 的输入与输出同形）。 */
export interface SwitcherTargets {
  activeId: string | null
  pendingId: string | null
  activeTunnelUrl: string
}

/**
 * 色点 class：标识色走内联样式（见 dotStyleOf），这里只给无标识色时的
 * 语义色。进行中（connecting/testing/reconnecting）统一琥珀。
 */
export function dotClassOf(machine: Pick<SshMachineRow, 'color' | 'state'>): string {
  if (machine.color !== undefined)
    return ''
  switch (machine.state) {
    case 'connected':
      return 'bg-success'
    case 'reconnecting':
    case 'connecting':
    case 'testing':
      return 'bg-warning'
    case 'given-up':
      return 'bg-danger'
    default:
      return 'bg-line-strong'
  }
}

/** 色点内联颜色：有标识色时用它（任何状态），否则交给语义 class。 */
export function dotStyleOf(machine: Pick<SshMachineRow, 'color'>): Record<string, string> | undefined {
  return machine.color !== undefined ? { backgroundColor: machine.color } : undefined
}

/** 边框着色：活动机器 + tintBorder + 标识色齐备才描边。 */
export function borderTintOf(machine: SshMachineRow | undefined): string | null {
  if (machine === undefined)
    return null
  if (!machine.tintBorder || machine.color === undefined)
    return null
  return machine.color
}

/**
 * 用最新机器列表推进切换语义（幂等纯函数）。
 *
 * 规则（S5 契约）：
 * - 活动机器行消失 / 被断开（disconnected）/ 放弃（given-up）→ 回本地；
 * - 活动机器重连中（reconnecting 等）→ 保持指向，隧道 URL 粘性保留
 *   （不闪空端口，恢复后按引擎的端口稳定策略续用原 URL）；
 * - 活动机器已连接 → 采用最新 tunnelBaseUrl（重连换端口时换 iframe 键重载）；
 * - 待切换机器就绪 → 升为活动；消失/放弃 → 撤销待切换（留在本地，失败态
 *   由切换器列表呈现）。
 */
export function reconcileSwitcher(
  prev: SwitcherTargets,
  machines: readonly SshMachineRow[],
): SwitcherTargets {
  let { activeId, pendingId, activeTunnelUrl } = prev
  const activeMachine = machines.find(machine => machine.id === activeId)
  if (activeMachine === undefined) {
    // 行消失（被删除或引擎重启清空）：回本地
    activeId = null
    activeTunnelUrl = ''
  }
  else if (activeMachine.state === 'disconnected' || activeMachine.state === 'given-up') {
    // 断开/放弃：回本地（切换器列表里保留失败态与原因）
    activeId = null
    activeTunnelUrl = ''
  }
  else if (activeMachine.state === 'connected' && activeMachine.tunnelBaseUrl !== undefined) {
    // 就绪：采纳最新隧道 URL（重连后端口变化时 iframe 换键重载）
    activeTunnelUrl = activeMachine.tunnelBaseUrl
  }
  // reconnecting/testing/connecting：保持活动与粘性 URL，等待自动恢复

  const pendingMachine = machines.find(machine => machine.id === pendingId)
  if (pendingMachine === undefined || pendingMachine.state === 'given-up') {
    pendingId = null
  }
  else if (pendingMachine.state === 'connected' && pendingMachine.tunnelBaseUrl !== undefined) {
    activeId = pendingMachine.id
    activeTunnelUrl = pendingMachine.tunnelBaseUrl
    pendingId = null
  }

  return { activeId, pendingId, activeTunnelUrl }
}
