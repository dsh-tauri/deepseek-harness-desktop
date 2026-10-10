// @vitest-environment jsdom
import type { SessionId, SessionListState } from 'dsh-tauri/client'
import type { KernelBinding } from '../../shared/types'
import type { HeroKernelProps, SessionKernelHoverProps, SessionKernelProps } from './slot-contract'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useRef, useSyncExternalStore } from 'react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { kernelStore } from '../store/modules/kernel-store'
import { HeroKernel } from './hero-kernel'
import { SessionKernel } from './session-kernel'
import { SessionKernelHover } from './session-kernel-hover'

vi.hoisted(() => vi.stubGlobal('localStorage', undefined))

vi.mock('dsh-tauri-ui/client', async () => ({
  ...await import('../../../../dsh-tauri-ui/src/client/components/brand-icons'),
  ...await import('../../../../dsh-tauri-ui/src/client/components/chip'),
  ...await import('../../../../dsh-tauri-ui/src/client/components/icons'),
  ...await import('../../../../dsh-tauri-ui/src/client/components/official'),
}))

const IDENTITY: KernelBinding = { backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' }

function heroProps(options: { identity?: KernelBinding | null, sessionId?: string, workspaceId?: string, cwd?: string, canCreate?: boolean } = {}): HeroKernelProps {
  const sessionId = options.sessionId
  const summary = { id: sessionId, blank: true, cwd: options.cwd, projectionValues: { agentPreset: 'coding' } }
  const workspace = { workspaceId: options.workspaceId, sessionIds: [sessionId], path: '/project' }
  return {
    sessionId,
    useProjection: () => useRef(options.identity).current,
    useSessions: (selector: (state: unknown) => unknown) => selector(useRef({ byId: sessionId === undefined ? {} : { [sessionId]: summary }, projectionsBySession: {} }).current),
    useWorkspaces: (selector: (state: unknown) => unknown) => selector(useRef({ items: options.workspaceId === undefined ? [] : [workspace] }).current),
    ensureProjection: vi.fn(async () => {}),
    canCreate: () => options.canCreate ?? true,
    createSession: vi.fn(async () => {}),
    refreshBackends: vi.fn(async () => {}),
  } as unknown as HeroKernelProps
}

function sidebarProps(identity: KernelBinding | null | undefined): SessionKernelProps & SessionKernelHoverProps {
  return {
    sessionId: 'session-a',
    ensureProjection: vi.fn(async () => {}),
    useSessions: (selector: (state: unknown) => unknown) => selector(useRef({ byId: {}, projectionsBySession: { 'session-a': { values: { bridgeKernel: identity } } } }).current),
  } as unknown as SessionKernelProps & SessionKernelHoverProps
}

beforeEach(() => {
  kernelStore.$patch({
    phase: 'ready',
    error: null,
    backends: [
      { id: 'dsh', installed: true, auth: 'ok', version: '0.2.1-alpha.2', drift: false, hint: null },
      { id: 'codex', installed: true, auth: 'ok', version: '1.0', drift: false, hint: null },
      { id: 'claude', installed: false, auth: 'unknown', version: null, drift: false, hint: null },
    ],
  })
})

afterEach(() => {
  cleanup()
  kernelStore.$patch({ backends: [], phase: 'idle', error: null })
  vi.restoreAllMocks()
})

afterAll(() => vi.unstubAllGlobals())

describe('hero kernel picker', () => {
  it('starts unselected with the two native kernels and no persisted default', () => {
    const props = heroProps()
    const view = render(<HeroKernel {...props} />)
    const chip = view.getByRole('button', { name: 'Kernel' })
    expect(chip.textContent).toContain('Select kernel')
    expect((chip as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(chip)
    expect(view.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Codex', 'Claude · Not installed'])
    expect(view.getByRole('menu').querySelectorAll('[aria-checked="true"]')).toHaveLength(0)
  })

  it('a session without a native binding stays unselected instead of showing the official kernel', () => {
    const view = render(<HeroKernel {...heroProps({ sessionId: 'session-a', identity: null })} />)
    const chip = view.getByRole('button', { name: 'Kernel' })
    expect(chip.textContent).toContain('Select kernel')
    expect((chip as HTMLButtonElement).disabled).toBe(false)
    expect(view.queryByRole('button', { name: 'Clear kernel selection' })).toBeNull()
  })

  it('shows the arrow by default and swaps it for the clear icon on hover', () => {
    const view = render(<HeroKernel {...heroProps({ sessionId: 'session-a', identity: IDENTITY })} />)
    const pill = view.container.querySelector('[data-bridge-kernel-pill]')
    const clear = view.getByRole('button', { name: 'Clear kernel selection' })
    expect(pill?.className).toContain('group')
    expect(pill?.querySelector('[data-bridge-kernel-chevron]')?.className).toContain('group-hover:hidden')
    const clearIcon = pill?.querySelector('[data-bridge-kernel-clear-icon]')
    expect(clearIcon?.className).toContain('hidden')
    expect(clearIcon?.className).toContain('group-hover:inline-flex')
    expect(clearIcon?.className).toContain('group-focus-visible:inline-flex')
    expect(clear.querySelectorAll('svg')).toHaveLength(2)
  })

  it('a bound native session returns to dsh through the clear affordance', async () => {
    const props = heroProps({ sessionId: 'session-a', identity: IDENTITY, workspaceId: 'workspace-a' })
    const view = render(<HeroKernel {...props} />)
    expect(view.getByRole('button', { name: 'Kernel' }).textContent).toContain('Codex')
    const clear = view.getByRole('button', { name: 'Clear kernel selection' })
    const pill = view.container.querySelector('[data-bridge-kernel-pill]')!
    expect(pill.contains(view.getByRole('button', { name: 'Kernel' }))).toBe(true)
    expect(pill.contains(clear)).toBe(true)
    fireEvent.click(clear)
    await vi.waitFor(() => expect(props.createSession).toHaveBeenCalledWith('dsh', { workspaceId: 'workspace-a' }, 'coding'))
    expect(view.queryByRole('menu')).toBeNull()
  })

  it('mounts no content when the detected runtime predates the bridge baseline', () => {
    kernelStore.$patch({ backends: kernelStore.$state.backends.map(item => item.id === 'dsh' ? { ...item, version: '0.2.1-alpha.1' } : item) })
    const view = render(<HeroKernel {...heroProps()} />)
    expect(view.container.childElementCount).toBe(0)
  })

  it('mounts no content when an unreadable runtime version has no capable kernel either', () => {
    kernelStore.$patch({
      backends: [
        { id: 'dsh', installed: true, auth: 'ok', version: null, drift: false, hint: null },
        { id: 'codex', installed: true, auth: 'ok', version: '1.0', drift: false, hint: null, bridgeReady: false },
      ],
    })
    const view = render(<HeroKernel {...heroProps()} />)
    expect(view.container.childElementCount).toBe(0)
  })

  it('an unread session identity stays pending and disabled until its projection arrives', async () => {
    const props = heroProps({ sessionId: 'session-a' })
    const view = render(<HeroKernel {...props} />)
    const chip = view.getByRole('button', { name: 'Kernel' }) as HTMLButtonElement
    expect(chip.textContent).toContain('Reading session kernel')
    expect(chip.disabled).toBe(true)
    await vi.waitFor(() => expect(props.ensureProjection).toHaveBeenCalledWith('session-a'))
    expect(props.createSession).not.toHaveBeenCalled()
  })

  it('a bound identity is shown in the Chip inside the official Menu anchor', () => {
    const view = render(<HeroKernel {...heroProps({ sessionId: 'session-a', identity: IDENTITY })} />)
    const chip = view.getByRole('button', { name: 'Kernel' })
    expect(chip.textContent).toContain('Codex')
    expect(chip.parentElement?.tagName).toBe('SPAN')
    expect(chip.getAttribute('title')).toContain('official new-session shortcuts')
    expect(chip.getAttribute('title')).toContain('its kernel cannot be changed')
    expect(chip.getAttribute('title')).not.toContain('model and kernel cannot be changed')
    fireEvent.click(chip)
    expect(view.getByRole('menu').querySelectorAll('button')).toHaveLength(2)
    expect((view.getByRole('menuitem', { name: 'Claude · Not installed' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('workspace creation passes only workspaceId and preserves the current agent preset', async () => {
    const props = heroProps({ sessionId: 'session-a', identity: null, workspaceId: 'workspace-a', cwd: '/project' })
    const view = render(<HeroKernel {...props} />)
    fireEvent.click(view.getByRole('button', { name: 'Kernel' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Codex' }))
    await vi.waitFor(() => expect(props.createSession).toHaveBeenCalledWith('codex', { workspaceId: 'workspace-a' }, 'coding'))
    await vi.waitFor(() => expect(view.queryByRole('menu')).toBeNull())
  })

  it('ungrouped creation passes only cwd and uninstalled choices cannot create', async () => {
    const props = heroProps({ sessionId: 'session-a', identity: null, cwd: '/ungrouped' })
    const view = render(<HeroKernel {...props} />)
    fireEvent.click(view.getByRole('button', { name: 'Kernel' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Claude · Not installed' }))
    expect(props.createSession).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('menuitem', { name: 'Codex' }))
    await vi.waitFor(() => expect(props.createSession).toHaveBeenCalledWith('codex', { cwd: '/ungrouped' }, 'coding'))
  })

  it.each([
    { patch: { auth: 'missing' as const }, hint: 'Not signed in' },
    { patch: { drift: true }, hint: 'Incompatible protocol' },
  ])('an unavailable native choice shows $hint and cannot invoke creation', ({ patch, hint }) => {
    kernelStore.$patch({ backends: kernelStore.$state.backends.map(item => item.id === 'codex' ? { ...item, ...patch } : item) })
    const props = heroProps({ sessionId: 'session-a', identity: null })
    const view = render(<HeroKernel {...props} />)
    fireEvent.click(view.getByRole('button', { name: 'Kernel' }))
    const choice = view.getByRole('menuitem', { name: `Codex · ${hint}` }) as HTMLButtonElement
    expect(choice.disabled).toBe(true)
    fireEvent.click(choice)
    expect(props.createSession).not.toHaveBeenCalled()
  })

  it.each([
    { patch: { installed: false, bridgeReady: true }, hint: 'BRIDGE_EXECUTABLE_MISSING: Install Codex and check PATH', label: 'Codex · Not installed', disabled: true },
    { patch: { installed: false, bridgeReady: false }, hint: 'BRIDGE_CORE_UNAVAILABLE: Official plugin records are unavailable', label: 'Codex · Not installed', disabled: true },
    { patch: { installed: true, bridgeReady: false, version: '0.162.0' }, hint: 'BRIDGE_CORE_UNAVAILABLE: Official plugin records are unavailable', label: 'Codex · Bridge unavailable', disabled: true },
    { patch: { auth: 'unknown' as const, bridgeReady: true }, hint: 'BRIDGE_AUTH_UNKNOWN: Run codex login status', label: 'Codex', disabled: false },
    { patch: { auth: 'missing' as const, bridgeReady: true }, hint: 'BRIDGE_AUTH_MISSING: Run codex login', label: 'Codex · Not signed in', disabled: true },
    { patch: { drift: true, bridgeReady: true }, hint: 'BRIDGE_PROTOCOL: The native protocol does not match', label: 'Codex · Incompatible protocol', disabled: true },
    { patch: { bridgeReady: true }, hint: 'BRIDGE_PROBE_DETAIL: Verbose backend diagnostic', label: 'Codex', disabled: false },
  ])('the real Menu uses only the short backend status: $label', ({ patch, hint, label, disabled }) => {
    kernelStore.$patch({ backends: kernelStore.$state.backends.map(item => item.id === 'codex' ? { ...item, ...patch, hint } : item) })
    const props = heroProps({ sessionId: 'session-a', identity: null })
    const view = render(<HeroKernel {...props} />)
    fireEvent.click(view.getByRole('button', { name: 'Kernel' }))
    const choice = view.getByRole('menuitem', { name: label }) as HTMLButtonElement
    expect(choice.disabled).toBe(disabled)
    expect(view.queryByText(hint, { exact: false })).toBeNull()
    if (disabled) {
      fireEvent.click(choice)
      expect(props.createSession).not.toHaveBeenCalled()
    }
  })

  it('the sessionless picker starts unselected and reads no session projection', () => {
    const props = heroProps()
    const view = render(<HeroKernel {...props} />)
    const chip = view.getByRole('button', { name: 'Kernel' }) as HTMLButtonElement
    expect(chip.textContent).toContain('Select kernel')
    expect(chip.disabled).toBe(false)
    expect(props.ensureProjection).not.toHaveBeenCalled()
  })

  it('creation failure stays on the current identity and presents an inline error', async () => {
    const props = heroProps({ sessionId: 'session-a', identity: null })
    vi.mocked(props.createSession).mockRejectedValue(new Error('native create refused'))
    const view = render(<HeroKernel {...props} />)
    fireEvent.click(view.getByRole('button', { name: 'Kernel' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Codex' }))
    await vi.waitFor(() => expect(view.getByRole('alert').textContent).toContain('native create refused'))
    expect(view.getByRole('button', { name: 'Kernel' }).textContent).toContain('Select kernel')
  })

  it('busy creation disables further selection until it settles', async () => {
    const props = heroProps({ sessionId: 'session-a', identity: null })
    let finish: (() => void) | undefined
    vi.mocked(props.createSession).mockImplementation(() => new Promise<void>((resolve) => {
      finish = resolve
    }))
    const view = render(<HeroKernel {...props} />)
    fireEvent.click(view.getByRole('button', { name: 'Kernel' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Codex' }))
    expect((view.getByRole('button', { name: 'Kernel' }) as HTMLButtonElement).disabled).toBe(true)
    expect((view.getByRole('menuitem', { name: 'Codex' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(view.getByRole('menuitem', { name: 'Codex' }))
    expect(props.createSession).toHaveBeenCalledOnce()
    if (finish === undefined)
      throw new Error('creation promise was not started')
    await act(async () => finish?.())
    expect(view.queryByRole('menu')).toBeNull()
  })

  it('official Menu keyboard entry and Escape return focus to the Chip anchor', async () => {
    kernelStore.$patch({ backends: kernelStore.$state.backends.map(item => item.id === 'claude' ? { ...item, installed: true, auth: 'ok' } : item) })
    const view = render(<HeroKernel {...heroProps({ sessionId: 'session-a', identity: null })} />)
    const chip = view.getByRole('button', { name: 'Kernel' })
    chip.focus()
    fireEvent.click(chip)
    fireEvent.keyDown(chip, { key: 'Tab' })
    expect(document.activeElement).toBe(view.getByRole('menuitem', { name: 'Codex' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(view.getByRole('menuitem', { name: 'Claude' }))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(view.getByRole('menuitem', { name: 'Claude' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await vi.waitFor(() => expect(view.queryByRole('menu')).toBeNull())
    expect(document.activeElement).toBe(chip)
  })
})

describe('sidebar kernel identity', () => {
  it('mounts no sidebar decoration when the detected runtime predates the bridge baseline', () => {
    kernelStore.$patch({ backends: kernelStore.$state.backends.map(item => item.id === 'dsh' ? { ...item, version: '0.2.0' } : item) })
    const kernel = render(<SessionKernel {...sidebarProps(IDENTITY)} />)
    expect(kernel.container.childElementCount).toBe(0)
    const hover = render(<SessionKernelHover {...sidebarProps(IDENTITY)} />)
    expect(hover.container.childElementCount).toBe(0)
  })

  it('codex uses a gray currentColor GPT icon with an accessible identity label', () => {
    const props = sidebarProps(IDENTITY)
    const view = render(<SessionKernel {...props} />)
    const identity = view.getByRole('img', { name: 'Codex Kernel' })
    expect(identity.className).toContain('text-tertiary')
    expect(identity.querySelector('svg')?.getAttribute('fill')).toBe('currentColor')
    expect(identity.querySelector('svg')?.getAttribute('width')).toBe('16')
    expect(identity.getAttribute('data-bridge-kernel')).toBe('codex')
    expect(props.ensureProjection).not.toHaveBeenCalled()
  })

  it('claude renders its own brand icon rather than the GPT path', () => {
    const view = render(<SessionKernel {...sidebarProps({ ...IDENTITY, backend: 'claude' })} />)
    expect(view.getByRole('img', { name: 'Claude Kernel' }).getAttribute('data-bridge-kernel')).toBe('claude')
    expect(view.container.querySelector('path')?.getAttribute('d')).toContain('M4.709 15.955')
  })

  it('deepseek identity has no extra leading brand decoration', () => {
    const view = render(<SessionKernel {...sidebarProps(null)} />)
    expect(view.queryByRole('img')).toBeNull()
  })

  it('unknown identity stays undecorated and requests only a nonactivating projection read', async () => {
    const props = sidebarProps(undefined)
    const view = render(<SessionKernel {...props} />)
    expect(view.queryByRole('img')).toBeNull()
    await vi.waitFor(() => expect(props.ensureProjection).toHaveBeenCalledWith('session-a'))
  })

  it('a cold cached identity follows a later live projection without retaining a session', async () => {
    const id = 'session-a' as SessionId
    let snapshot: SessionListState = {
      ids: [id],
      byId: {
        [id]: {
          id,
          displayTitle: 'Session A',
          running: false,
          retainedBy: {},
          blank: false,
          updatedAt: 0,
          projectionValues: { bridgeKernel: { backend: 'codex', nativeSessionId: 'native-a', sessionId: id } },
        },
      },
      projectionsBySession: {},
      phase: 'ready',
    }
    const listeners = new Set<() => void>()
    function subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
    const props = {
      sessionId: id,
      ensureProjection: vi.fn(async () => {}),
      useSessions: (selector: (state: SessionListState) => unknown) => selector(useSyncExternalStore(subscribe, () => snapshot)),
    } as unknown as SessionKernelProps
    const view = render(<SessionKernel {...props} />)
    expect(view.getByRole('img', { name: 'Codex Kernel' })).toBeTruthy()
    await act(async () => {
      snapshot = {
        ...snapshot,
        projectionsBySession: { [id]: { values: { bridgeKernel: { backend: 'claude', nativeSessionId: 'native-b', sessionId: id } }, state: 'ready', error: null } },
      }
      for (const listener of listeners)
        listener()
    })
    expect(view.getByRole('img', { name: 'Claude Kernel' })).toBeTruthy()
    expect(view.queryByRole('img', { name: 'Codex Kernel' })).toBeNull()
    await act(async () => {
      snapshot = { ...snapshot, projectionsBySession: { [id]: { values: { bridgeKernel: null }, state: 'ready', error: null } } }
      for (const listener of listeners)
        listener()
    })
    expect(view.queryByRole('img')).toBeNull()
    expect(props.ensureProjection).not.toHaveBeenCalled()
    view.unmount()
    expect(listeners.size).toBe(0)
  })

  it('the public hover fallback shows identity even when a leading seat is unavailable', () => {
    const view = render(<SessionKernelHover {...sidebarProps(IDENTITY)} />)
    expect(view.getByText('Kernel: Codex')).toBeTruthy()
    expect(view.container.querySelector('[data-bridge-kernel-hover]')?.getAttribute('data-bridge-kernel-hover')).toBe('codex')
    expect(view.container.querySelector('svg')?.getAttribute('fill')).toBe('currentColor')
  })

  it('an inherited native owner is named in hover but explicitly cannot resume that kernel', () => {
    const view = render(<SessionKernelHover {...sidebarProps({ ...IDENTITY, sessionId: 'parent-session' })} />)
    expect(view.getByText('Kernel: Codex')).toBeTruthy()
    expect(view.getByText('Forked sessions cannot resume the native kernel')).toBeTruthy()
  })
})
