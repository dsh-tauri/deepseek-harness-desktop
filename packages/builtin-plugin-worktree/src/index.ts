import { PLUGIN_ID } from './shared/constants'

export const name = PLUGIN_ID

export const inject = ['systemPrompt', 'webServer', 'sessions', 'workspaceRegistry', 'agents', 'connection']

export { apply } from './host/apply'
