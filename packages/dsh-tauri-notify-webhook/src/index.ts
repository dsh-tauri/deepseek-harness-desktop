import { PLUGIN_ID } from './shared/constants'

export const name = PLUGIN_ID

/** 宿主服务依赖：`webServer`（注册路由）与 `connection`（路由鉴权闸门，注册期必需）。 */
export const inject = ['webServer', 'connection']

export { apply } from './host/apply'
