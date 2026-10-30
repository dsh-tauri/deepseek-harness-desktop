import { pet } from './modules/pet'

/** 插件共享状态（模块级单例；插件重载时随 bundle 重建）。 */
export const store = {
  pet,
}
