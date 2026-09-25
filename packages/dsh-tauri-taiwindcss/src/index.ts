import { PLUGIN_ID } from './shared/constants'

export const name = PLUGIN_ID

/** 纯客户端插件：Tailwind 产物由 client 半区挂载，宿主侧没有行为。 */
export function apply(): void {}
