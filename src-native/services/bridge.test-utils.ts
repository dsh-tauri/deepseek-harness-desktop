import { vi } from 'vitest'

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

export interface DeferredRequest {
  url: string
  signal: AbortSignal
  resolve: (response: Response) => void
}

export function deferredNetwork() {
  const requests: DeferredRequest[] = []
  let inFlight = 0
  let peak = 0
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const signal = init?.signal
    if (!signal)
      throw new Error('Expected an abort signal at the network boundary')
    const result = deferred<Response>()
    inFlight++
    peak = Math.max(peak, inFlight)
    let settled = false
    function settle() {
      if (settled)
        return false
      settled = true
      inFlight--
      signal!.removeEventListener('abort', abort)
      return true
    }
    function abort() {
      if (settle())
        result.reject(new DOMException('The operation was aborted.', 'AbortError'))
    }
    function resolve(response: Response) {
      if (settle())
        result.resolve(response)
    }
    requests.push({ url: String(input), signal, resolve })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted)
      abort()
    return result.promise
  })
  vi.stubGlobal('fetch', fetchMock)
  function active() {
    return inFlight
  }
  function maximum() {
    return peak
  }
  return { fetchMock, requests, active, maximum }
}
