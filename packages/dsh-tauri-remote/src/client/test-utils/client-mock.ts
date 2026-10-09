import type { FetchOptions } from '../../../../dsh-tauri/src/client/request/index.ts'
import { useListenParent } from '../../../../dsh-tauri/src/client/hooks/use-listen-parent.ts'
import { defineLocale } from '../../../../dsh-tauri/src/client/locale/index.ts'
import { uniq } from '../../../../dsh-tauri/src/client/modules/lodash-es.ts'
import { cn } from '../../../../dsh-tauri/src/client/modules/tailwind-variants.ts'
import { defineStore, useStore } from '../../../../dsh-tauri/src/client/modules/valtio-define.ts'
import { defineRegister } from '../../../../dsh-tauri/src/client/register/index.ts'
import { defaultErrorMessage, parseJsonResponse } from '../../../../dsh-tauri/src/client/request/index.utils.ts'
import { invoke } from '../../../../dsh-tauri/src/client/service/invoke.ts'
import { listenParent } from '../../../../dsh-tauri/src/client/service/listen-parent.ts'

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

export const clientMock = {
  cn,
  defineLocale,
  defineRegister,
  defineStore,
  invoke,
  listenParent,
  ofetch,
  uniq,
  useListenParent,
  useStore,
}
