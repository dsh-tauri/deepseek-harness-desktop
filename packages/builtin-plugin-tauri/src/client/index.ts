import { PLUGIN_ID } from './constants'

export { apply } from './apply'

export * from './controller'

export * from './hooks/use-invoke'
export * from './hooks/use-listen'

export * from './locale'

export * from './modules/css-render'
export * from './modules/date-fns'
export * from './modules/hookable'
export * from './modules/lodash-es'
export * from './modules/reause'
export * from './modules/tailwind-variants'
export * from './modules/valtio-define'

export * from './panel'
export * from './register'
export * from './request'

export * from './service/tauri'

export type * from './types/adapter'
export type * from './types/harness'

export * from './utils/device'

export const name = PLUGIN_ID

export const inject = ['layout', 'theme']
