import { PLUGIN_ID } from './shared/constants'

export const name = PLUGIN_ID
export const inject = ['webServer', 'connection', 'llm', 'agents', 'sessions', 'sessionProjections', 'workspaceRegistry', 'agentPresets', 'loader', 'approval', 'userQuestions']
export { apply } from './host/apply'
export type { Config } from './host/config/options'
