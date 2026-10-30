export { PLUGIN_ID } from '../../shared/constants'

export const MOBILE_POINTER_QUERIES = ['(pointer: coarse)', '(any-pointer: coarse)'] as const

export const MOBILE_BREAKPOINT = 1024

export const MOBILE_MEDIA_QUERIES = [
  ...MOBILE_POINTER_QUERIES,
  `(max-width: ${MOBILE_BREAKPOINT - 1}px)`,
] as const

export const NEW_SESSION_SELECTOR = 'button[aria-label="新建会话"],button[aria-label="New session"]'
