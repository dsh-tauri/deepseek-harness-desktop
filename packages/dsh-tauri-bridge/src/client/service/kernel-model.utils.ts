import type { ModelCatalogModel, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { NativeModelDirectory, NativeTurnOptions } from '../../shared/native-model'
import type { KernelBinding } from '../../shared/types'
import type { NativeModelDirectoryState } from '../types/kernel-model'
import { NATIVE_DEFAULT_MODEL } from '../constants'

export function nativeModelDirectory(
  backend: KernelBinding['backend'],
  current: NativeTurnOptions,
  catalog: NativeModelDirectory | null,
  previous?: NativeModelDirectoryState,
): NativeModelDirectoryState {
  const provider = `bridge/${backend}`
  const defaultModel = catalog?.models.find(model => model.id === catalog.defaultModel)
  const modelView = (model: ModelCatalogModel): ModelCatalogModel => ({
    ...model,
    ...(model.reasoning === undefined ? {} : { reasoning: { efforts: model.reasoning.efforts } }),
  })
  const models: ModelCatalogModel[] = [{
    id: NATIVE_DEFAULT_MODEL,
    name: provider,
    ...(defaultModel?.description === undefined ? {} : { description: defaultModel.description }),
    ...(defaultModel?.reasoning === undefined ? {} : { reasoning: { efforts: defaultModel.reasoning.efforts } }),
  }, ...(catalog?.models.map(modelView) ?? [])]
  const selection: ModelSelection = {
    provider,
    model: current.model ?? NATIVE_DEFAULT_MODEL,
    ...(current.reasoningEffort === null ? {} : { reasoningEffort: current.reasoningEffort }),
  }
  return {
    current: selection,
    ...(current.reasoningEffort === null ? {} : { retainedEffort: current.reasoningEffort }),
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
  const model = selection.model === NATIVE_DEFAULT_MODEL ? null : selection.model
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
