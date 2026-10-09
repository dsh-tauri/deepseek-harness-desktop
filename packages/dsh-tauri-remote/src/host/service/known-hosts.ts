import type { MachineId } from '../types/index'
import type { HostKeyVerdict } from './known-hosts.types'
import { defineService } from 'dsh-tauri'
import { knownHostsFilePath } from '../config/runtime'
import { readHostKeyRecords, writeHostKeyRecords } from './known-hosts.utils'

export const knownHosts = defineService({
  async verify(machineId: MachineId, fingerprint: string): Promise<HostKeyVerdict> {
    const records = await readHostKeyRecords(knownHostsFilePath())
    const record = records.find(entry => entry.machineId === machineId)
    if (record === undefined)
      return 'unknown'
    return record.fingerprint === fingerprint ? 'accepted' : 'mismatch'
  },

  async accept(machineId: MachineId, fingerprint: string): Promise<void> {
    const records = await readHostKeyRecords(knownHostsFilePath())
    const others = records.filter(entry => entry.machineId !== machineId)
    await writeHostKeyRecords(knownHostsFilePath(), [...others, { machineId, fingerprint }])
  },

  async forget(machineId: MachineId): Promise<void> {
    const records = await readHostKeyRecords(knownHostsFilePath())
    const next = records.filter(entry => entry.machineId !== machineId)
    if (next.length === records.length)
      return
    await writeHostKeyRecords(knownHostsFilePath(), next)
  },
})
