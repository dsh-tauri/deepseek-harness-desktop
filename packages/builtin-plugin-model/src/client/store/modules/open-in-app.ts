import { defineStore } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../../shared/constants'

export const openInApp = defineStore({
  state: () => ({ choice: '' }),
  persist: { key: `${PLUGIN_ID}.open-in-app.choice` },
  actions: {
    setChoice(id: string) {
      this.choice = id
    },
  },
})
