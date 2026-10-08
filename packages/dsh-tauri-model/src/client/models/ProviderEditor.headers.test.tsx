// @vitest-environment jsdom
import type { JsonValue, SettingsNamespaceView, SettingsPathOpView } from '../types/remotes'
import type { ProviderEditorProps } from './ProviderEditor'
import type { SettingsSchemaOperations } from './schema-operations'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { pathOps, ProviderEditor } from './ProviderEditor'

vi.mock('./styles.ts', () => ({ modelStyles: {} }))
vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: () => {
    throw new Error('Unexpected store creation')
  },
}))
vi.mock('dsh-tauri-ui/client', () => ({
  Action: () => null,
  Checkbox: () => null,
  ArrowDown: () => null,
  ArrowUp: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
  Plus: () => null,
  SegmentedControl: () => null,
  Select: () => null,
  Text: () => null,
  TrashBin: () => null,
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: () => null,
  Modal: () => null,
  rankByName: <T,>(rows: T[]) => rows,
}))
vi.mock('../ui/model-extras', () => ({
  AutoConfigAllButton: () => null,
  ModelFetchConfigButton: () => null,
  ModelCompatFields: () => null,
  modelExtrasTranslate: (key: string) => key,
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function setPath(value: unknown, path: readonly string[], next: unknown): unknown {
  const [head, ...rest] = path
  if (head === undefined)
    return next
  const source = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return { ...source, [head]: setPath(source[head], rest, next) }
}

function deletePath(value: unknown, path: readonly string[]): unknown {
  const [head, ...rest] = path
  if (head === undefined || typeof value !== 'object' || value === null || Array.isArray(value))
    return value
  const source = { ...(value as Record<string, unknown>) }
  if (rest.length === 0)
    delete source[head]
  else
    source[head] = deletePath(source[head], rest)
  return source
}

function applyOps(
  profile: Record<string, unknown>,
  ops: readonly SettingsPathOpView[],
): Record<string, unknown> {
  let next: unknown = profile
  for (const op of ops) {
    const rest = op.path.slice(2)
    next = op.op === 'set'
      ? setPath(next, rest, op.value)
      : deletePath(next, rest)
  }
  return typeof next === 'object' && next !== null ? next as Record<string, unknown> : {}
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value
  for (const step of path) {
    if (typeof cursor !== 'object' || cursor === null)
      return undefined
    cursor = (cursor as Record<string, unknown>)[step]
  }
  return cursor
}

function namespace(profile: Record<string, unknown>): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema: {},
    value: { providers: { custom: profile } } as unknown as JsonValue,
    user: { providers: { custom: profile } } as unknown as JsonValue,
    applies: 'live',
    secrets: [],
    revision: 3,
  }
}

function setup(profile: Record<string, unknown>, writeSettings: ProviderEditorProps['operations']['writeSettings']) {
  const props: ProviderEditorProps = {
    provider: 'custom',
    displayName: 'Custom',
    namespace: namespace(profile),
    settingsPath: ['providers', 'custom'],
    operations: {
      describeCredential: vi.fn(async () => undefined),
      storeCredential: vi.fn(),
      removeCredential: vi.fn(),
      writeSettings,
      discoverModels: vi.fn(async () => ({ kind: 'refused' as const, message: 'unused' })),
    },
    schema: {
      getPath: readPath,
      rehydrate: (value: unknown) => value as unknown as ReturnType<SettingsSchemaOperations['rehydrate']>,
      nodeAtPath: () => ({ type: 'object', meta: {} }) as unknown as ReturnType<SettingsSchemaOperations['nodeAtPath']>,
      validate: () => undefined,
      hasPath: (value, path) => readPath(value, path) !== undefined,
      setPath: (value, path, next) => setPath(value, path, next) as Record<string, unknown>,
      deletePath: (value, path) => deletePath(value, path) as Record<string, unknown>,
    },
    t: key => key,
    readOnly: false,
    onClose: vi.fn(),
  }
  return { props, view: render(<ProviderEditor {...props} />) }
}

it('edits headers through the draft and removes the key when the text empties', async () => {
  const writes: SettingsPathOpView[][] = []
  let profile: Record<string, unknown> = {
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:8092/v1',
    headers: { 'X-Lab-Token': 'old' },
    models: [{ id: 'lab-model' }],
  }
  const writeSettings = vi.fn(async (_ns: string, ops: SettingsPathOpView[]) => {
    writes.push(ops)
    profile = applyOps(profile, ops)
    return { kind: 'written' as const, view: namespace(profile) }
  })
  setup(profile, writeSettings)
  expect((screen.getByLabelText('requestHeaders') as HTMLTextAreaElement).value).toBe('X-Lab-Token: old')
  fireEvent.change(screen.getByLabelText('requestHeaders'), { target: { value: 'X-Lab-Token: lab-639\nX-Trace: a:b' } })
  await act(async () => {
    fireEvent.click(screen.getByText('apply'))
  })
  expect(writes[0]).toEqual([
    { op: 'set', path: ['providers', 'custom', 'headers'], value: { 'X-Lab-Token': 'lab-639', 'X-Trace': 'a:b' } },
  ])
  fireEvent.change(screen.getByLabelText('requestHeaders'), { target: { value: '' } })
  await act(async () => {
    fireEvent.click(screen.getByText('apply'))
  })
  expect(writes[1]).toEqual([
    { op: 'unset', path: ['providers', 'custom', 'headers'] },
  ])
})

it('blocks the apply button while a header name is malformed', () => {
  const writeSettings = vi.fn()
  setup({ api: 'openai-completions', baseURL: 'http://127.0.0.1:8092/v1', models: [{ id: 'lab-model' }] }, writeSettings)
  fireEvent.change(screen.getByLabelText('requestHeaders'), { target: { value: 'Bad Name: value' } })
  expect(screen.getByText('headerNameInvalid')).toBeTruthy()
  expect((screen.getByText('apply') as HTMLButtonElement).disabled).toBe(true)
  expect(writeSettings).not.toHaveBeenCalled()
})

it('turns a request header record back into editable text and drops unknown values', () => {
  expect(pathOps([], { headers: { A: '1' } }, { headers: { A: '2' } })).toEqual([
    { op: 'set', path: ['headers'], value: { A: '2' } },
  ])
})
