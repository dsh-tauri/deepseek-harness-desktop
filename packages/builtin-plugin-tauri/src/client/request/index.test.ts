import type { Server } from 'node:http'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetch } from '.'

let server: Server
let base: string

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      if (req.url === '/ok') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      }
      else if (req.url === '/bad') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'boom' }))
      }
      else if (req.url === '/oops') {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('oops')
      }
      else if (req.url?.startsWith('/status/')) {
        const status = Number(req.url.slice('/status/'.length))
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `failure-${status}` }))
      }
      else if (req.url === '/echo' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ got: body }))
      }
      else {
        res.writeHead(404)
        res.end()
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('no test server address')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

describe('dsh-tauri fetch', () => {
  it('decodes JSON success bodies via parseResponse', async () => {
    await expect(fetch(`${base}/ok`)).resolves.toEqual({ ok: true })
  })

  it('normalizes non-2xx bodies into readable errors (error field first)', async () => {
    await expect(fetch(`${base}/bad`)).rejects.toThrow('请求失败 (400): boom')
  })

  it('falls back to status text when the body carries no error field', async () => {
    await expect(fetch(`${base}/oops`)).rejects.toThrow('请求失败 (500): oops')
  })

  it.each([401, 403, 404, 500])('retains HTTP status %s without changing readable errors', async (status) => {
    await expect(fetch(`${base}/status/${status}`)).rejects.toMatchObject({
      status,
      message: `请求失败 (${status}): failure-${status}`,
    })
  })

  it('does not invent an HTTP status for errors without a response', async () => {
    const reason = new Error('offline 404')
    await expect(fetch(`${base}/ok`, { onRequest: () => {
      throw reason
    } })).rejects.toBe(reason)
    expect(reason).not.toHaveProperty('status')
  })

  it('posts JSON objects with content-type handled by ofetch', async () => {
    const result = await fetch<{ got: string }>(`${base}/echo`, { method: 'POST', body: { a: 1 } })
    expect(JSON.parse(result.got)).toEqual({ a: 1 })
  })
})
