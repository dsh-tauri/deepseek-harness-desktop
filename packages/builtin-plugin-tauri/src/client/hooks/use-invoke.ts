import type { InvokeArgs, InvokeOptions } from '../service/tauri'
import { useEffect, useRef, useState } from 'react'
import { invoke } from '../service/tauri'

export interface UseInvokeResult<T> {
  data: T | null
  loading: boolean
  error: string | null
}

export function useInvoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): UseInvokeResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const argsRef = useRef(args)
  const optionsRef = useRef(options)
  argsRef.current = args
  optionsRef.current = options

  const argsKey = args === undefined ? '' : JSON.stringify(args)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    invoke<T>(cmd, argsRef.current, optionsRef.current)
      .then((value) => {
        if (cancelled)
          return
        setData(value)
      })
      .catch((reason: unknown) => {
        if (cancelled)
          return
        const message = reason instanceof Error ? reason.message : String(reason)
        console.error(`[useInvoke] ${cmd} failed:`, reason)
        setError(message)
      })
      .finally(() => {
        if (!cancelled)
          setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [cmd, argsKey])

  return { data, loading, error }
}
