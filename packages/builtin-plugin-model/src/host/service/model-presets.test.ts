import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRESET_SOURCE_URL } from '../../shared/model-presets'

const UPSTREAM = {
  'openai/gpt-4o': { mode: 'chat', supports_vision: true, max_input_tokens: 128000 },
  'openai/text-embedding-3-small': { mode: 'embedding', max_input_tokens: 8191 },
}

const CACHE_DIR = 'dsh-tauri-model'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function loadService(): Promise<(typeof import('./model-presets'))['modelPresets']> {
  vi.resetModules()
  return (await import('./model-presets')).modelPresets
}

describe('modelPresets.resolve', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-model-presets-'))
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('downloads once, then serves the next call from memory', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(UPSTREAM))
    vi.stubGlobal('fetch', fetchMock)
    const modelPresets = await loadService()
    const first = await modelPresets.resolve()
    if (!first.ok)
      throw new Error(first.error)
    expect(first.stale).toBe(false)
    expect(first.source).toBe(PRESET_SOURCE_URL)
    expect(first.presets).toEqual({ 'gpt-4o': [1, 0, 128000, 0] })
    const cached = JSON.parse(readFileSync(join(home, CACHE_DIR, 'model-presets.json'), 'utf8'))
    expect(cached.presets).toEqual(first.presets)
    const second = await modelPresets.resolve()
    expect(second.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('serves a fresh disk cache without touching the network', async () => {
    const path = join(home, CACHE_DIR, 'model-presets.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({
      source: 'https://example.test/cost-map.json',
      fetchedAt: new Date().toISOString(),
      presets: { 'gpt-4o': [1, 0, 128000, 0] },
    }))
    const fetchMock = vi.fn(async () => jsonResponse(UPSTREAM))
    vi.stubGlobal('fetch', fetchMock)
    const modelPresets = await loadService()
    const result = await modelPresets.resolve()
    if (!result.ok)
      throw new Error(result.error)
    expect(result.source).toBe('https://example.test/cost-map.json')
    expect(result.presets).toEqual({ 'gpt-4o': [1, 0, 128000, 0] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes an expired cache and ignores the cache when forced', async () => {
    const path = join(home, CACHE_DIR, 'model-presets.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({
      source: 'stale',
      fetchedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      presets: { 'gpt-4o': [0, 0, 1, 0] },
    }))
    const fetchMock = vi.fn(async () => jsonResponse(UPSTREAM))
    vi.stubGlobal('fetch', fetchMock)
    const modelPresets = await loadService()
    const result = await modelPresets.resolve()
    if (!result.ok)
      throw new Error(result.error)
    expect(result.stale).toBe(false)
    expect(result.presets).toEqual({ 'gpt-4o': [1, 0, 128000, 0] })
    await modelPresets.resolve(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to the expired cache when upstream is unreachable', async () => {
    const path = join(home, CACHE_DIR, 'model-presets.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({
      source: 'stale',
      fetchedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      presets: { 'gpt-4o': [0, 0, 1, 0] },
    }))
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    const modelPresets = await loadService()
    const result = await modelPresets.resolve()
    if (!result.ok)
      throw new Error(result.error)
    expect(result.stale).toBe(true)
    expect(result.presets).toEqual({ 'gpt-4o': [0, 0, 1, 0] })
  })

  it('reports the upstream failure when there is nothing cached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 500)))
    const modelPresets = await loadService()
    const result = await modelPresets.resolve()
    expect(result.ok).toBe(false)
    if (result.ok)
      throw new Error('expected a failure')
    expect(result.error).toContain(PRESET_SOURCE_URL)
    expect(result.error).toContain('500')
  })

  it('treats a dataset without chat rows as unusable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ 'bge-m3': { mode: 'embedding', max_input_tokens: 8192 } })))
    const modelPresets = await loadService()
    const result = await modelPresets.resolve()
    expect(result.ok).toBe(false)
  })
})
