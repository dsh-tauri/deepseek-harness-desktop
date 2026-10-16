// @vitest-environment jsdom
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { PetActionResult } from '../service/pet.types'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PET_DEFAULT_SIZE } from '../constants'
import { locale } from '../locales'
import * as petService from '../service/pet'
import { store } from '../store'
import { PetSettings } from './pet-settings'

vi.mock('dsh-tauri/client', async () => ({
  ...await import('../../../../dsh-tauri/src/client/modules/valtio-define.ts'),
  ...await import('../../../../dsh-tauri/src/client/locale/index.ts'),
  ...await import('@reause/core'),
  ...await import('tailwind-variants'),
}))

vi.mock('dsh-tauri-ui/client', () => ({
  ArrowRightFromSquare: () => null,
  Globe: () => null,
  Plus: () => null,
  Icon: () => null,
  Checkbox: ({ checked, disabled, children, onChange }: { checked: boolean, disabled: boolean, children: ReactNode, onChange: (next: boolean) => void }) => (
    <label>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      {children}
    </label>
  ),
  Button: ({ variant: _variant, size: _size, icon: _icon, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string, size?: string, icon?: ReactNode }) => <button {...props} />,
  SegmentedControl: ({ value, onChange }: { value: string, onChange: (value: string) => void }) => (
    <div>
      {['pets', 'codex'].map(tab => <button key={tab} aria-pressed={value === tab} onClick={() => onChange(tab)}>{tab}</button>)}
    </div>
  ),
  Switch: ({ checked, label, onChange }: { checked: boolean, label: string, onChange: (next: boolean) => void }) => (
    <button role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>{label}</button>
  ),
}))

vi.mock('../service/pet', () => ({
  choosePet: vi.fn(),
  clearPetSelection: vi.fn(),
  enablePet: vi.fn(),
  importPetArchive: vi.fn(),
  loadForceXwayland: vi.fn(),
  loadPetCatalog: vi.fn(),
  loadPetOverlaySupported: vi.fn(),
  openCommunityShare: vi.fn(),
  resizePet: vi.fn(),
  setPetDragProbability: vi.fn(),
  toggleForceXwayland: vi.fn(),
  togglePet: vi.fn(),
  togglePetThrow: vi.fn(),
  togglePetAutonomy: vi.fn(),
  togglePetInteraction: vi.fn(),
}))

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function deferred() {
  let resolve!: (value: PetActionResult) => void
  const promise = new Promise<PetActionResult>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function button(text: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll('button')).find(item => item.textContent === text)
  if (!result)
    throw new Error(`Missing button ${text}`)
  return result
}

function card(name: string): HTMLDivElement {
  const result = Array.from(container.querySelectorAll('div')).find(item => item.querySelector(':scope > span > span > span')?.textContent === name)
  if (!(result instanceof HTMLDivElement))
    throw new Error(`Missing card ${name}`)
  return result
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.click()
  })
}

async function mount(onCreate = vi.fn().mockResolvedValue({ ok: true }), close = vi.fn()): Promise<void> {
  await act(async () => {
    root.render(<PetSettings onCreate={onCreate} close={close} />)
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.resetAllMocks()
  Object.assign(store.pet.$state, {
    status: { active_pet: 'chat', enabled: false, visible: false, throw_enabled: false },
    fetchRevision: 0,
    catalogLoaded: true,
    presetPets: [{ id: 'preset', name: 'Preset', desc: 'Preset description', image: 'preset.gif' }],
    chatPets: [{ id: 'chat', name: 'Chat', source: 'chat', description: 'Chat description', thumbnail: 'chat.png' }],
    codexPets: [{ id: 'codex', name: 'Codex', source: 'codex', thumbnail: 'codex.png' }],
    prefills: {},
    overlaySupported: false,
    forceXwayland: false,
  })
  for (const action of [petService.loadPetCatalog, petService.choosePet, petService.clearPetSelection, petService.enablePet, petService.togglePet, petService.toggleForceXwayland, petService.resizePet, petService.togglePetThrow, petService.importPetArchive, petService.openCommunityShare])
    vi.mocked(action).mockResolvedValue({ ok: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('pet settings action boundaries', () => {
  it.each(['resize', 'move'] as const)('changes only the %s selection and preserves choices across the master switch', async (kind) => {
    const status = { active_pet: 'chat', enabled: true, visible: true, throw_enabled: false, autonomy_supported: true, autonomy_enabled: true, resize_enabled: true, move_enabled: true }
    store.pet.setStatus(status)
    vi.mocked(petService.togglePetInteraction).mockImplementation(async (input) => {
      store.pet.setStatus({ ...store.pet.$state.status!, [`${input.kind}_enabled`]: input.enabled })
      return { ok: true }
    })
    await mount()
    const index = kind === 'resize' ? 0 : 1
    const choices = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[type=checkbox]'))
    expect(choices().map(input => input.checked)).toEqual([true, true])
    await click(choices()[index]!)
    expect(petService.togglePetInteraction).toHaveBeenCalledExactlyOnceWith({ kind, enabled: false })
    const expected = kind === 'resize' ? [false, true] : [true, false]
    expect(choices().map(input => input.checked)).toEqual(expected)
    await act(async () => {
      store.pet.setStatus({ ...store.pet.$state.status!, autonomy_enabled: false })
    })
    expect(choices()).toHaveLength(0)
    await act(async () => {
      store.pet.setStatus({ ...store.pet.$state.status!, autonomy_enabled: true })
    })
    expect(choices().map(input => input.checked)).toEqual(expected)
  })

  it('disables both interaction choices during saving and retains them on failure', async () => {
    store.pet.setStatus({ active_pet: 'chat', enabled: true, visible: true, throw_enabled: false, autonomy_supported: true, autonomy_enabled: true, resize_enabled: true, move_enabled: false })
    const pending = deferred()
    vi.mocked(petService.togglePetInteraction).mockReturnValue(pending.promise)
    await mount()
    const choices = Array.from(container.querySelectorAll<HTMLInputElement>('input[type=checkbox]'))
    await click(choices[0]!)
    expect(choices.map(input => input.disabled)).toEqual([true, true])
    await click(choices[1]!)
    expect(petService.togglePetInteraction).toHaveBeenCalledTimes(1)
    await act(async () => {
      pending.resolve({ ok: false, error: 'save failed' })
    })
    expect(choices.map(input => input.checked)).toEqual([true, false])
    expect(choices.map(input => input.disabled)).toEqual([false, false])
    expect(container.textContent).toContain(locale.text('interactionFailed'))
  })

  it('renders preset images separately from identical Chat/Codex spritesheet cards and keeps active clear actions', async () => {
    await mount()
    expect(card('Preset').querySelector('img')?.parentElement).toBe(card('Preset'))
    expect(card('Preset').textContent).toContain('Preset description')
    expect(card('Preset').querySelector('button')?.textContent).toBe(locale.text('enable'))
    expect(card('Chat').querySelector('img')?.parentElement?.tagName).toBe('SPAN')
    expect(card('Chat').textContent).toContain('Chat description')
    expect(card('Chat').querySelector('button')?.textContent).toBe(locale.text('clear'))
    await click(card('Chat').querySelector('button')!)
    expect(petService.clearPetSelection).toHaveBeenCalledExactlyOnceWith()
    expect(petService.choosePet).not.toHaveBeenCalled()
    await click(button('codex'))
    expect(card('Codex').querySelector('img')?.parentElement?.tagName).toBe('SPAN')
    expect(card('Codex').querySelector('button')?.textContent).toBe(locale.text('select'))
    await click(card('Codex').querySelector('button')!)
    expect(petService.choosePet).toHaveBeenCalledExactlyOnceWith({ id: 'codex' })
  })

  it.each([
    { kind: 'preset', errorKey: 'setPetFailed', mock: 'enablePet' },
    { kind: 'chat', errorKey: 'clearFailed', mock: 'clearPetSelection' },
    { kind: 'codex', errorKey: 'setPetFailed', mock: 'choosePet' },
    { kind: 'toggle', errorKey: 'toggleFailed', mock: 'togglePet' },
    { kind: 'xwayland', errorKey: 'xwaylandFailed', mock: 'toggleForceXwayland' },
  ] as const)('$kind disables actions while pending, releases busy on failure and shows its own error', async ({ kind, errorKey, mock }) => {
    const pending = deferred()
    vi.mocked(petService[mock]).mockReturnValueOnce(pending.promise)
    await mount()
    if (kind === 'codex')
      await click(button('codex'))
    const action = kind === 'preset'
      ? card('Preset').querySelector('button')!
      : kind === 'chat'
        ? card('Chat').querySelector('button')!
        : kind === 'codex'
          ? card('Codex').querySelector('button')!
          : button(locale.text(kind === 'toggle' ? 'enablePet' : 'xwaylandEnable'))
    await click(action)
    expect(action.disabled).toBe(true)
    const calls = vi.mocked(petService[mock]).mock.calls.length
    await click(action)
    expect(vi.mocked(petService[mock])).toHaveBeenCalledTimes(calls)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('input[type="range"]')?.hasAttribute('disabled')).toBe(false)
    await act(async () => {
      pending.resolve({ ok: false, error: 'native failure' })
    })
    expect(action.disabled).toBe(false)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(locale.text(errorKey))
    expect(container.textContent).not.toContain(locale.text('xwaylandRestart'))
    await click(action)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(action.disabled).toBe(false)
  })

  it('global toggles preserve boolean arguments and show restart only after XWayland success', async () => {
    await mount()
    await click(button(locale.text('enablePet')))
    expect(petService.togglePet).toHaveBeenCalledExactlyOnceWith({ enabled: true })
    await click(button(locale.text('xwaylandEnable')))
    expect(petService.toggleForceXwayland).toHaveBeenCalledExactlyOnceWith({ enabled: true })
    expect(container.textContent).toContain(locale.text('xwaylandRestart'))
  })

  it('throw switch defaults off, sends the flipped value and follows the authoritative status', async () => {
    await mount()
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(toggle.textContent).toBe(locale.text('throwLabel'))
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await click(toggle)
    expect(petService.togglePetThrow).toHaveBeenCalledExactlyOnceWith({ enabled: true })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await act(async () => {
      store.pet.setStatus({ active_pet: 'chat', enabled: false, visible: false, throw_enabled: true })
    })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await click(toggle)
    expect(petService.togglePetThrow).toHaveBeenLastCalledWith({ enabled: false })
  })

  it('throw switch shows its own failure without flipping the local state', async () => {
    vi.mocked(petService.togglePetThrow).mockResolvedValueOnce({ ok: false, error: 'native failure' })
    await mount()
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!
    await click(toggle)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(locale.text('throwFailed'))
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await click(toggle)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('default size remains interactive during other busy actions and sends each changed value', async () => {
    const pending = deferred()
    vi.mocked(petService.togglePet).mockReturnValueOnce(pending.promise)
    vi.mocked(petService.resizePet).mockResolvedValueOnce({ ok: false, error: 'bad size' })
    await mount()
    const slider = container.querySelector<HTMLInputElement>('input[type="range"]')!
    expect(slider.value).toBe(String(PET_DEFAULT_SIZE))
    await click(button(locale.text('enablePet')))
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '160')
      slider.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(petService.resizePet).toHaveBeenCalledExactlyOnceWith({ size: 160 })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(locale.text('setSizeFailed'))
    expect(button(locale.text('enablePet')).disabled).toBe(true)
    await act(async () => {
      pending.resolve({ ok: true })
    })
  })

  it('create forwards the close callback and keeps busy on success but releases it on failure', async () => {
    const close = vi.fn()
    const pending = deferred()
    const onCreate = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ ok: true })
    await mount(onCreate, close)
    await click(button(locale.text('create')))
    expect(onCreate).toHaveBeenCalledExactlyOnceWith(close)
    expect(button(locale.text('create')).disabled).toBe(true)
    await act(async () => {
      pending.resolve({ ok: false, error: 'no session' })
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(locale.text('createFailed'))
    expect(button(locale.text('create')).disabled).toBe(false)
    await click(button(locale.text('create')))
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(button(locale.text('create')).disabled).toBe(true)
  })

  it('catalog failure releases initial busy and only lazy-loads unknown environment flags', async () => {
    Object.assign(store.pet.$state, { catalogLoaded: false, overlaySupported: null, forceXwayland: null })
    vi.mocked(petService.loadPetCatalog).mockResolvedValue({ ok: false, error: 'catalog failed' })
    await mount()
    expect(petService.loadPetCatalog).toHaveBeenCalledExactlyOnceWith()
    expect(petService.loadPetOverlaySupported).toHaveBeenCalledExactlyOnceWith()
    expect(petService.loadForceXwayland).toHaveBeenCalledExactlyOnceWith()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(locale.text('listFailed'))
    expect(button(locale.text('create')).disabled).toBe(false)
  })

  it('import keeps name/base64 arguments and restores busy after a failed native result', async () => {
    vi.mocked(petService.importPetArchive).mockResolvedValue({ ok: false, error: 'bad archive' })
    await mount()
    await click(button('codex'))
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File(['pet'], 'pet.zip', { type: 'application/zip' })] })
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
      Object.defineProperty(this, 'result', { value: 'data:application/zip;base64,cGV0' })
      this.dispatchEvent(new ProgressEvent('load'))
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(petService.importPetArchive).toHaveBeenCalledExactlyOnceWith({ name: 'pet.zip', data: 'cGV0' })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(locale.text('importFailed'))
    expect(input.disabled).toBe(false)
    expect(input.value).toBe('')
  })

  it('community share sits in the Codex tab, opens the site and reports its own failure', async () => {
    vi.mocked(petService.openCommunityShare).mockResolvedValueOnce({ ok: false, error: 'no browser' })
    await mount()
    expect(container.textContent).not.toContain(locale.text('communityShare'))
    await click(button('codex'))
    await click(button(locale.text('communityShare')))
    expect(petService.openCommunityShare).toHaveBeenCalledExactlyOnceWith()
    expect(petService.importPetArchive).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(locale.text('communityShareFailed'))
    await click(button(locale.text('communityShare')))
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('autonomous window interaction', () => {
  it('only shows the switch when the native host supports window interaction', async () => {
    await mount()
    expect(container.textContent).not.toContain(locale.text('autonomyLabel'))
    await act(async () => {
      store.pet.setStatus({ active_pet: 'chat', enabled: true, visible: true, throw_enabled: false, autonomy_supported: true, autonomy_enabled: false })
    })
    expect(button(locale.text('autonomyLabel')).getAttribute('aria-checked')).toBe('false')
  })

  it('sends the enabled value and shows native errors without pretending the switch succeeded', async () => {
    store.pet.setStatus({ active_pet: 'chat', enabled: true, visible: true, throw_enabled: false, autonomy_supported: true, autonomy_enabled: false })
    vi.mocked(petService.togglePetAutonomy).mockResolvedValue({ ok: false, error: 'native error' })
    await mount()
    await click(button(locale.text('autonomyLabel')))
    expect(petService.togglePetAutonomy).toHaveBeenCalledWith({ enabled: true })
    expect(button(locale.text('autonomyLabel')).getAttribute('aria-checked')).toBe('false')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(locale.text('autonomyFailed'))
  })
})

describe('drag probability slider', () => {
  function slider(): HTMLInputElement {
    const result = container.querySelector<HTMLInputElement>('input[type="range"][max="100"]')
    if (!result)
      throw new Error('Missing drag probability slider')
    return result
  }

  async function change(value: number): Promise<void> {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider(), String(value))
      slider().dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  it('hides probability controls while autonomy is off and restores the saved value when enabled', async () => {
    await mount()
    expect(container.querySelector('input[max="100"]')).toBeNull()
    await act(async () => {
      store.pet.setStatus({ active_pet: 'chat', enabled: true, visible: true, throw_enabled: false, autonomy_supported: true, autonomy_enabled: false, drag_probability: 35 })
    })
    expect(container.querySelector('input[max="100"]')).toBeNull()
    expect(container.textContent).not.toContain(locale.text('dragProbabilityLabel'))
    expect(container.textContent).not.toContain(locale.text('dragProbabilityHint'))
    await act(async () => {
      store.pet.setStatus({ ...store.pet.$state.status!, autonomy_enabled: true })
    })
    expect(slider().disabled).toBe(false)
    expect(slider().value).toBe('35')
    expect(container.querySelector('output')?.textContent).toBe('35%')
    await act(async () => {
      store.pet.setStatus({ ...store.pet.$state.status!, autonomy_enabled: false })
    })
    expect(container.querySelector('input[max="100"]')).toBeNull()
    expect(container.querySelector('output')).toBeNull()
    expect(petService.setPetDragProbability).not.toHaveBeenCalled()
  })

  it.each(['pointerup', 'keyup', 'focusout'])('previews changes and saves on %s, restoring the saved value on failure', async (eventType) => {
    store.pet.setStatus({ active_pet: 'chat', enabled: true, visible: true, throw_enabled: false, autonomy_supported: true, autonomy_enabled: true, drag_probability: 35 })
    vi.mocked(petService.setPetDragProbability).mockResolvedValue({ ok: false, error: 'save failed' })
    await mount()
    await change(60)
    expect(container.querySelector('output')?.textContent).toBe('60%')
    expect(petService.setPetDragProbability).not.toHaveBeenCalled()
    await act(async () => {
      slider().dispatchEvent(new Event(eventType, { bubbles: true }))
    })
    expect(petService.setPetDragProbability).toHaveBeenCalledExactlyOnceWith({ probability: 60 })
    expect(slider().value).toBe('35')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(locale.text('dragProbabilityFailed'))
  })

  it.each([0, 100])('saves %s percent and displays the persisted result after remounting', async (probability) => {
    const status = { active_pet: 'chat', enabled: true, visible: true, throw_enabled: false, autonomy_supported: true, autonomy_enabled: true, drag_probability: 35 }
    store.pet.setStatus(status)
    vi.mocked(petService.setPetDragProbability).mockImplementation(async (input) => {
      store.pet.setStatus({ ...status, drag_probability: input.probability })
      return { ok: true }
    })
    await mount()
    await change(probability)
    await act(async () => {
      slider().dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    expect(petService.setPetDragProbability).toHaveBeenCalledExactlyOnceWith({ probability })
    await act(async () => {
      root.render(null)
    })
    await mount()
    expect(slider().value).toBe(String(probability))
    expect(container.querySelector('output')?.textContent).toBe(`${probability}%`)
  })
})
