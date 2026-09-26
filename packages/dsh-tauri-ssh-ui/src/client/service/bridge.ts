/**
 * The desktop-bridge face (C-BRIDGE, S5 owns the shell commands): probing
 * whether this page sits inside the desktop's iframe invoke bridge, and
 * asking the shell to open (or focus) a machine's remote window. Both rides
 * go through `invoke` (the dsh-tauri/client bridge) — a timeout or rejection
 * on the ping means pure web, where the popup affordance simply never shows.
 * @module dsh-tauri-ssh-ui/client/service/bridge
 */

import type { RemoteBridge } from '../types/index'
import { invoke } from 'dsh-tauri/client'
import { REMOTE_BRIDGE_PING_COMMAND, REMOTE_OPEN_WINDOW_COMMAND } from '../constants/index'

/** The real desktop bridge: Tauri commands over the iframe postMessage relay. */
export const desktopBridge: RemoteBridge = {
  probe: () => invoke(REMOTE_BRIDGE_PING_COMMAND),
  openWindow: (machineId, url) => invoke(REMOTE_OPEN_WINDOW_COMMAND, { machineId, url }),
}
