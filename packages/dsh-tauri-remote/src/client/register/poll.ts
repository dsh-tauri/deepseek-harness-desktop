import type { MachineLifecycleState } from '../types/index'
import { defineRegister } from 'dsh-tauri/client'
import { refresh as refreshAccess } from '../service/access'
import { poll } from '../service/machines'
import { store } from '../store/index'

const MACHINES_POLL_INTERVAL_MS = 1500
const ACTIVE_STATES: readonly MachineLifecycleState[] = ['connecting', 'reconnecting', 'testing']

function machinesInFlight(): boolean {
  if (Object.keys(store.machines.busy).length > 0)
    return true
  return Object.values(store.machines.statuses).some(status => ACTIVE_STATES.includes(status.state))
}

/** 隧道从启动到拿到公网域名之间只有事件在动，面板需要跟着刷新；其余时刻靠操作回包更新。 */
function tunnelStarting(): boolean {
  const snapshot = store.access.snapshot
  return snapshot !== null && !store.access.busy && snapshot.tunnel.state === 'starting'
}

export const pollFeature = defineRegister((controller) => {
  controller.interval(() => {
    if (controller.isDisposed())
      return
    if (tunnelStarting())
      void refreshAccess()
    if (machinesInFlight() || store.sync.applying)
      void poll()
  }, MACHINES_POLL_INTERVAL_MS)
})
