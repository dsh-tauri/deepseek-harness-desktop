import type { MachineId, MachineProfile } from '../types/index'
import type { RemoteState } from './state.types'
import { defineService } from 'dsh-tauri'
import { machineTable } from '../config/runtime'
import { storage } from '../storage/index'
import { parseStateDocument } from './state.utils'

const DOCUMENT_KEY = 'state'
const STATE_VERSION = 1

export const state = defineService({
  async load(): Promise<RemoteState> {
    const parsed = parseStateDocument(await storage.getItem(DOCUMENT_KEY))
    machineTable.enabled = parsed.enabled
    machineTable.machines = new Map(Object.entries(parsed.machines).map(([key, profile]) => [key as MachineId, profile]))
    return parsed
  },

  async save(profile: MachineProfile): Promise<void> {
    machineTable.machines.set(profile.id, profile)
    await persist()
  },

  async remove(machineId: MachineId): Promise<void> {
    if (!machineTable.machines.delete(machineId))
      return
    await persist()
  },

  async setEnabled(enabled: boolean): Promise<void> {
    if (machineTable.enabled === enabled)
      return
    machineTable.enabled = enabled
    await persist()
  },
})

// --- internal ---

async function persist(): Promise<void> {
  await storage.setItem(DOCUMENT_KEY, {
    version: STATE_VERSION,
    enabled: machineTable.enabled,
    machines: Object.fromEntries(machineTable.machines),
  })
}
