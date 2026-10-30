import type { FetchOptions } from '../../../../builtin-plugin-tauri/src/client/request/index.ts'
import type { EventCallback, UnlistenFn } from '../../../../builtin-plugin-tauri/src/client/service/tauri.ts'
import { useEffect, useRef } from 'react'
import { defineLocale } from '../../../../builtin-plugin-tauri/src/client/locale/index.ts'
import { uniq } from '../../../../builtin-plugin-tauri/src/client/modules/lodash-es.ts'
import { cn } from '../../../../builtin-plugin-tauri/src/client/modules/tailwind-variants.ts'
import { defineStore, useStore } from '../../../../builtin-plugin-tauri/src/client/modules/valtio-define.ts'
import { defineRegister } from '../../../../builtin-plugin-tauri/src/client/register/index.ts'
import { defaultErrorMessage, parseJsonResponse } from '../../../../builtin-plugin-tauri/src/client/request/index.utils.ts'

export interface WireCall {
  url: string
  http: string
  body: Record<string, unknown>
  params: Record<string, unknown>
}

export interface WireReply {
  status: number
  body?: unknown
}

export const replies = {
  ok: (value: unknown): WireReply => ({ status: 200, body: value }),
  fail: (message: string, status = 400): WireReply => ({ status, body: { error: message } }),
  http: (status: number): WireReply => ({ status }),
  empty: (): WireReply => ({ status: 200, body: '' }),
}

const listeners = new Map<string, Set<EventCallback<never>>>()

export const sent: WireCall[] = []

export const wire: { reply: (call: WireCall) => WireReply | Promise<WireReply> } = {
  reply: (_call: WireCall): WireReply => replies.ok({}),
}

export function answer(reply: (call: WireCall) => WireReply | Promise<WireReply>): void {
  wire.reply = reply
}

export function resetWire(): void {
  wire.reply = () => replies.ok({})
  sent.length = 0
  listeners.clear()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function ofetch(path: string, options: FetchOptions = {}): Promise<unknown> {
  const call: WireCall = {
    url: `${options.baseURL ?? ''}${path}`,
    http: String(options.method ?? 'get').toUpperCase(),
    body: isRecord(options.body) ? options.body : {},
    params: isRecord(options.params) ? options.params : {},
  }
  sent.push(call)
  return Promise.resolve().then(() => wire.reply(call)).then((reply) => {
    if (reply.status < 200 || reply.status >= 300)
      throw new Error(defaultErrorMessage(reply.status, reply.body))
    return typeof reply.body === 'string' ? parseJsonResponse(reply.body) : reply.body
  })
}

export function emitTauriEvent(event: string, payload: unknown): void {
  for (const handler of listeners.get(event) ?? [])
    (handler as EventCallback<unknown>)({ event, id: 0, payload })
}

function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const bucket = listeners.get(event) ?? new Set()
  bucket.add(handler as EventCallback<never>)
  listeners.set(event, bucket)
  return Promise.resolve(() => bucket.delete(handler as EventCallback<never>))
}

function useListen<T>(event: string, handler: EventCallback<T>): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    let disposed = false
    void listen<T>(event, e => handlerRef.current(e)).then((fn) => {
      if (disposed)
        fn()
      else
        unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [event])
}

function invoke(command: string): Promise<never> {
  return Promise.reject(new Error(`NODE_NOT_ANSWERED: invoke ${command} timed out`))
}

export const clientMock = {
  cn,
  defineLocale,
  defineRegister,
  defineStore,
  invoke,
  listen,
  ofetch,
  uniq,
  useListen,
  useStore,
}
