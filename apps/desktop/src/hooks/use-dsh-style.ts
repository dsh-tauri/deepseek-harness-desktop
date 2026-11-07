import type { CSSProperties } from 'react'
import { createGlobalState } from '@reause/core'

export const useDshStyle = createGlobalState<{
  frame?: CSSProperties | null
  sidebar?: CSSProperties | null
  colorScheme?: 'dark' | 'light'
}>({})
