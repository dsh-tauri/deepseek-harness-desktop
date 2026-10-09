import type { MachineRow, SecretValues } from '../types/index'

export interface PersistMachinesInput {
  machines: MachineRow[]
  secrets: Record<string, SecretValues>
}
