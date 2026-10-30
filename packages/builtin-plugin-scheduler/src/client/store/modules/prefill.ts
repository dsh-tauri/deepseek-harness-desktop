import { defineStore } from 'dsh-tauri/client'

interface PrefillState {
  pending: string
}

export const prefill = defineStore({
  state: (): PrefillState => ({ pending: '' }),
  actions: {
    set(text: string) {
      this.pending = text
    },
    clear() {
      this.pending = ''
    },
  },
})
