import type { PresetTablePayload } from './model-presets.types'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_ID } from '../../shared/constants'
import { PRESET_CATALOG_VERSION } from '../../shared/model-presets'

const fixture = vi.hoisted(() => ({
  piAiUnavailable: false,
  models: {} as Record<string, Record<string, unknown>[]>,
}))

vi.mock('dsh-tauri', () => ({ defineService: <T>(value: T): T => value }))

vi.mock('@earendil-works/pi-ai/providers/all', () => ({
  getBuiltinProviders: (): string[] => {
    if (fixture.piAiUnavailable)
      throw new Error('pi-ai catalog unavailable')
    return Object.keys(fixture.models)
  },
  getBuiltinModels: (provider: string): Record<string, unknown>[] => fixture.models[provider] ?? [],
}))

vi.mock('@earendil-works/pi-ai/models', () => ({
  getSupportedThinkingLevels: (model: { reasoning?: boolean }): string[] => (model.reasoning === true ? ['low', 'medium', 'high'] : ['off']),
}))

const LITELLM_PAYLOAD = {
  'gemini-3.8-flash': {
    mode: 'chat',
    supports_vision: true,
    supports_reasoning: true,
    max_input_tokens: 2000000,
    max_output_tokens: 100000,
  },
  'vendor-embedded-model': {
    mode: 'chat',
    supports_vision: false,
    supports_reasoning: true,
    max_input_tokens: 131072,
    max_output_tokens: 16384,
  },
}

let scratch: string

function cacheFile(): string {
  return join(scratch, PLUGIN_ID, 'model-presets.json')
}

async function loadService(): Promise<typeof import('./model-presets').modelPresets> {
  vi.resetModules()
  const module = await import('./model-presets')
  return module.modelPresets
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-model-presets-'))
  process.env.DSH_HOME = scratch
  fixture.piAiUnavailable = false
  fixture.models = {
    google: [
      {
        provider: 'google',
        id: 'gemini-3.8-flash',
        api: 'google-generative-ai',
        input: ['text'],
        reasoning: false,
        contextWindow: 1048576,
        maxTokens: 65536,
      },
    ],
  }
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(scratch, { recursive: true, force: true })
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('modelPresets.resolve sources', () => {
  it('falls back to litellm when the pi-ai catalog throws', async () => {
    fixture.piAiUnavailable = true
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(LITELLM_PAYLOAD), { status: 200 })))
    const modelPresets = await loadService()

    const result = await modelPresets.resolve()

    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    expect(result.source).toBe('litellm')
    expect(result.presets['gemini-3.8-flash']).toMatchObject({ contextWindow: 2000000, maxTokens: 100000 })
  })

  it('keeps the pi-ai row for a shared key and unions the litellm facts into it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(LITELLM_PAYLOAD), { status: 200 })))
    const modelPresets = await loadService()

    const result = await modelPresets.resolve()

    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    expect(result.source).toBe('merged')
    expect(result.presets['gemini-3.8-flash']).toMatchObject({
      provider: 'google',
      api: 'google-generative-ai',
      input: ['text', 'image'],
      reasoning: true,
      contextWindow: 2000000,
      maxTokens: 100000,
    })
    expect(result.presets['vendor-embedded-model']).toMatchObject({ reasoning: true, contextWindow: 131072 })
  })

  it('unions the rows of a bare id shared by two providers', async () => {
    fixture.models = {
      google: [{ provider: 'google', id: 'shared-name', api: 'google-generative-ai', input: ['text'], reasoning: false, contextWindow: 32000 }],
      other: [{ provider: 'other', id: 'shared-name', api: 'other-api', input: ['text', 'image'], reasoning: true, maxTokens: 4096 }],
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })))
    const modelPresets = await loadService()

    const result = await modelPresets.resolve()

    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    expect(result.presets['shared-name']).toMatchObject({
      provider: 'google',
      input: ['text', 'image'],
      reasoning: true,
      contextWindow: 32000,
      maxTokens: 4096,
    })
  })

  it('serves the stale disk cache when every source is unreachable', async () => {
    fixture.piAiUnavailable = true
    const stale: PresetTablePayload = {
      version: PRESET_CATALOG_VERSION,
      source: 'litellm',
      fetchedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      presets: { 'cached-model': { contextWindow: 32000, maxTokens: 4096 } },
    }
    mkdirSync(join(scratch, PLUGIN_ID), { recursive: true })
    writeFileSync(cacheFile(), JSON.stringify(stale), 'utf8')
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down')
    }))
    const modelPresets = await loadService()

    const result = await modelPresets.resolve()

    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    expect(result.stale).toBe(true)
    expect(result.source).toBe('litellm')
    expect(result.presets['cached-model']).toMatchObject({ contextWindow: 32000 })
  })
})

describe('modelPresets.resolve caching', () => {
  it('reuses the fetched table for the next call', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(LITELLM_PAYLOAD), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const modelPresets = await loadService()

    await modelPresets.resolve()
    const second = await modelPresets.resolve()

    expect(second.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps reporting a served disk snapshot as stale', async () => {
    fixture.piAiUnavailable = true
    const stale: PresetTablePayload = {
      version: PRESET_CATALOG_VERSION,
      source: 'litellm',
      fetchedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      presets: { 'cached-model': { contextWindow: 32000 } },
    }
    mkdirSync(join(scratch, PLUGIN_ID), { recursive: true })
    writeFileSync(cacheFile(), JSON.stringify(stale), 'utf8')
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down')
    }))
    const modelPresets = await loadService()

    const first = await modelPresets.resolve()
    const second = await modelPresets.resolve()

    expect(first.ok && first.stale).toBe(true)
    expect(second.ok && second.stale).toBe(true)
  })

  it('retries the download once the failure cooldown expires', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') })
    const fetchMock = vi.fn(async () => {
      throw new Error('network down')
    })
    vi.stubGlobal('fetch', fetchMock)
    const modelPresets = await loadService()

    await modelPresets.resolve()
    await modelPresets.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-01-01T00:02:00Z'))
    await modelPresets.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
