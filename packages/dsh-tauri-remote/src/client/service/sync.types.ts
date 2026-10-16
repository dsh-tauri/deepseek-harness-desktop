import type { SyncPluginItem, SyncSkillItem } from '../types/index'

export interface SyncApplyInput {
  machineId: string
  plugins: SyncPluginItem[]
  skills: SyncSkillItem[]
}
