import type { InvokeArgs, InvokeOptions } from '../service/tauri'
import { useAsync } from '@reause/core'
import { useRef } from 'react'
import { invoke } from '../service/tauri'

export interface UseInvokeResult<T> {
  data: T | null
  loading: boolean
  error: string | null
}

export function useInvoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): UseInvokeResult<T> {
  const argsKey = args === undefined ? '' : JSON.stringify(args)
  const requestRef = useRef({ cmd, argsKey })
  if (requestRef.current.cmd !== cmd || requestRef.current.argsKey !== argsKey)
    requestRef.current = { cmd, argsKey }
  const request = requestRef.current
  const state = useAsync(async (onCancel): Promise<{ request: object | null, data: T | null, error: string | null }> => {
    let cancelled = false
    onCancel(() => {
      cancelled = true
    })
    try {
      const data = await invoke<T>(cmd, args, options)
      return { request, data, error: null }
    }
    catch (reason: unknown) {
      if (!cancelled)
        console.error(`[useInvoke] ${cmd} failed:`, reason)
      return { request, data: state.data, error: reason instanceof Error ? reason.message : String(reason) }
    }
  }, { request: null, data: null, error: null }, { deps: [request] })

  const loading = state.request !== request
  return { data: state.data, loading, error: loading ? null : state.error }
}
