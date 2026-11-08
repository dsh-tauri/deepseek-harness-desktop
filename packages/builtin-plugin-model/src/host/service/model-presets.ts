import type { PiAiBuiltinModel } from '@earendil-works/pi-ai/providers/all'
import type { ModelCapabilityPreset, PresetRow, PresetSource, PresetTable } from '../../shared/model-presets'
import type { PresetResolveResult, PresetTablePayload } from './model-presets.types'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defineService } from 'dsh-tauri'
import { buildPresetTable, PRESET_CACHE_TTL_MS, PRESET_CATALOG_VERSION, PRESET_REASONING_EFFORTS, PRESET_SOURCE_URL } from '../../shared/model-presets'
import { resolvePresetCachePath } from '../utils/paths'

export const modelPresets = defineService({
  async resolve(force = false): Promise<PresetResolveResult> {
    const builtin = await piAiPresets()
    const live = await litellmPresets(force)
    const presets = mergeTables(builtin.table, live.table)
    if (Object.keys(presets).length === 0)
      return { ok: false, error: live.error ?? builtin.error ?? 'no model capability source answered' }
    return {
      ok: true,
      version: PRESET_CATALOG_VERSION,
      source: sourceOf(builtin.table, live.table),
      fetchedAt: live.fetchedAt ?? new Date().toISOString(),
      stale: live.stale,
      presets,
    }
  },
})

// --- internal ---

const FETCH_TIMEOUT_MS = 20_000

const RETRY_COOLDOWN_MS = 60_000

const EXTENDED_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

type PiAiModel = PiAiBuiltinModel

interface PiAiModule {
  getBuiltinProviders: () => string[]
  getBuiltinModels: (provider: string) => PiAiModel[]
  getSupportedThinkingLevels?: (model: PiAiModel) => string[]
}

interface PresetSourceState {
  table?: PresetTable
  error?: string
}

interface LiveState extends PresetSourceState {
  fetchedAt?: string
  stale: boolean
}

interface CachedLive {
  payload: PresetTablePayload
  stale: boolean
}

let piAiCached: PresetSourceState | undefined
let litellmCached: CachedLive | undefined
let litellmFailure: { at: number, error: string } | undefined

async function piAiPresets(): Promise<PresetSourceState> {
  if (piAiCached !== undefined)
    return piAiCached
  const module = await resolvePiAiModule()
  if (module === undefined) {
    piAiCached = { error: 'could not resolve pi-ai builtin models' }
    return piAiCached
  }
  try {
    const table = buildTableFromPiAi(module)
    piAiCached = Object.keys(table).length === 0 ? { error: 'pi-ai builtin catalog carried no models' } : { table }
  }
  catch (error) {
    piAiCached = { error: `pi-ai builtin catalog failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  return piAiCached
}

function serveCachedLive(cached: CachedLive): LiveState {
  return { table: cached.payload.presets, fetchedAt: cached.payload.fetchedAt, stale: cached.stale }
}

async function litellmPresets(force: boolean): Promise<LiveState> {
  const cached = litellmCached
  if (!force && cached !== undefined && !cached.stale && isFresh(cached.payload.fetchedAt))
    return serveCachedLive(cached)
  if (!force && litellmFailure !== undefined && Date.now() - litellmFailure.at < RETRY_COOLDOWN_MS) {
    if (cached !== undefined)
      return { ...serveCachedLive(cached), error: litellmFailure.error }
    return { stale: false, error: litellmFailure.error }
  }
  const disk = await readDiskPayload()
  if (!force && disk !== undefined && isFresh(disk.fetchedAt)) {
    litellmCached = { payload: disk, stale: false }
    return serveCachedLive(litellmCached)
  }
  try {
    const presets = await download()
    const payload: PresetTablePayload = { version: PRESET_CATALOG_VERSION, source: 'litellm', fetchedAt: new Date().toISOString(), presets }
    litellmCached = { payload, stale: false }
    litellmFailure = undefined
    await writeDiskPayload(payload)
    return serveCachedLive(litellmCached)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    litellmFailure = { at: Date.now(), error: message }
    if (disk !== undefined) {
      litellmCached = { payload: disk, stale: true }
      return { ...serveCachedLive(litellmCached), error: message }
    }
    return { stale: false, error: message }
  }
}

async function resolvePiAiModule(): Promise<PiAiModule | undefined> {
  try {
    const all = await import('@earendil-works/pi-ai/providers/all')
    let getSupportedThinkingLevels: ((model: PiAiModel) => string[]) | undefined
    try {
      const models = await import('@earendil-works/pi-ai/models')
      getSupportedThinkingLevels = models.getSupportedThinkingLevels
    }
    catch {
    }
    return {
      getBuiltinProviders: all.getBuiltinProviders,
      getBuiltinModels: all.getBuiltinModels,
      getSupportedThinkingLevels,
    }
  }
  catch {
    return undefined
  }
}

function getLevels(model: PiAiModel, helper?: (model: PiAiModel) => string[]): string[] {
  if (helper !== undefined)
    return helper(model)
  if (!model.reasoning)
    return ['off']
  return EXTENDED_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null)
      return false
    if (level === 'xhigh' || level === 'max')
      return mapped !== undefined
    return true
  })
}

function normalizeEfforts(model: PiAiModel, helper?: (model: PiAiModel) => string[]): Record<string, string | null> | false {
  if (model.reasoning !== true)
    return false
  const levels = getLevels(model, helper)
  const efforts: Record<string, string | null> = {}
  for (const level of levels) {
    if (level === 'off')
      efforts.off = model.thinkingLevelMap?.off ?? null
    else
      efforts[level] = model.thinkingLevelMap?.[level] ?? level
  }
  return Object.keys(efforts).length === 0 ? false : efforts
}

function buildTableFromPiAi(piAi: PiAiModule): PresetTable {
  const table: PresetTable = {}

  for (const provider of piAi.getBuiltinProviders()) {
    for (const model of piAi.getBuiltinModels(provider)) {
      const preset: ModelCapabilityPreset = {
        provider: model.provider ?? provider,
        id: model.id,
        api: model.api,
        input: model.input !== undefined && model.input.length > 0 ? [...model.input] : ['text'],
        reasoning: model.reasoning === true,
        reasoningEfforts: normalizeEfforts(model, piAi.getSupportedThinkingLevels),
        ...model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {},
        ...model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {},
      }
      const rawId = model.id.toLowerCase()
      const withProvider = `${provider.toLowerCase()}/${rawId}`
      table[withProvider] = preset

      const slash = rawId.lastIndexOf('/')
      const bare = slash >= 0 ? rawId.slice(slash + 1) : rawId
      // issue #1363：多家 provider 共用同一 bare id 时按字段 union，不再整条丢弃
      const known = table[bare]
      table[bare] = known === undefined ? preset : unionPreset(known, preset)
    }
  }

  return table
}

function presetFromRow(row: PresetRow): ModelCapabilityPreset {
  const reasoning = row[1] === 1
  return {
    ...row[0] === 1 ? { input: ['text', 'image'] } : {},
    ...reasoning ? { reasoning: true, reasoningEfforts: { ...PRESET_REASONING_EFFORTS } } : {},
    ...row[2] === 0 ? {} : { contextWindow: row[2] },
    ...row[3] === 0 ? {} : { maxTokens: row[3] },
  }
}

async function download(): Promise<PresetTable> {
  const response = await fetch(PRESET_SOURCE_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok)
    throw new Error(`${PRESET_SOURCE_URL} answered ${response.status}`)
  const rows = buildPresetTable(await response.json())
  const presets: PresetTable = {}
  for (const [key, row] of Object.entries(rows))
    presets[key] = presetFromRow(row)
  if (Object.keys(presets).length === 0)
    throw new Error(`${PRESET_SOURCE_URL} carried no chat models`)
  return presets
}

function isPreset(value: unknown): value is ModelCapabilityPreset {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readDiskPayload(): Promise<PresetTablePayload | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(resolvePresetCachePath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null)
      return undefined
    const payload = parsed as Record<string, unknown>
    if (typeof payload.fetchedAt !== 'string' || payload.version !== PRESET_CATALOG_VERSION || !isPreset(payload.presets))
      return undefined
    // issue #1363：0.30.x 的缓存文件存的是四元组行，数组条目一律丢弃后重新拉取
    const presets: PresetTable = {}
    for (const [key, value] of Object.entries(payload.presets as Record<string, unknown>)) {
      if (isPreset(value))
        presets[key] = value
    }
    if (Object.keys(presets).length === 0)
      return undefined
    return { version: PRESET_CATALOG_VERSION, source: 'litellm', fetchedAt: payload.fetchedAt, presets }
  }
  catch {
    return undefined
  }
}

async function writeDiskPayload(payload: PresetTablePayload): Promise<void> {
  try {
    const path = resolvePresetCachePath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(payload), 'utf8')
  }
  catch {
  }
}

function isFresh(fetchedAt: string): boolean {
  const stamp = Date.parse(fetchedAt)
  return Number.isFinite(stamp) && Date.now() - stamp < PRESET_CACHE_TTL_MS
}

function mergeTables(builtin: PresetTable | undefined, live: PresetTable | undefined): PresetTable {
  const table: PresetTable = { ...builtin }
  for (const [key, preset] of Object.entries(live ?? {})) {
    const known = table[key]
    table[key] = known === undefined ? preset : unionPreset(known, preset)
  }
  return table
}

function unionPreset(known: ModelCapabilityPreset, incoming: ModelCapabilityPreset): ModelCapabilityPreset {
  const vision = known.input?.includes('image') === true || incoming.input?.includes('image') === true
  const knownEfforts = known.reasoningEfforts
  const incomingEfforts = incoming.reasoningEfforts
  const efforts = typeof knownEfforts === 'object' && knownEfforts !== null
    ? { ...knownEfforts }
    : typeof incomingEfforts === 'object' && incomingEfforts !== null
      ? { ...incomingEfforts }
      : knownEfforts === false || incomingEfforts === false
        ? false
        : undefined
  const contextWindow = Math.max(known.contextWindow ?? 0, incoming.contextWindow ?? 0)
  const maxTokens = Math.max(known.maxTokens ?? 0, incoming.maxTokens ?? 0)
  return {
    ...known.provider === undefined ? {} : { provider: known.provider },
    ...known.id === undefined ? {} : { id: known.id },
    ...known.api === undefined ? {} : { api: known.api },
    input: vision ? ['text', 'image'] : known.input === undefined ? incoming.input ?? ['text'] : [...known.input],
    reasoning: known.reasoning === true || incoming.reasoning === true,
    ...efforts === undefined ? {} : { reasoningEfforts: efforts },
    ...contextWindow === 0 ? {} : { contextWindow },
    ...maxTokens === 0 ? {} : { maxTokens },
  }
}

function sourceOf(builtin: PresetTable | undefined, live: PresetTable | undefined): PresetSource {
  const hasBuiltin = builtin !== undefined && Object.keys(builtin).length > 0
  const hasLive = live !== undefined && Object.keys(live).length > 0
  if (hasBuiltin && hasLive)
    return 'merged'
  return hasBuiltin ? 'pi-ai' : 'litellm'
}
