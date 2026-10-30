import { PLUGIN_ID } from './shared/constants'

export const name = PLUGIN_ID

export const inject = ['webServer', 'connection']

export { apply } from './host/apply'
