import type { PresetTable } from '../../../shared/model-presets'
import { defineStore } from 'dsh-tauri/client'

export const modelPresets = defineStore({
  state: () => ({ table: {} as PresetTable }),
  actions: {
    setTable(next: PresetTable) {
      this.table = next
    },
  },
})
