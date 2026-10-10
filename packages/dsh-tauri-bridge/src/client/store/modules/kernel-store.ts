import type { BackendDetection, BackendId } from '../../../shared/types'
import { defineStore } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../../shared/constants'

export function rememberedKernel(selected: BackendId | undefined): BackendId | undefined {
  return selected === 'dsh' ? undefined : selected
}

export const kernelStore = defineStore({
  state: () => ({
    selected: undefined as BackendId | undefined,
    backends: [] as BackendDetection[],
    phase: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
    error: null as string | null,
  }),
  actions: {
    select(backend?: BackendId) {
      this.selected = backend === 'dsh' ? undefined : backend
    },
  },
  persist: { key: `${PLUGIN_ID}:kernel`, paths: ['selected'] },
})
