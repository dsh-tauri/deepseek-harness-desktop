import { PLUGIN_ID } from './shared/constants'

export const name = PLUGIN_ID

export const inject = ['connection', 'webServer', 'workspaceRegistry']

export { apply } from './host/apply'
export * from './host/config/constants'
export * from './host/service'
export { watchArchive } from './host/service/archive'
export * from './host/service/request'
export * from './host/types/harness'
export * from './host/utils/atomic'
export * from './host/utils/driver'
export * from './host/utils/open'
export * from './host/utils/paths'
export * from './host/utils/spawn'
export * from './host/utils/url'
