import type { SettingsRow } from '../../types/sections'
import type { SettingsSectionsState } from './sections.types'
import { defineStore } from 'dsh-tauri/client'

const NO_ROWS: SettingsRow[] = []

export const sections = defineStore({
  state: (): SettingsSectionsState => ({
    rows: NO_ROWS,
    onboarding: NO_ROWS,
  }),
  actions: {
    setRows(rows: SettingsRow[]) {
      this.rows = rows
    },
    setOnboarding(rows: SettingsRow[]) {
      this.onboarding = rows
    },
  },
})
