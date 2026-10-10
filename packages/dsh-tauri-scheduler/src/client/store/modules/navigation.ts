import type { TaskTabNavigation } from '../../types/task-tab'
import { defineStore } from 'dsh-tauri/client'

export const navigation = defineStore({
  state: () => ({
    target: null as TaskTabNavigation | null,
    seq: 0,
    error: '',
  }),
  actions: {
    request(target: TaskTabNavigation) {
      this.target = target
      this.error = ''
      this.seq += 1
    },
    finish(seq: number, error = '') {
      if (seq !== this.seq)
        return
      this.target = null
      this.error = error
    },
    dismiss() {
      this.error = ''
    },
  },
})
