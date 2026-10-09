import { PLUGIN_ID } from './shared/constants'

export const name = PLUGIN_ID

export const inject = ['webServer', 'skills', 'connection']

export { apply, loadFilesystemSkillPlugin, packagedSkillsDir } from './host/apply'
export type { Config } from './host/apply'
export { providerHooks } from './host/events'
export type { ProviderLifecycleHooks } from './host/events'
export { server } from './host/server'
export type { ExtensionRouteDeps } from './host/server/routes/index.types'
