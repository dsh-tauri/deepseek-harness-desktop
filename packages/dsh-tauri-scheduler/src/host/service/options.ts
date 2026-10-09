import type { HostContext, ModelCatalogFailure, ModelOption, PermissionOption, SchedulerOptions } from '../types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { filter, find, head, isArray, isEmpty, isString, map, uniqBy } from 'lodash-es'
import { server } from '../server'

export const options = defineService({
  async resolve(): Promise<SchedulerOptions> {
    const ctx = getServerContext<HostContext>(server)
    const [workspaces, permission, catalog] = await Promise.all([
      collectWorkspaces(ctx),
      Promise.resolve(collectPermissions(ctx)),
      collectModels(ctx),
    ])
    return {
      workspaces,
      permissions: permission.permissions,
      defaultPermission: permission.defaultPermission,
      models: catalog.models,
      failures: catalog.failures,
      defaultModel: catalog.defaultModel,
    }
  },
})

// --- internal ---

interface LlmLike {
  listProviders?: () => readonly { id?: string, provider?: string, name?: string }[]
  listModels?: (provider: string) => Promise<readonly { id?: string, name?: string, description?: string }[]>
  resolveModelInfo?: (provider: string, model: string) => Promise<{
    description?: string
    reasoning?: {
      efforts: readonly { id: string, name: string, description?: string }[]
      defaultEffort?: string
    }
  }>
}

interface WorkspaceRecord {
  id: string
  path?: unknown
  title?: unknown
}

async function collectWorkspaces(ctx: HostContext): Promise<SchedulerOptions['workspaces']> {
  try {
    const registry = ctx.workspaceRegistry
    const records = typeof registry?.list === 'function' ? (await registry.list()) as unknown : []
    if (!isArray(records))
      return []
    const valid = filter(records, (record: unknown): record is WorkspaceRecord =>
      typeof record === 'object' && record !== null && 'id' in record && typeof record.id === 'string')
    return map(valid, record => ({
      id: record.id,
      path: isString(record.path) ? record.path : record.id,
      title: isString(record.title) ? record.title : record.id,
    }))
  }
  catch {
    return []
  }
}

function collectPermissions(ctx: HostContext): { permissions: PermissionOption[], defaultPermission: string } {
  try {
    const presets = (ctx as HostContext & { get?: (name: string) => unknown }).get?.('permissionPresets') as {
      names?: readonly string[]
      defaultPreset?: string
      optionOf?: (name: string) => PermissionOption
    } | undefined
    const names = isArray(presets?.names) ? presets.names : []
    if (isEmpty(names))
      return { permissions: [], defaultPermission: 'read-only' }
    return {
      permissions: map(names, name => presets?.optionOf?.(name) ?? { value: name, name }),
      defaultPermission: isString(presets?.defaultPreset) && !isEmpty(presets.defaultPreset)
        ? presets.defaultPreset
        : (names[0] ?? 'read-only'),
    }
  }
  catch {
    return { permissions: [], defaultPermission: 'read-only' }
  }
}

async function collectModels(ctx: HostContext): Promise<{ models: ModelOption[], failures: ModelCatalogFailure[], defaultModel: ModelOption | null }> {
  try {
    const current = (ctx.get?.('agentDefaultModel') as { currentSelection?: () => unknown } | undefined)?.currentSelection?.() as
      { provider?: unknown, model?: unknown } | undefined
    const llm = ctx.get?.('llm') as LlmLike | undefined
    const found: ModelOption[] = []
    const failures: ModelCatalogFailure[] = []

    for (const item of llm?.listProviders?.() ?? []) {
      const provider = String(item.id ?? item.provider ?? '')
      if (provider === '')
        continue
      const providerLabel = String(item.name ?? provider)
      try {
        for (const model of await llm?.listModels?.(provider) ?? []) {
          const modelId = String(model.id ?? '')
          if (modelId === '')
            continue
          const resolved = llm?.resolveModelInfo === undefined ? undefined : await llm.resolveModelInfo(provider, modelId)
          found.push({
            provider,
            providerLabel,
            model: modelId,
            label: isString(model.name) && !isEmpty(model.name.trim()) ? model.name.trim() : modelId,
            description: resolved?.description ?? model.description,
            reasoning: resolved?.reasoning === undefined
              ? undefined
              : {
                  efforts: map(resolved.reasoning.efforts, effort => ({
                    id: String(effort.id),
                    name: String(effort.name),
                    description: effort.description === undefined ? undefined : String(effort.description),
                  })),
                  defaultEffort: resolved.reasoning.defaultEffort === undefined
                    ? undefined
                    : String(resolved.reasoning.defaultEffort),
                },
          })
        }
      }
      catch (error) {
        failures.push({
          provider,
          providerLabel,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const models = uniqBy(found, item => `${item.provider}::${item.model}`)
    const preferred = current == null
      ? undefined
      : find(models, { provider: String(current.provider), model: String(current.model) })
    return { models, failures, defaultModel: preferred ?? head(models) ?? null }
  }
  catch {
    return { models: [], failures: [], defaultModel: null }
  }
}
