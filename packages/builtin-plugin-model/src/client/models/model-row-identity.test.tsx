// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepSeekModelsEditor } from './DeepSeekModelsEditor'
import { ModelListEditor } from './ModelListEditor'

vi.mock('./styles.ts', () => ({ modelStyles: {} }))
vi.mock('dsh-tauri-ui/client', () => ({
  Plus: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
  TrashBin: () => null,
  Checkbox: () => null,
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
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

describe.each(['deepseek', 'pi-ai'] as const)('%s model row identity', (kind) => {
  function mount(models: Record<string, unknown>[]) {
    function Editor() {
      const [rows, setRows] = useState(models)
      const unexpected = vi.fn(async () => {
        throw new Error('Unexpected remote operation')
      })
      const props = {
        models: rows,
        t: (key: string) => key,
        disabled: false,
        overridden: true,
        defaultContextWindow: undefined,
        defaultMaxTokens: undefined,
        onReset: vi.fn(),
        onBusyChange: vi.fn(),
        probe: { settingsNs: 'llm-pi-ai' },
        operations: {
          describeCredential: unexpected,
          storeCredential: unexpected,
          removeCredential: unexpected,
          writeSettings: unexpected,
          discoverModels: unexpected,
        },
        onChange: setRows,
      }
      return kind === 'deepseek'
        ? <DeepSeekModelsEditor {...props} />
        : <ModelListEditor {...props} />
    }
    return render(<Editor />)
  }

  it('keeps the edited input and its focus when its ID changes and a preceding row is removed', () => {
    const view = mount([{ id: 'first' }, { id: 'second' }])
    const input = view.getByRole('textbox', { name: 'modelId 2' }) as HTMLInputElement
    input.focus()
    fireEvent.change(input, { target: { value: 'renamed' } })
    expect(view.getByRole('textbox', { name: 'modelId 2' })).toBe(input)
    expect(document.activeElement).toBe(input)
    fireEvent.click(view.getByRole('button', { name: 'removeModel 1' }))
    expect(view.getByRole('textbox', { name: 'modelId 1' })).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('renamed')
  })

  it('keeps duplicate blank drafts distinct when a row is removed or added', () => {
    const view = mount([{ id: '' }, { id: '' }])
    const remaining = view.getByRole('textbox', { name: 'modelId 2' })
    fireEvent.click(view.getByRole('button', { name: 'removeModel 1' }))
    expect(view.getByRole('textbox', { name: 'modelId 1' })).toBe(remaining)
    fireEvent.click(view.getByRole('button', { name: 'addModel' }))
    expect(view.getByRole('textbox', { name: 'modelId 1' })).toBe(remaining)
    expect(view.getByRole('textbox', { name: 'modelId 2' })).not.toBe(remaining)
  })
})
