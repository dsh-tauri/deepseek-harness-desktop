import { PLUGIN_ID } from './shared/constants'

export const name = PLUGIN_ID

export const inject = ['webServer', 'sessions', 'workspaceRegistry', 'connection']

export { apply } from './host/apply'

export { archiveHooks } from './host/events'
export type { ArchiveLifecycleHooks } from './host/events'
