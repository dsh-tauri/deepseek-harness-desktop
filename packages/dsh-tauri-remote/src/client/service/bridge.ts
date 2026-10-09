import type { RemoteBridge } from '../types/index'
import { invoke } from 'dsh-tauri/client'
import { REMOTE_BRIDGE_PING_COMMAND, REMOTE_OPEN_WINDOW_COMMAND } from '../constants/index'

export const desktopBridge: RemoteBridge = {
  probe: () => invoke(REMOTE_BRIDGE_PING_COMMAND),
  openWindow: (machineId, url) => invoke(REMOTE_OPEN_WINDOW_COMMAND, { machineId, url }),
}
