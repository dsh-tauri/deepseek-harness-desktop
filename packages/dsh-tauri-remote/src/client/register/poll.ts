import type { MachineLifecycleState } from '../types/index'
import { defineRegister } from 'dsh-tauri/client'
import { poll } from '../service/machines'
import { store } from '../store/index'

const MACHINES_POLL_INTERVAL_MS = 1500
const ACTIVE_STATES: readonly MachineLifecycleState[] = ['connecting', 'reconnecting', 'testing']

function machinesInFlight(): boolean {
  if (Object.keys(store.machines.busy).length > 0)
    return true
  return Object.values(store.machines.statuses).some(status => ACTIVE_STATES.includes(status.state))
}

export const pollFeature = defineRegister((controller) => {
  controller.interval(() => {
    if (controller.isDisposed() || !(machinesInFlight() || store.sync.applying))
      return
    void poll()
  }, MACHINES_POLL_INTERVAL_MS)
})
