// @vitest-environment jsdom
import type { SettingsNamespaceView, SettingsPathOpView } from '../types/remotes'
import type { CustomProviderCardProps } from './CustomProviderCard'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CustomProviderCard } from './CustomProviderCard'

vi.mock('./styles.ts', () => ({ modelStyles: {} }))
vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: () => {
    throw new Error('Unexpected store creation')
  },
}))
vi.mock('dsh-tauri-ui/client', () => ({ ArrowDown: () => null, ArrowUp: () => null, Plus: () => null }))
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
vi.mock('./ModelListEditor.tsx', () => ({
  ModelListEditor: (props: {
    onChange: (models: readonly Record<string, unknown>[]) => void
    probe: Record<string, unknown>
  }) => (
    <button type="button" data-probe={JSON.stringify(props.probe)} onClick={() => { props.onChange([{ id: 'lab-model' }]) }}>
      pick-model
    </button>
  ),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function view(): SettingsNamespaceView {
  return { ns: 'llm-pi-ai', schema: {}, value: {}, user: {}, applies: 'live', secrets: [], revision: 7 }
}

function setup(operations: CustomProviderCardProps['operations']) {
  const onClose = vi.fn()
  const props: CustomProviderCardProps = {
    taken: [],
    protocols: ['openai-completions'],
    revision: 7,
    operations,
    t: key => key,
    readOnly: false,
    onClose,
  }
  const rendered = render(<CustomProviderCard {...props} />)
  return { onClose, rendered }
}

function fill(route: string, baseURL: string): void {
  fireEvent.change(screen.getByLabelText('customRoute'), { target: { value: route } })
  fireEvent.change(screen.getByLabelText('baseUrl'), { target: { value: baseURL } })
  fireEvent.click(screen.getByText('pick-model'))
}

it('writes parsed headers into the provider profile and ignores comment lines', async () => {
  const written: SettingsPathOpView[][] = []
  const writeSettings = vi.fn(async (_ns: string, ops: SettingsPathOpView[]) => {
    written.push(ops)
    return { kind: 'written' as const, view: view() }
  })
  const { onClose } = setup({
    describeCredential: vi.fn(),
    storeCredential: vi.fn(),
    removeCredential: vi.fn(),
    writeSettings,
    discoverModels: vi.fn(),
  })
  fill('acme-gateway', 'http://127.0.0.1:8092/v1')
  fireEvent.change(screen.getByLabelText('requestHeaders'), {
    target: { value: '# internal gateway\nX-Lab-Token: lab-639\nX-Trace: a:b' },
  })
  await act(async () => {
    fireEvent.click(screen.getByText('create'))
  })
  expect(written[0]).toEqual([
    {
      op: 'set',
      path: ['providers', 'acme-gateway'],
      value: {
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:8092/v1',
        headers: { 'X-Lab-Token': 'lab-639', 'X-Trace': 'a:b' },
        models: [{ id: 'lab-model' }],
      },
    },
  ])
  expect(onClose).toHaveBeenCalledWith(true)
})

it('rejects a malformed header name before writing', () => {
  const writeSettings = vi.fn()
  setup({
    describeCredential: vi.fn(),
    storeCredential: vi.fn(),
    removeCredential: vi.fn(),
    writeSettings,
    discoverModels: vi.fn(),
  })
  fill('acme-gateway', 'http://127.0.0.1:8092/v1')
  fireEvent.change(screen.getByLabelText('requestHeaders'), { target: { value: 'X Org: value' } })
  expect(screen.getByText('headerNameInvalid')).toBeTruthy()
  expect((screen.getByText('create') as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByText('create'))
  expect(writeSettings).not.toHaveBeenCalled()
})

it('reports a duplicated header name and refuses to submit', () => {
  const writeSettings = vi.fn()
  setup({
    describeCredential: vi.fn(),
    storeCredential: vi.fn(),
    removeCredential: vi.fn(),
    writeSettings,
    discoverModels: vi.fn(),
  })
  fill('acme-gateway', 'http://127.0.0.1:8092/v1')
  fireEvent.change(screen.getByLabelText('requestHeaders'), { target: { value: 'X-Lab-Token: a\nx-lab-token: b' } })
  expect(screen.getByText('headerNameDuplicate')).toBeTruthy()
  expect((screen.getByText('create') as HTMLButtonElement).disabled).toBe(true)
})

it('hands the headers to the model list probe so a guarded endpoint can be read', () => {
  const writeSettings = vi.fn()
  const { rendered } = setup({
    describeCredential: vi.fn(),
    storeCredential: vi.fn(),
    removeCredential: vi.fn(),
    writeSettings,
    discoverModels: vi.fn(),
  })
  fill('acme-gateway', 'http://127.0.0.1:8092/v1')
  fireEvent.change(screen.getByLabelText('requestHeaders'), { target: { value: 'X-Lab-Token: lab-639' } })
  const probe = JSON.parse(rendered.container.querySelector('[data-probe]')!.getAttribute('data-probe')!) as Record<string, unknown>
  expect(probe).toEqual({
    settingsNs: 'llm-pi-ai',
    baseURL: 'http://127.0.0.1:8092/v1',
    api: 'openai-completions',
    headers: { 'X-Lab-Token': 'lab-639' },
  })
})
