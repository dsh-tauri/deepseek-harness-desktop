import { PLUGIN_ID } from './shared/constants'

export const name = PLUGIN_ID

/** 宿主服务依赖：`connection`（注入载体标记时覆写它的两道桌面鉴权闸门）。 */
export const inject = ['connection']

export { apply } from './host/apply'
export * from './host/config/constants'
export * from './host/service'
export * from './host/service/request'
export * from './host/types/harness'
export * from './host/utils/atomic'
export * from './host/utils/driver'
export * from './host/utils/open'
export * from './host/utils/spawn'
export * from './host/utils/url'
