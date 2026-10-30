import type { MutableRefObject } from 'react'

export interface Waiter {
  mountedRef: MutableRefObject<boolean>
  wait: (ms: number) => Promise<void>
}
