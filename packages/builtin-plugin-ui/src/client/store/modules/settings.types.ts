export interface SettingsUiState {
  open: boolean
  activeId: string | undefined
  query: string
  railWidth: number | undefined
  chatContentWidth: string | undefined
  launcherAvailable: boolean
  launcherShortcut: { keys: readonly string[], aria?: string } | undefined
}

export type SettingsUiKey = 'back' | 'search' | 'settings' | 'noResults'
