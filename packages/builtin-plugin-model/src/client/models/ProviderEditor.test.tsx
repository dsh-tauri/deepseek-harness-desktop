// @vitest-environment jsdom
import type { CredentialInfo, SettingsNamespaceView } from '../types/remotes'
import type { ProviderEditorProps } from './ProviderEditor'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProviderEditor } from './ProviderEditor'

vi.mock('./styles.ts', () => ({ modelStyles: {} }))
vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: () => {
    throw new Error('Unexpected store creation')
  },
}))
vi.mock('dsh-tauri-ui/client', () => ({ Plus: () => null }))
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

it('invalidates credential metadata immediately when the key reference changes and ignores stale replies', async () => {
  const replies = new Map<string, (info: CredentialInfo | undefined) => void>()
  const describeCredential = vi.fn((ref: string) => new Promise<CredentialInfo | undefined>((resolve) => {
    replies.set(ref, resolve)
  }))
  const unexpected = vi.fn(async () => {
    throw new Error('Unexpected remote operation')
  })
  function namespace(ref: string): SettingsNamespaceView {
    return {
      ns: 'llm-deepseek',
      schema: {},
      value: { apiKeyEnv: ref },
      user: {},
      applies: 'live',
      secrets: [],
      revision: 1,
    }
  }
  const props: ProviderEditorProps = {
    provider: 'custom',
    displayName: 'Custom',
    namespace: namespace('FIRST'),
    settingsPath: [],
    operations: { describeCredential, storeCredential: unexpected, removeCredential: unexpected, writeSettings: unexpected, discoverModels: unexpected },
    schema: {
      getPath: (value, path) => {
        expect(path.length).toBeLessThanOrEqual(1)
        return path.length === 0 ? value : (value as Record<string, unknown> | undefined)?.[path[0]!]
      },
      rehydrate: vi.fn(),
      nodeAtPath: vi.fn(() => ({ type: 'object', meta: {} }) as ReturnType<ProviderEditorProps['schema']['nodeAtPath']>),
      validate: vi.fn(),
      hasPath: vi.fn(),
      setPath: vi.fn(),
      deletePath: vi.fn(),
    },
    t: key => key,
    readOnly: false,
    credentialOnly: true,
    onClose: vi.fn(),
  }
  const view = render(<ProviderEditor {...props} />)
  const input = view.getByLabelText('keyInput') as HTMLInputElement
  await act(async () => {
    replies.get('FIRST')!({ configured: true, writable: false })
  })
  expect(input.disabled).toBe(true)
  props.namespace = namespace('SECOND')
  view.rerender(<ProviderEditor {...props} />)
  expect(input.disabled).toBe(false)
  expect(input.placeholder).toBe('keyPlaceholder')
  props.namespace = namespace('THIRD')
  view.rerender(<ProviderEditor {...props} />)
  await act(async () => {
    replies.get('SECOND')!({ configured: true, writable: false })
  })
  expect(input.disabled).toBe(false)
  await act(async () => {
    replies.get('THIRD')!({ configured: true, writable: true })
  })
  expect(input.placeholder).toBe('keyStored')
  expect(describeCredential.mock.calls).toEqual([['FIRST'], ['SECOND'], ['THIRD']])
})
