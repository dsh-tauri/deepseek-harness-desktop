import type { BackendDetection } from '../../../shared/types'
import { defineStore } from 'dsh-tauri/client'

export const kernelStore = defineStore({
  state: () => ({
    backends: [] as BackendDetection[],
    phase: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
    error: null as string | null,
  }),
})
