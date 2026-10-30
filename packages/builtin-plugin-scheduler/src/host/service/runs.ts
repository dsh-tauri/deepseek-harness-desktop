import type { SchedulerRun, SchedulerTask } from '../types'
import { defineService } from 'dsh-tauri'
import { history } from './history'

export const runs = defineService({
  async list(taskId?: string): Promise<SchedulerRun[]> {
    return history.listRuns(taskId)
  },

  async load(id: string): Promise<SchedulerRun | null> {
    return (await history.listRuns()).find(run => run.id === id) ?? (await history.journals()).find(item => item.id === id)?.run ?? null
  },

  async save(run: SchedulerRun, expected?: SchedulerTask): Promise<void> {
    await history.saveRun(run, expected)
  },

  async remove(id: string): Promise<boolean> {
    return history.remove(id)
  },
})
