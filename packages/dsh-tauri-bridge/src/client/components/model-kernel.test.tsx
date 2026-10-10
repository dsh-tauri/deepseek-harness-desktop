// @vitest-environment jsdom
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId, SessionListState } from 'dsh-tauri/client'
import type { NativeModelDirectory, NativeTurnOptions } from '../../shared/native-model'
import type { KernelBinding } from '../../shared/types'
import type { NativeModelActions, NativeModelDirectoryState } from '../types/kernel-model'
import type { ModelKernelProps } from './slot-contract'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { defineRegister } from 'dsh-tauri/client'
import { createElement, StrictMode, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getModels, postModels } from '../apis'
import { registerNativeModels } from '../register/kernel-model'
import { nativeModel } from '../store/modules/native-model'
import { ModelKernel } from './model-kernel'

vi.mock('../apis', () => ({ getModels: vi.fn(), postModels: vi.fn() }))

const CATALOG: NativeModelDirectory = {
  backend: 'codex',
  defaultModel: 'gpt-5.4',
  current: { model: null, reasoningEffort: null },
  models: [
    { id: 'gpt-5.4', name: 'GPT-5.4', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' } },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
  ],
}
const OFFICIAL_DIRECTORY: NativeModelDirectoryState = {
  current: { provider: 'openai', model: 'official-model' },
  routable: true,
  groups: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'official-model', name: 'Official model' }] }],
  failures: [],
  status: 'ready',
  pending: null,
  error: null,
}
const disposers: (() => void)[] = []

interface ContractFace {
  locked: boolean
  available: boolean
  directory: { subscribe: (listener: () => void) => () => void, getSnapshot: () => NativeModelDirectoryState }
  load: () => void
  select: (selection: ModelSelection) => Promise<unknown>
  marker: string
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('uninitialized promise')
  }
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function fixture(identity: KernelBinding | null | undefined, options: { current?: NativeTurnOptions, locked?: boolean, available?: boolean, refresh?: boolean } = {}) {
  const officialSelect = vi.fn(async () => ({ ok: true, value: undefined }))
  const officialLoad = vi.fn()
  const ensureProjection = vi.fn(async () => {})
  const faces: ContractFace[] = []
  const listeners = new Set<() => void>()
  let state: SessionListState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {
    ['session-a' as SessionId]: { values: { bridgeKernel: identity, bridgeModel: options.current ?? { model: null, reasoningEffort: null } }, state: 'ready', error: null },
  } }
  const list = {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  let serverSelection: NativeTurnOptions = options.current ?? { model: null, reasoningEffort: null }
  const refreshProjections = vi.fn(async (sessionId: string) => {
    state = { ...state, projectionsBySession: { ...state.projectionsBySession, [sessionId]: {
      values: { ...state.projectionsBySession?.[sessionId as SessionId]?.values, bridgeModel: serverSelection },
      state: 'ready',
      error: null,
    } } }
    for (const listener of listeners)
      listener()
  })
  const sessions = { list, ...(options.refresh === false ? {} : { refreshProjections }), selectModel: vi.fn(), binding: vi.fn(), retain: vi.fn(), create: vi.fn() }
  const navigation = { openSession: vi.fn(), startSession: vi.fn() }
  const ctx = { get: (name: string) => ({ sessions, uiWorkspace: navigation } as Record<string, unknown>)[name] }
  let actions: NativeModelActions | undefined
  const dispose = defineRegister(ctx, (controller, _ctx, adapter) => {
    actions = registerNativeModels(controller, adapter)
  })()
  disposers.push(dispose)
  if (actions === undefined)
    throw new Error('native model actions unavailable')
  const directory = { getSnapshot: () => OFFICIAL_DIRECTORY, subscribe: () => () => {} }
  function ModelSelect(props: ContractFace) {
    faces.push(props)
    const source = props.directory ?? directory
    const snapshot = useSyncExternalStore(listener => source.subscribe(listener), () => source.getSnapshot())
    if (!props.available)
      return null
    const group = snapshot.groups.find(group => group.id === snapshot.current?.provider)
    const current = group?.models.find(model => model.id === snapshot.current?.model)
    const label = current?.name ?? `${snapshot.current?.provider}/${snapshot.current?.model}`
    const reasoning = current?.reasoning
    const effectiveEffort = snapshot.current?.reasoningEffort ?? reasoning?.defaultEffort
    const effortLabel = reasoning === undefined ? snapshot.retainedEffort : effectiveEffort === undefined ? undefined : reasoning.efforts.find(effort => effort.id === effectiveEffort)?.name ?? effectiveEffort
    const chooseModel = (model: NonNullable<typeof group>['models'][number]) => {
      if (snapshot.current?.provider === group!.id && snapshot.current.model === model.id)
        return
      void props.select({ provider: group!.id, model: model.id, ...(model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: model.reasoning.defaultEffort }) })
    }
    const chooseEffort = (effort?: string) => {
      if (snapshot.current === null || effectiveEffort === effort)
        return
      void props.select({ provider: snapshot.current.provider, model: snapshot.current.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
    }
    return createElement('section', { 'data-original-marker': props.marker }, createElement('button', { disabled: props.locked, onClick: props.load }, `${label}${effortLabel === undefined ? '' : ` · ${effortLabel}`}`), ...(snapshot.status === 'ready' ? group?.models.map(model => createElement('button', { key: model.id, disabled: props.locked, onClick: () => chooseModel(model) }, `Model: ${model.name}`)) ?? [] : []), ...(snapshot.status === 'ready' && snapshot.current && reasoning
      ? [
          ...(reasoning.defaultEffort === undefined ? [createElement('button', { key: 'default-effort', disabled: props.locked, onClick: () => chooseEffort() }, 'Depth: default')] : []),
          ...reasoning.efforts.map(effort => createElement('button', { key: effort.id, disabled: props.locked, onClick: () => chooseEffort(effort.id) }, `Depth: ${effort.name}`)),
        ]
      : []), ...(snapshot.error ? [createElement('div', { key: 'error', role: 'alert' }, snapshot.error), createElement('button', { key: 'retry', onClick: props.load }, 'Retry')] : []))
  }
  const base = { Original: ModelSelect, locked: options.locked ?? false, available: options.available ?? true, directory, load: officialLoad, select: officialSelect, ensureProjection, marker: 'original-owner', ...actions }
  function propsFor(sessionId = 'session-a'): ModelKernelProps {
    return { ...base, sessionId, useProjection(key: 'bridgeKernel' | 'bridgeModel') {
      const snapshot = useSyncExternalStore(list.subscribe, list.getSnapshot)
      return snapshot.projectionsBySession?.[sessionId as SessionId]?.values[key]
    } } as unknown as ModelKernelProps
  }
  return {
    props: propsFor(),
    propsFor,
    officialSelect,
    officialLoad,
    ensureProjection,
    actions,
    sessions,
    refreshProjections,
    navigation,
    faces,
    directory,
    setServerSelection(value: NativeTurnOptions) { serverSelection = value },
    setProjection(sessionId: string, binding: KernelBinding | null | undefined, current: NativeTurnOptions | undefined) {
      state = { ...state, projectionsBySession: { ...state.projectionsBySession, [sessionId]: { values: { bridgeKernel: binding, bridgeModel: current }, state: 'ready', error: null } } }
      for (const listener of listeners)
        listener()
    },
  }
}

beforeEach(() => {
  nativeModel.$patch({ generation: 0, entries: {} })
  vi.mocked(getModels).mockReset().mockResolvedValue(CATALOG)
  vi.mocked(postModels).mockReset().mockResolvedValue({ model: 'gpt-5.4', reasoningEffort: 'high' })
})

afterEach(() => {
  cleanup()
  for (const dispose of disposers.splice(0))
    dispose()
  nativeModel.$patch({ generation: 0, entries: {} })
  vi.restoreAllMocks()
})

describe('native model renderer public contract', () => {
  it('the initial native default shows its actual model and effective effort without a click or durable write', async () => {
    vi.mocked(getModels).mockResolvedValue({
      backend: 'codex',
      defaultModel: 'deepseek',
      defaultReasoningEffort: 'high',
      current: { model: 'catalog-hint-is-not-durable', reasoningEffort: 'low' },
      models: [{ id: 'deepseek', name: 'DeepSeek V4.1 Flash', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' } }],
    })
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' })
    const view = render(<ModelKernel {...feature.props} />)
    await view.findByRole('button', { name: 'DeepSeek V4.1 Flash · High' })
    expect(view.getAllByRole('button', { name: /^Model:/ }).map(button => button.textContent)).toEqual(['Model: DeepSeek V4.1 Flash'])
    expect(getModels).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-a' })
    expect(nativeModel.$state.entries['session-a']?.current).toEqual({ model: null, reasoningEffort: null })
    expect(nativeModel.$state.entries['session-a']?.directory.current).toEqual({ provider: 'bridge/codex', model: 'deepseek', reasoningEffort: 'high' })
    expect(view.queryByRole('button', { name: /bridge\/codex/ })).toBeNull()
    expect(postModels).not.toHaveBeenCalled()
    for (const action of [feature.officialSelect, feature.officialLoad, feature.sessions.selectModel, feature.sessions.create, feature.sessions.binding, feature.sessions.retain, feature.navigation.openSession, feature.navigation.startSession])
      expect(action).not.toHaveBeenCalled()
  })

  it('the native custom default effort is a read-only caption when no native depth metadata exists', async () => {
    vi.mocked(getModels).mockResolvedValue({ backend: 'codex', defaultModel: 'deepseek', defaultReasoningEffort: 'high', current: { model: null, reasoningEffort: null }, models: [{ id: 'deepseek', name: 'DeepSeek' }] })
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' })
    const view = render(<ModelKernel {...feature.props} />)
    await view.findByRole('button', { name: 'DeepSeek · high' })
    expect(view.getAllByRole('button', { name: /^Model:/ }).map(button => button.textContent)).toEqual(['Model: DeepSeek'])
    expect(view.queryByRole('button', { name: /^Depth:/ })).toBeNull()
    expect(nativeModel.$state.entries['session-a']?.current).toEqual({ model: null, reasoningEffort: null })
    expect(postModels).not.toHaveBeenCalled()
  })

  it('a missing native default uses one honest placeholder and no guessed model or depth', async () => {
    vi.mocked(getModels).mockResolvedValue({ backend: 'codex', current: { model: null, reasoningEffort: null }, models: [] })
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' })
    const view = render(<ModelKernel {...feature.props} />)
    await view.findByRole('button', { name: 'Model: Native default' })
    expect(view.getAllByRole('button', { name: /^Model:/ }).map(button => button.textContent)).toEqual(['Model: Native default'])
    expect(view.queryByRole('button', { name: /GPT|Depth:|bridge\/codex/ })).toBeNull()
    expect(getModels).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-a' })
    expect(postModels).not.toHaveBeenCalled()
  })

  it('default model and provider-default depth actions reset nullable options without persisting the displayed high hint', async () => {
    vi.mocked(getModels).mockResolvedValue({ ...CATALOG, defaultReasoningEffort: 'high' })
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' })
    const view = render(<ModelKernel {...feature.props} />)
    await view.findByRole('button', { name: 'GPT-5.4 · High' })
    fireEvent.click(view.getByRole('button', { name: 'Model: GPT-5.4' }))
    fireEvent.click(view.getByRole('button', { name: 'Depth: High' }))
    expect(postModels).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'Depth: default' }))
    await waitFor(() => expect(postModels).toHaveBeenNthCalledWith(1, { sessionId: 'session-a', model: null, reasoningEffort: null }))
    await waitFor(() => expect(nativeModel.$state.entries['session-a']?.directory.status).toBe('ready'))
    feature.setServerSelection({ model: 'gpt-5.4-mini', reasoningEffort: null })
    fireEvent.click(view.getByRole('button', { name: 'Model: GPT-5.4 Mini' }))
    await view.findByRole('button', { name: 'GPT-5.4 Mini' })
    feature.setServerSelection({ model: null, reasoningEffort: null })
    fireEvent.click(view.getByRole('button', { name: 'Model: GPT-5.4' }))
    await view.findByRole('button', { name: 'GPT-5.4 · High' })
    expect(vi.mocked(postModels).mock.calls).toEqual([
      [{ sessionId: 'session-a', model: null, reasoningEffort: null }],
      [{ sessionId: 'session-a', model: 'gpt-5.4-mini', reasoningEffort: null }],
      [{ sessionId: 'session-a', model: null, reasoningEffort: null }],
    ])
    expect(nativeModel.$state.entries['session-a']?.current).toEqual({ model: null, reasoningEffort: null })
  })

  it('a medium-to-High user action submits the actual advertised effort rather than the native display baseline', async () => {
    vi.mocked(getModels).mockResolvedValue({ ...CATALOG, defaultReasoningEffort: 'high' })
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' }, { current: { model: null, reasoningEffort: 'medium' } })
    const view = render(<ModelKernel {...feature.props} />)
    await view.findByRole('button', { name: 'GPT-5.4 · Medium' })
    feature.setServerSelection({ model: null, reasoningEffort: 'high' })
    fireEvent.click(view.getByRole('button', { name: 'Depth: High' }))
    await view.findByRole('button', { name: 'GPT-5.4 · High' })
    expect(postModels).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-a', model: null, reasoningEffort: 'high' })
    expect(nativeModel.$state.entries['session-a']?.current).toEqual({ model: null, reasoningEffort: 'high' })
  })

  it('a Claude alias catalog shows exact native names with no second native-default row', async () => {
    vi.mocked(getModels).mockResolvedValue({
      backend: 'claude',
      defaultModel: 'default',
      current: { model: null, reasoningEffort: null },
      models: [
        { id: 'default', name: 'Default (recommended)' },
        { id: 'opus', name: 'Opus' },
        { id: 'fable', name: 'Fable' },
        { id: 'sonnet', name: 'Sonnet' },
        { id: 'haiku', name: 'Haiku' },
      ],
    })
    const feature = fixture({ backend: 'claude', nativeSessionId: 'native-a', sessionId: 'session-a' })
    const view = render(<ModelKernel {...feature.props} />)
    await view.findByRole('button', { name: 'Default (recommended)' })
    fireEvent.click(view.getByRole('button', { name: 'Default (recommended)' }))
    await waitFor(() => expect(view.getAllByRole('button', { name: /^Model:/ }).map(button => button.textContent)).toEqual([
      'Model: Default (recommended)',
      'Model: Opus',
      'Model: Fable',
      'Model: Sonnet',
      'Model: Haiku',
    ]))
    expect(view.queryByRole('button', { name: /原生默认|Native default|bridge\/claude/ })).toBeNull()
    expect(nativeModel.$state.entries['session-a']!.current).toEqual({ model: null, reasoningEffort: null })
    expect(postModels).not.toHaveBeenCalled()
  })

  it('reading an existing fixed default preference never silently converts it to nullable delegation', async () => {
    vi.mocked(getModels).mockResolvedValue({ ...CATALOG, defaultReasoningEffort: 'high' })
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' }, { current: { model: 'gpt-5.4', reasoningEffort: null } })
    const view = render(<ModelKernel {...feature.props} />)
    await view.findByRole('button', { name: 'GPT-5.4 · High' })
    fireEvent.click(view.getByRole('button', { name: 'Model: GPT-5.4' }))
    fireEvent.click(view.getByRole('button', { name: 'Depth: High' }))
    expect(nativeModel.$state.entries['session-a']?.current).toEqual({ model: 'gpt-5.4', reasoningEffort: null })
    expect(postModels).not.toHaveBeenCalled()
    expect(feature.refreshProjections).not.toHaveBeenCalled()
  })

  it('strict mode and shared renderers perform one initial request for a nullable native default', async () => {
    const pending = deferred<NativeModelDirectory>()
    vi.mocked(getModels).mockReturnValueOnce(pending.promise)
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' })
    const first = render(<StrictMode><ModelKernel {...feature.props} /></StrictMode>)
    const second = render(<StrictMode><ModelKernel {...feature.props} /></StrictMode>)
    await waitFor(() => expect(getModels).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-a' }))
    const scope = nativeModel.$state.entries['session-a']!.scope
    first.unmount()
    await act(async () => {
      pending.resolve({ backend: 'codex', defaultModel: 'deepseek', defaultReasoningEffort: 'high', current: { model: null, reasoningEffort: null }, models: [{ id: 'deepseek', name: 'DeepSeek' }] })
      await pending.promise
    })
    await second.findByRole('button', { name: 'DeepSeek · high' })
    expect(second.getAllByRole('button', { name: /^Model:/ }).map(button => button.textContent)).toEqual(['Model: DeepSeek'])
    expect(nativeModel.$state.entries['session-a']!.scope).toBe(scope)
    expect(nativeModel.$state.entries['session-a']!.current).toEqual({ model: null, reasoningEffort: null })
    expect(getModels).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-a' })
    expect(postModels).not.toHaveBeenCalled()
    second.unmount()
    await act(async () => {})
    expect(nativeModel.$state.entries).toEqual({})
  })

  it('an inherited native binding uses a native-default placeholder rather than presenting its bridge route as a model', () => {
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-parent', sessionId: 'parent-session' })
    const view = render(<ModelKernel {...feature.props} />)
    const trigger = view.getByRole('button', { name: 'Native default' }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    expect(trigger.title).toBe('Forked sessions cannot resume the native kernel')
    expect(view.queryByRole('button', { name: /bridge\/codex/ })).toBeNull()
    expect(nativeModel.$state.entries).toEqual({})
    expect(getModels).not.toHaveBeenCalled()
    expect(postModels).not.toHaveBeenCalled()
  })

  it.each(['codex', 'claude'] as const)('the %s identity reuses the original renderer with real native model and depth metadata', async (backend) => {
    const modelId = backend === 'codex' ? 'gpt-5.4' : 'claude-sonnet-4-6'
    const modelName = backend === 'codex' ? 'GPT-5.4' : 'Sonnet 4.6'
    vi.mocked(getModels).mockResolvedValue({ ...CATALOG, backend, defaultModel: modelId, models: [{ id: modelId, name: modelName, reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] })
    const feature = fixture({ backend, nativeSessionId: 'native-a', sessionId: 'session-a' }, { current: { model: modelId, reasoningEffort: 'high' } })
    const view = render(<ModelKernel {...feature.props} />)
    const initial = await view.findByRole('button', { name: `${modelName} · High` }) as HTMLButtonElement
    expect(initial.disabled).toBe(false)
    expect(getModels).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-a' })
    expect(view.queryByRole('button', { name: 'Official model' })).toBeNull()
    expect(view.container.querySelector('[data-bridge-kernel-model="native"]')?.getAttribute('title')).toBe('Model and reasoning changes apply to the next complete turn; this session kernel cannot be changed')
    expect(view.container.querySelector('[data-original-marker="original-owner"]')).not.toBeNull()
    expect(feature.officialLoad).not.toHaveBeenCalled()
    expect(feature.officialSelect).not.toHaveBeenCalled()
  })

  it('the official Codex catalog exposes GPT display names and distinct advertised Extra High and Max choices', async () => {
    vi.mocked(getModels).mockResolvedValue({
      backend: 'codex',
      defaultModel: 'gpt-6.1-sol',
      current: { model: null, reasoningEffort: null },
      models: [
        { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', reasoning: { efforts: [
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
          { id: 'xhigh', name: 'Extra High' },
          { id: 'max', name: 'Max' },
          { id: 'ultra', name: 'Ultra' },
        ], defaultEffort: 'low' } },
        { id: 'gpt-6-astra', name: 'GPT-6-Astra' },
        { id: 'gpt-6-luna', name: 'GPT-6-Luna' },
      ],
    })
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' }, { current: { model: 'gpt-6.1-sol', reasoningEffort: 'low' } })
    const view = render(<ModelKernel {...feature.props} />)
    await view.findByRole('button', { name: 'GPT-6.1-Sol · Low' })
    expect(view.getAllByRole('button', { name: /^Model: GPT/ }).map(button => button.textContent)).toEqual(['Model: GPT-6.1-Sol', 'Model: GPT-6-Astra', 'Model: GPT-6-Luna'])
    expect(view.getAllByRole('button', { name: /^Depth:/ }).map(button => button.textContent)).toEqual(['Depth: default', 'Depth: Low', 'Depth: Medium', 'Depth: High', 'Depth: Extra High', 'Depth: Max', 'Depth: Ultra'])
    expect(view.queryByRole('button', { name: 'Official model' })).toBeNull()
    expect(view.queryByRole('button', { name: 'Depth: Off' })).toBeNull()
    feature.setServerSelection({ model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' })
    fireEvent.click(view.getByRole('button', { name: 'Depth: Extra High' }))
    await view.findByRole('button', { name: 'GPT-6.1-Sol · Extra High' })
    feature.setServerSelection({ model: 'gpt-6.1-sol', reasoningEffort: 'max' })
    fireEvent.click(view.getByRole('button', { name: 'Depth: Max' }))
    await view.findByRole('button', { name: 'GPT-6.1-Sol · Max' })
    expect(postModels).toHaveBeenNthCalledWith(1, { sessionId: 'session-a', model: null, reasoningEffort: 'xhigh' })
    expect(postModels).toHaveBeenNthCalledWith(2, { sessionId: 'session-a', model: null, reasoningEffort: 'max' })
    expect(feature.officialLoad).not.toHaveBeenCalled()
    expect(feature.officialSelect).not.toHaveBeenCalled()
  })

  it('advertised native Off sends none while the separate default choice sends null', async () => {
    vi.mocked(getModels).mockResolvedValue({
      backend: 'codex',
      defaultModel: 'vendor-model',
      current: { model: null, reasoningEffort: null },
      models: [{ id: 'vendor-model', name: 'Native vendor model', reasoning: { efforts: [{ id: 'none', name: 'Off' }, { id: 'max', name: 'Max' }], defaultEffort: 'max' } }],
    })
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' }, { current: { model: 'vendor-model', reasoningEffort: 'max' } })
    const view = render(<ModelKernel {...feature.props} />)
    await view.findByRole('button', { name: 'Depth: Off' })
    feature.setServerSelection({ model: 'vendor-model', reasoningEffort: 'none' })
    fireEvent.click(view.getByRole('button', { name: 'Depth: Off' }))
    await view.findByRole('button', { name: 'Native vendor model · Off' })
    expect(postModels).toHaveBeenNthCalledWith(1, { sessionId: 'session-a', model: null, reasoningEffort: 'none' })
    feature.setServerSelection({ model: 'vendor-model', reasoningEffort: null })
    fireEvent.click(view.getByRole('button', { name: 'Depth: default' }))
    await view.findByRole('button', { name: 'Native vendor model' })
    expect(postModels).toHaveBeenNthCalledWith(2, { sessionId: 'session-a', model: null, reasoningEffort: null })
    expect(feature.officialSelect).not.toHaveBeenCalled()
  })

  it('model and depth choices use generated native APIs and durable projection without global model RPC or activation', async () => {
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' }, { current: { model: 'gpt-5.4-mini', reasoningEffort: null } })
    const view = render(<ModelKernel {...feature.props} />)
    await view.findByRole('button', { name: 'Model: GPT-5.4' })
    feature.setServerSelection({ model: null, reasoningEffort: null })
    fireEvent.click(view.getByRole('button', { name: 'Model: GPT-5.4' }))
    await view.findByRole('button', { name: 'GPT-5.4' })
    expect(postModels).toHaveBeenNthCalledWith(1, { sessionId: 'session-a', model: null, reasoningEffort: null })
    feature.setServerSelection({ model: null, reasoningEffort: 'high' })
    fireEvent.click(view.getByRole('button', { name: 'Depth: High' }))
    await view.findByRole('button', { name: 'GPT-5.4 · High' })
    expect(postModels).toHaveBeenNthCalledWith(2, { sessionId: 'session-a', model: null, reasoningEffort: 'high' })
    expect(feature.refreshProjections.mock.calls).toEqual([['session-a'], ['session-a']])
    for (const action of [feature.officialSelect, feature.sessions.selectModel, feature.sessions.create, feature.sessions.binding, feature.sessions.retain, feature.navigation.openSession, feature.navigation.startSession])
      expect(action).not.toHaveBeenCalled()
  })

  it('the nullable default model retains actual depth choices and sends a nullable effort reset', async () => {
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' })
    const view = render(<ModelKernel {...feature.props} />)
    await view.findByRole('button', { name: 'Depth: High' })
    feature.setServerSelection({ model: null, reasoningEffort: 'high' })
    fireEvent.click(view.getByRole('button', { name: 'Depth: High' }))
    await view.findByRole('button', { name: 'GPT-5.4 · High' })
    expect(postModels).toHaveBeenNthCalledWith(1, { sessionId: 'session-a', model: null, reasoningEffort: 'high' })
    feature.setServerSelection({ model: null, reasoningEffort: null })
    fireEvent.click(view.getByRole('button', { name: 'Depth: default' }))
    await view.findByRole('button', { name: 'GPT-5.4' })
    expect(postModels).toHaveBeenNthCalledWith(2, { sessionId: 'session-a', model: null, reasoningEffort: null })
  })

  it('models without native reasoning metadata expose no invented depth controls', async () => {
    vi.mocked(getModels).mockResolvedValue({ backend: 'claude', defaultModel: 'claude-sonnet-4-6', current: { model: null, reasoningEffort: null }, models: [{ id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' }] })
    const feature = fixture({ backend: 'claude', nativeSessionId: 'native-a', sessionId: 'session-a' }, { current: { model: 'claude-sonnet-4-6', reasoningEffort: null } })
    const view = render(<ModelKernel {...feature.props} />)
    await view.findByRole('button', { name: 'Sonnet 4.6' })
    expect(view.queryByRole('button', { name: /Depth:/ })).toBeNull()
  })

  it.each([{ locked: true, available: true }, { locked: false, available: false }])('preserves locked=$locked and available=$available even for direct public callback invocation', async (options) => {
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' }, options)
    const view = render(<ModelKernel {...feature.props} />)
    if (options.available)
      expect((await view.findByRole('button', { name: 'GPT-5.4' }) as HTMLButtonElement).disabled).toBe(true)
    else
      expect(view.queryByRole('button')).toBeNull()
    await act(async () => {
      await feature.faces.at(-1)?.select({ provider: 'bridge/codex', model: 'gpt-5.4' })
    })
    expect(postModels).not.toHaveBeenCalled()
    expect(feature.officialSelect).not.toHaveBeenCalled()
  })

  it('catalog failures stay visible and retry reloads the same native scope', async () => {
    vi.mocked(getModels).mockRejectedValueOnce(new Error('CLI catalog failed'))
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' })
    const view = render(<ModelKernel {...feature.props} />)
    expect((await view.findByRole('alert')).textContent).toBe('CLI catalog failed')
    fireEvent.click(view.getByRole('button', { name: 'Retry' }))
    await view.findByRole('button', { name: 'Model: GPT-5.4' })
    expect(view.queryByRole('alert')).toBeNull()
    expect(getModels).toHaveBeenCalledTimes(2)
    expect(feature.officialLoad).not.toHaveBeenCalled()
  })

  it('a selection pending during session switch cannot update the new session or refresh the old projection', async () => {
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' })
    const view = render(<ModelKernel {...feature.props} />)
    await view.findByRole('button', { name: 'Model: GPT-5.4 Mini' })
    const pending = deferred<NativeTurnOptions>()
    vi.mocked(postModels).mockReturnValueOnce(pending.promise)
    fireEvent.click(view.getByRole('button', { name: 'Model: GPT-5.4 Mini' }))
    vi.mocked(getModels).mockResolvedValueOnce({ backend: 'claude', defaultModel: 'claude-native', current: { model: null, reasoningEffort: null }, models: [{ id: 'claude-native', name: 'Claude native' }] })
    act(() => feature.setProjection('session-b', { backend: 'claude', nativeSessionId: 'native-b', sessionId: 'session-b' }, { model: null, reasoningEffort: null }))
    view.rerender(<ModelKernel {...feature.propsFor('session-b')} />)
    await act(async () => {
      pending.resolve({ model: 'gpt-5.4', reasoningEffort: null })
      await pending.promise
    })
    await view.findByRole('button', { name: 'Claude native' })
    expect(nativeModel.$state.entries['session-a']).toBeUndefined()
    expect(nativeModel.$state.entries['session-b']?.current).toEqual({ model: null, reasoningEffort: null })
    expect(feature.refreshProjections).not.toHaveBeenCalled()
  })

  it('unmount releases the register-owned native scope before a catalog can complete', async () => {
    const pending = deferred<NativeModelDirectory>()
    vi.mocked(getModels).mockReturnValueOnce(pending.promise)
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' })
    const view = render(<ModelKernel {...feature.props} />)
    await waitFor(() => expect(getModels).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-a' }))
    view.unmount()
    await act(async () => {
      pending.resolve(CATALOG)
      await pending.promise
    })
    expect(nativeModel.$state.entries).toEqual({})
  })

  it('strict mode reconnects one stable directory without dropping shared renderers or durable selection', async () => {
    const binding: KernelBinding = { backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' }
    const feature = fixture(binding, { current: { model: 'gpt-5.4', reasoningEffort: 'high' } })
    const first = render(<StrictMode><ModelKernel {...feature.props} /></StrictMode>)
    await first.findByRole('button', { name: 'GPT-5.4 · High' })
    expect(getModels).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-a' })
    expect(first.getAllByRole('button', { name: /^Model:/ }).map(button => button.textContent)).toEqual(['Model: GPT-5.4', 'Model: GPT-5.4 Mini'])
    const directory = feature.faces.at(-1)?.directory
    const scope = nativeModel.$state.entries['session-a']?.scope
    act(() => feature.setProjection('session-a', { ...binding }, { model: 'gpt-5.4', reasoningEffort: 'medium' }))
    await first.findByRole('button', { name: 'GPT-5.4 · Medium' })
    expect(feature.faces.at(-1)?.directory).toBe(directory)
    expect(nativeModel.$state.entries['session-a']?.scope).toBe(scope)
    const second = render(<StrictMode><ModelKernel {...feature.props} /></StrictMode>)
    await act(async () => {})
    expect(getModels).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-a' })
    first.unmount()
    expect(nativeModel.$state.entries['session-a']?.scope).toBe(scope)
    expect(nativeModel.$state.entries['session-a']?.current).toEqual({ model: 'gpt-5.4', reasoningEffort: 'medium' })
    second.unmount()
    await act(async () => {})
    expect(nativeModel.$state.entries).toEqual({})
  })

  it('deepseek retains the original renderer directory and business actions', async () => {
    const feature = fixture(null)
    const view = render(<ModelKernel {...feature.props} />)
    fireEvent.click(view.getByRole('button', { name: 'Official model' }))
    await act(async () => {
      await feature.faces.at(-1)!.select({ provider: 'openai', model: 'official-model' })
    })
    expect(feature.officialLoad).toHaveBeenCalledOnce()
    expect(feature.officialSelect).toHaveBeenCalledExactlyOnceWith({ provider: 'openai', model: 'official-model' })
    expect(feature.faces.at(-1)?.directory).toBe(feature.directory)
    expect(feature.faces.at(-1)?.select).toBe(feature.officialSelect)
    expect(view.container.querySelector('[data-bridge-kernel-model]')).toBeNull()
    expect(getModels).not.toHaveBeenCalled()
    expect(postModels).not.toHaveBeenCalled()
  })

  it('an owner-locked DeepSeek composer never becomes unlocked', () => {
    const feature = fixture(null, { locked: true })
    const view = render(<ModelKernel {...feature.props} />)
    expect((view.getByRole('button', { name: 'Official model' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('unknown kernel identity stays locked and requests only nonactivating projection', async () => {
    const feature = fixture(undefined)
    const view = render(<ModelKernel {...feature.props} />)
    const trigger = view.getByRole('button', { name: 'Kernel' }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    expect(trigger.title).toBe('Reading session kernel')
    await waitFor(() => expect(feature.ensureProjection).toHaveBeenCalledExactlyOnceWith('session-a'))
    expect(nativeModel.$state.entries).toEqual({})
    expect(getModels).not.toHaveBeenCalled()
  })

  it('missing durable native options remain locked instead of reading global model state', async () => {
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' })
    feature.setProjection('session-a', { backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' }, undefined)
    const view = render(<ModelKernel {...feature.props} />)
    expect((view.getByRole('button', { name: 'Native default' }) as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() => expect(feature.ensureProjection).toHaveBeenCalledExactlyOnceWith('session-a'))
    expect(nativeModel.$state.entries).toEqual({})
  })

  it('an inherited parent binding stays locked until the child owns a separate native identity', () => {
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-parent', sessionId: 'parent-session' })
    const view = render(<ModelKernel {...feature.props} />)
    expect((view.getByRole('button', { name: 'Native default' }) as HTMLButtonElement).disabled).toBe(true)
    expect(nativeModel.$state.entries).toEqual({})
    expect(getModels).not.toHaveBeenCalled()
  })

  it('a missing official projection reader cannot silently unlock the native seat', () => {
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' }, { refresh: false })
    const view = render(<ModelKernel {...feature.props} />)
    expect((view.getByRole('button', { name: 'Native default' }) as HTMLButtonElement).disabled).toBe(true)
    expect(nativeModel.$state.entries).toEqual({})
  })

  it('an unsupported renderer runtime face receives every original value untouched', () => {
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' })
    const props = { ...feature.props, directory: undefined }
    const view = render(<ModelKernel {...props} />)
    expect((view.getByRole('button', { name: 'Official model' }) as HTMLButtonElement).disabled).toBe(false)
    expect(feature.faces.at(-1)?.directory).toBeUndefined()
    expect(feature.faces.at(-1)?.select).toBe(feature.officialSelect)
    expect(view.container.querySelector('[data-bridge-kernel-model]')).toBeNull()
    expect(feature.ensureProjection).not.toHaveBeenCalled()
    expect(getModels).not.toHaveBeenCalled()
  })
})
