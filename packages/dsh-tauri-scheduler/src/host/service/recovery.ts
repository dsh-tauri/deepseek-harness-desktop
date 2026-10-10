import { defineService } from 'dsh-tauri'
import { withTaskQueue } from '../config/runtime'
import { history } from './history'

export const recovery = defineService({
  async recover(): Promise<void> {
    await withTaskQueue(() => history.recoverRuns())
  },
})
