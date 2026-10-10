import type { ModelCatalogModel, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { NativeModelDirectory, NativeTurnOptions } from '../../shared/native-model'
import type { KernelBinding } from '../../shared/types'
import type { NativeModelDirectoryState } from '../types/kernel-model'
import { groupBy, uniqBy } from 'dsh-tauri/client'
import { NATIVE_DEFAULT_MODEL } from '../constants'
import { locale } from '../locales'

export function nativeModelDirectory(
  backend: KernelBinding['backend'],
  current: NativeTurnOptions,
  catalog: NativeModelDirectory | null,
  previous?: NativeModelDirectoryState,
): NativeModelDirectoryState {
  const provider = `bridge/${backend}`
  const defaultId = catalog?.defaultModel ?? NATIVE_DEFAULT_MODEL
  const listed = uniqBy(catalog?.models ?? [], 'id')
  const directory = listed.some(model => model.id === defaultId)
    ? listed
    : [{ id: defaultId, name: catalog?.defaultModel ?? locale.text('kernel.modelDefault') }, ...listed]
  const names = groupBy(directory, 'name')
  const models: ModelCatalogModel[] = directory.map(model => ({
    ...model,
    name: names[model.name]!.length > 1 ? `${model.name} (${model.id})` : model.name,
    ...(model.reasoning === undefined ? {} : { reasoning: { efforts: model.reasoning.efforts } }),
  }))
  const reasoningEffort = current.reasoningEffort
    ?? (current.model === null || current.model === catalog?.defaultModel ? catalog?.defaultReasoningEffort : undefined)
  const selection: ModelSelection = {
    provider,
    model: current.model ?? defaultId,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
  return {
    current: selection,
    ...(reasoningEffort === undefined ? {} : { retainedEffort: reasoningEffort }),
    routable: catalog === null ? null : models.some(model => model.id === selection.model),
    groups: [{ id: provider, name: backend === 'codex' ? 'Codex' : 'Claude', models }],
    failures: [],
    status: previous?.status ?? 'idle',
    pending: previous?.pending ?? null,
    error: previous?.error ?? null,
  }
}

export function nativeModelOptions(backend: KernelBinding['backend'], catalog: NativeModelDirectory, selection: ModelSelection): NativeTurnOptions {
  if (selection.provider !== `bridge/${backend}`)
    throw new Error('Native session kernel cannot be changed')
  const model = selection.model === NATIVE_DEFAULT_MODEL || selection.model === catalog.defaultModel ? null : selection.model
  const info = catalog.models.find(item => item.id === (model ?? catalog.defaultModel))
  if (model !== null && info === undefined)
    throw new Error('Native model is unavailable')
  const reasoningEffort = selection.reasoningEffort ?? null
  if (reasoningEffort !== null && !info?.reasoning?.efforts.some(effort => effort.id === reasoningEffort))
    throw new Error('Native reasoning effort is unavailable')
  return { model, reasoningEffort }
}

export function isNativeTurnOptions(value: unknown): value is NativeTurnOptions {
  if (typeof value !== 'object' || value === null)
    return false
  const current = value as Record<string, unknown>
  return (current.model === null || (typeof current.model === 'string' && current.model.length > 0))
    && (current.reasoningEffort === null || (typeof current.reasoningEffort === 'string' && current.reasoningEffort.length > 0))
}
