import { PLUGIN_ID } from './shared/constants'

export const name = PLUGIN_ID

/** 宿主服务依赖：web（Fake-IP fetch provider）、connection（桌面鉴权闸门）。 */
export const inject = ['web', 'connection']

export { apply } from './host/apply'
export * from './host/config/constants'
export { defineHostRuntime } from './host/config/runtime'

export type { HostRuntime } from './host/config/runtime'
export * from './host/modules/h3'
export * from './host/routes'

export type {
  HttpMethod,
  RouteDefinition,
  RouteDisposer,
  RouteHandler,
  RouteKind,
  RouteMethod,
  RoutesContext,
  RoutesRegistration,
  RoutesSetup,
} from './host/routes/index.type'
export * from './host/service'
export * from './host/types/harness'
export * from './host/utils/atomic'
export * from './host/utils/driver'
export * from './host/utils/open'
export * from './host/utils/spawn'
export * from './host/utils/url'
