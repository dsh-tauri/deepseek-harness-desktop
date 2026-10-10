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
  ArrowUp: () => null,
  ArrowDown: () => null,
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

  it('moves a row up and down while its input keeps focus and its typed buffer', () => {
    const view = mount([{ id: 'first' }, { id: 'second' }, { id: 'third' }])
    const input = view.getByRole('textbox', { name: 'modelId 3' }) as HTMLInputElement
    input.focus()
    fireEvent.change(input, { target: { value: 'typed' } })

    fireEvent.click(view.getByRole('button', { name: 'moveUp 3' }))
    expect(view.getByRole('textbox', { name: 'modelId 2' }), '上移后必须落到上一行').toBe(input)
    expect(document.activeElement, '移动不得把焦点丢给别的行').toBe(input)
    expect(input.value, '移动不得丢掉行内已输入的内容').toBe('typed')
    expect(
      (view.getByRole('textbox', { name: 'modelId 1' }) as HTMLInputElement).value,
      '被让位的行必须整体下移，内容不受影响',
    ).toBe('first')

    fireEvent.click(view.getByRole('button', { name: 'moveDown 2' }))
    expect(view.getByRole('textbox', { name: 'modelId 3' })).toBe(input)
    expect(input.value).toBe('typed')
    expect((view.getByRole('textbox', { name: 'modelId 2' }) as HTMLInputElement).value).toBe('second')
  })

  it('keeps the edited input focused through a real pointer press on the move button', () => {
    const view = mount([{ id: 'first' }, { id: 'second' }, { id: 'third' }])
    const input = view.getByRole('textbox', { name: 'modelId 3' }) as HTMLInputElement
    input.focus()
    fireEvent.change(input, { target: { value: 'typed' } })

    const button = view.getByRole('button', { name: 'moveUp 3' })
    // 真实指针路径：按下（浏览器会尝试把焦点交给按钮）→ 抬起 → 点击。
    fireEvent.mouseDown(button)
    expect(document.activeElement, '按下不得把焦点从输入框抢到按钮上').toBe(input)
    fireEvent.mouseUp(button)
    fireEvent.click(button)

    expect(view.getByRole('textbox', { name: 'modelId 2' }), '移动后输入框必须还在焦点上').toBe(input)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('typed')
  })

  it('disables the move buttons on the first and last row', () => {
    const view = mount([{ id: 'first' }, { id: 'second' }])
    const disabled = (name: string): boolean =>
      (view.getByRole('button', { name }) as HTMLButtonElement).disabled

    expect(disabled('moveUp 1'), '首行不能上移').toBe(true)
    expect(disabled('moveDown 1'), '首行可以下移').toBe(false)
    expect(disabled('moveUp 2'), '末行可以上移').toBe(false)
    expect(disabled('moveDown 2'), '末行不能下移').toBe(true)
  })
})
