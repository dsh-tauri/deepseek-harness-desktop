export type MobileSettingsView = 'menu' | 'detail'

export interface MobileSettingsSnapshot {
  ready: boolean
  view: MobileSettingsView
  title: string
}

export interface MobileSettingsPresentation {
  getSnapshot: () => MobileSettingsSnapshot
  subscribe: (listener: () => void) => () => void
  back: () => void
}
