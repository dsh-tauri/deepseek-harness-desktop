import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { server } from '.'
import { ARCHIVE_STREAM_PATH } from '../../shared/constants'

interface Harness {
  registered: Map<string, WebRoute>
  archive: (ids: string[]) => void
  listenerCount: () => number
}

function createHarness(): Harness {
  const registered = new Map<string, WebRoute>()
  let archived: string[] = []
  const listeners = new Set<() => void>()
  const ctx = {
    webServer: {
      register(route: WebRoute): () => void {
        const key = `${route.kind}\0${route.path}`
        registered.set(key, route)
        return () => {
          registered.delete(key)
        }
      },
    },
    logger: { error: () => {}, info: () => {} },
    get workspaceRegistry() {
      return { archivedSessionIds: archived }
    },
    on: (event: string, listener: () => void) => {
      expect(event).toBe('domain/changed')
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as Context
  server(ctx)
  return {
    registered,
    archive(ids) {
      archived = ids
      for (const listener of listeners)
        listener()
    },
    listenerCount: () => listeners.size,
  }
}

const servers: ReturnType<typeof createServer>[] = []

async function listen(registered: Map<string, WebRoute>): Promise<string> {
  const instance = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const route = registered.get(`exact\0${pathname}`)
    if (!route) {
      response.writeHead(404)
      response.end()
      return
    }
    Promise.resolve(route.handler(request, response)).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500)
        response.end()
      }
    })
  })
  servers.push(instance)
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(instance.address() as AddressInfo).port}`
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, match: (text: string) => boolean): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done)
      throw new Error(`stream ended before match: ${text}`)
    text += decoder.decode(value, { stream: true })
    if (match(text))
      return text
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(instance => new Promise<void>(resolve => instance.close(() => resolve()))))
})

describe('归档推送流', () => {
  it('按归档集合声明 GET 路由', () => {
    const harness = createHarness()
    expect([...harness.registered.keys()]).toEqual([`exact\0${ARCHIVE_STREAM_PATH}`])
  })

  it('接入即给当前快照，随后只在集合变化时推新帧', async () => {
    const harness = createHarness()
    harness.archive(['old'])
    const base = await listen(harness.registered)

    const response = await fetch(`${base}${ARCHIVE_STREAM_PATH}`)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()

    let text = await readUntil(reader, chunk => chunk.includes('{"archivedSessionIds":["old"]}'))
    expect(text).toContain(': keepalive')

    harness.archive(['old', 'target'])
    text = await readUntil(reader, chunk => chunk.includes('{"archivedSessionIds":["old","target"]}'))

    harness.archive(['old', 'target'])
    expect(text).not.toContain('["old","target","target"]')

    await reader.cancel()
    for (let attempt = 0; attempt < 50 && harness.listenerCount() !== 0; attempt += 1)
      await new Promise(resolve => setTimeout(resolve, 20))
    expect(harness.listenerCount()).toBe(0)
  })
})
