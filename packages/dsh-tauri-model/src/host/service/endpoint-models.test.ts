import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { server } from '../server'
import { endpointModels } from './endpoint-models'

const disposers: Array<() => void> = []

function disposeServers(): void {
  for (const dispose of disposers.splice(0))
    dispose()
}

interface ListingHit {
  url: string
  headers: Map<string, string[]>
}

const servers: ReturnType<typeof createServer>[] = []

function headerMap(raw: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (let at = 0; at + 1 < raw.length; at += 2) {
    const name = String(raw[at]).toLowerCase()
    const values = map.get(name) ?? []
    values.push(String(raw[at + 1]))
    map.set(name, values)
  }
  return map
}

async function listingEndpoint(): Promise<{ baseURL: string, hits: ListingHit[] }> {
  const hits: ListingHit[] = []
  const server = createServer((request, response) => {
    hits.push({ url: request.url ?? '', headers: headerMap(request.rawHeaders) })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'lab-639-model', name: 'Lab 639 Model' }] }))
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  return { baseURL: `http://127.0.0.1:${port}/v1`, hits }
}

function bindHost(baseURL: string, apiKeyEnv?: string): void {
  const section = { providers: { lab: { baseURL, ...apiKeyEnv === undefined ? {} : { apiKeyEnv } } } }
  disposers.push(server({
    get: (name: string) => name === 'settings'
      ? { get: () => section }
      : { resolve: async () => ({ value: 'sk-lab-639' }) },
    webServer: { register: () => () => {} },
  } as never))
}

describe('endpointModels.list', () => {
  afterEach(async () => {
    disposeServers()
    const closing = servers.splice(0).map(server => new Promise<void>((resolve) => {
      server.close(() => resolve())
    }))
    await Promise.all(closing)
  })

  it('lets the harness own accept and authorization when the caller spells them differently', async () => {
    const endpoint = await listingEndpoint()
    bindHost(endpoint.baseURL, 'LAB_API_KEY')
    const result = await endpointModels.list({
      ns: 'llm-pi-ai',
      profilePath: '["providers","lab"]',
      headers: JSON.stringify({ 'ACCEPT': 'text/plain', 'Authorization': 'Bearer USER-EVIL', 'x-lab-token': 'lab-639' }),
    })
    expect(result.ok).toBe(true)
    expect(result.ok && result.models).toEqual([{ id: 'lab-639-model', name: 'Lab 639 Model' }])
    const hit = endpoint.hits[0]
    expect(hit?.url).toBe('/v1/models')
    expect(hit?.headers.get('accept')).toEqual(['application/json'])
    expect(hit?.headers.get('authorization')).toEqual(['Bearer sk-lab-639'])
    expect(hit?.headers.get('x-lab-token')).toEqual(['lab-639'])
  })

  it('keeps a caller supplied authorization when the profile names no credential', async () => {
    const endpoint = await listingEndpoint()
    bindHost(endpoint.baseURL)
    const result = await endpointModels.list({
      ns: 'llm-pi-ai',
      profilePath: '["providers","lab"]',
      headers: JSON.stringify({ authorization: 'Bearer USER-ONLY' }),
    })
    expect(result.ok).toBe(true)
    expect(endpoint.hits[0]?.headers.get('authorization')).toEqual(['Bearer USER-ONLY'])
  })
})
