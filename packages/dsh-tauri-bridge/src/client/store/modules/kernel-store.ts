import type { BackendDetection, BackendId } from '../../../shared/types'
import { defineStore } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../../shared/constants'

export const kernelStore = defineStore({
  state: () => ({
    selected: 'dsh' as BackendId,
    backends: [] as BackendDetection[],
    phase: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
    error: null as string | null,
  }),
  actions: {
    select(backend: BackendId) {
      this.selected = backend
    },
  },
  persist: { key: `${PLUGIN_ID}:kernel`, paths: ['selected'] },
})
