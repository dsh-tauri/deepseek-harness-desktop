import type { ClientAdapter } from 'dsh-tauri/client'
import type { PetStatus } from './pet.types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PET_HATCH_PROMPT } from '../constants'
import { store } from '../store'
import {
  choosePet,
  clearPetSelection,
  createPetSession,
  enablePet,
  importPetArchive,
  loadForceXwayland,
  loadPetCatalog,
  loadPetOverlaySupported,
  loadPetStatus,
  openCommunityShare,
  resizePet,
  setPetDragProbability,
  toggleForceXwayland,
  togglePet,
  togglePetAutonomy,
  togglePetInteraction,
  togglePetThrow,
} from './pet'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('dsh-tauri/client', async () => ({
  ...await import('../../../../dsh-tauri/src/client/modules/valtio-define.ts'),
  invoke,
}))

const status: PetStatus = { active_pet: 'chat-a', enabled: true, visible: true, pet_size: 100, throw_enabled: true }

function adapter(): ClientAdapter {
  return {
    generation: 'modern',
    migrations: [],
    failures: [],
    ctx: {},
    sessions: { open: vi.fn(), list: { subscribe: vi.fn(), getSnapshot: () => ({ current: 'current' }) } },
    workspaces: {
      connectWorkspace: vi.fn().mockResolvedValue('new-session'),
      list: {
        subscribe: vi.fn(),
        getSnapshot: () => ({ items: [{ id: 'recent' }, { id: 'current-workspace', sessionIds: ['current'] }], recentWorkspaceId: 'recent' }),
      },
    },
    service: () => undefined,
    has: () => false,
    resolveStartSession: () => undefined,
    resolveOpenSession: () => undefined,
    sessionList: () => undefined,
    resolveAddWorkspace: () => undefined,
    startSession: async () => ({ status: 'unavailable', reason: 'unused' }),
    openSession: () => ({ status: 'unavailable', reason: 'unused' }),
    addWorkspace: async () => ({ status: 'unavailable', reason: 'unused' }),
  }
}

function resetStore(): void {
  Object.assign(store.pet.$state, {
    status: null,
    fetchRevision: 0,
    catalogLoaded: false,
    presetPets: [],
    chatPets: [],
    codexPets: [],
    prefills: {},
    overlaySupported: null,
    forceXwayland: null,
  })
}

beforeEach(() => {
  invoke.mockReset()
  resetStore()
})

afterEach(() => {
  resetStore()
  vi.restoreAllMocks()
})

describe('pet service native command contracts', () => {
  it('keeps interaction selections unchanged when native persistence fails', async () => {
    const previous = { ...status, resize_enabled: false, move_enabled: true }
    store.pet.setStatus(previous)
    invoke.mockRejectedValue(new Error('save failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await togglePetInteraction({ kind: 'move', enabled: false })).toEqual({ ok: false, error: 'save failed' })
    expect(store.pet.status).toEqual(previous)
  })

  it('catalog loads all four native queries and commits their exact lists', async () => {
    const chat = [{ id: 'chat-a', name: 'Chat', source: 'chat' }]
    const codex = [{ id: 'codex-a', name: 'Codex', source: 'codex' }]
    const presets = [{ id: 'builtin', name: 'Built in' }]
    invoke.mockResolvedValueOnce(status).mockResolvedValueOnce(chat).mockResolvedValueOnce(codex).mockResolvedValueOnce(presets)

    expect(await loadPetCatalog()).toEqual({ ok: true })
    expect(invoke.mock.calls).toEqual([
      ['get_pet_status'],
      ['list_pets', { source: 'chat' }],
      ['list_pets', { source: 'codex' }],
      ['list_preset_pets'],
    ])
    expect(store.pet.$state).toMatchObject({ status, catalogLoaded: true, chatPets: chat, codexPets: codex, presetPets: presets })
  })

  it('older status responses cannot replace a newer native action snapshot', async () => {
    let resolve!: (value: PetStatus) => void
    invoke.mockReturnValueOnce(new Promise<PetStatus>((done) => {
      resolve = done
    })).mockResolvedValueOnce(status)
    const pending = loadPetStatus()
    expect(await choosePet({ id: 'chat-a' })).toEqual({ ok: true })
    const stale = { ...status, active_pet: 'stale' }
    resolve(stale)
    expect(await pending).toEqual(stale)
    expect(store.pet.status).toEqual(status)
    expect(invoke.mock.calls).toEqual([['get_pet_status'], ['set_active_pet', { id: 'chat-a' }]])
  })

  it.each([
    { action: () => choosePet({ id: 'chosen' }), call: ['set_active_pet', { id: 'chosen' }] },
    { action: () => togglePet({ enabled: false }), call: ['set_pet_enabled', { enabled: false }] },
    { action: () => resizePet({ size: 160 }), call: ['set_pet_size', { size: 160 }] },
    { action: () => togglePetAutonomy({ enabled: true }), call: ['set_pet_autonomy_enabled', { enabled: true }] },
    { action: () => togglePetInteraction({ kind: 'resize', enabled: false }), call: ['set_pet_interaction_enabled', { kind: 'resize', enabled: false }] },
    { action: () => togglePetInteraction({ kind: 'move', enabled: true }), call: ['set_pet_interaction_enabled', { kind: 'move', enabled: true }] },
    { action: () => togglePetThrow({ enabled: true }), call: ['set_pet_throw_enabled', { enabled: true }] },
  ])('status action forwards $call and stores the authoritative result', async ({ action, call }) => {
    invoke.mockResolvedValue(status)
    expect(await action()).toEqual({ ok: true })
    expect(invoke.mock.calls).toEqual([call])
    expect(store.pet.status).toEqual(status)
  })

  it.each([true, false])('preset activation only enables the native window when enabled=%s is false', async (enabled) => {
    invoke.mockResolvedValueOnce({ ...status, enabled }).mockResolvedValueOnce(status)
    expect(await enablePet({ id: 'preset' })).toEqual({ ok: true })
    expect(invoke.mock.calls).toEqual(enabled
      ? [['set_active_pet', { id: 'preset' }]]
      : [['set_active_pet', { id: 'preset' }], ['set_pet_enabled', { enabled: true }]])
    expect(store.pet.status).toEqual(status)
  })

  it.each([true, false])('clearing selection disables first only when enabled=%s', async (enabled) => {
    store.pet.setStatus({ ...status, enabled })
    const cleared = { active_pet: '', enabled: false, visible: false }
    invoke.mockImplementation(async command => command === 'set_active_pet' ? cleared : { ...status, enabled: false })
    expect(await clearPetSelection()).toEqual({ ok: true })
    expect(invoke.mock.calls).toEqual(enabled
      ? [['set_pet_enabled', { enabled: false }], ['set_active_pet', { id: '' }]]
      : [['set_active_pet', { id: '' }]])
    expect(store.pet.status).toEqual(cleared)
  })

  it.each(['set_pet_enabled', 'set_active_pet'])('clear failure at %s reloads native status and preserves the original error', async (failingCommand) => {
    const error = new Error('native clear refused')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    store.pet.setStatus(status)
    invoke.mockImplementation(async (command) => {
      if (command === failingCommand)
        throw error
      return status
    })
    expect(await clearPetSelection()).toEqual({ ok: false, error: 'native clear refused' })
    expect(log).toHaveBeenCalledExactlyOnceWith('[dsh-tauri-pet] clear pet selection failed:', error)
    expect(invoke.mock.calls).toEqual(failingCommand === 'set_pet_enabled'
      ? [['set_pet_enabled', { enabled: false }], ['get_pet_status']]
      : [['set_pet_enabled', { enabled: false }], ['set_active_pet', { id: '' }], ['get_pet_status']])
    expect(store.pet.status).toEqual(status)
  })

  it('import forwards archive strings before refreshing only the Codex list', async () => {
    const codex = [{ id: 'imported', name: 'Imported', source: 'codex' }]
    invoke.mockResolvedValueOnce(codex[0]).mockResolvedValueOnce(codex)
    expect(await importPetArchive({ name: 'pet.zip', data: 'base64' })).toEqual({ ok: true })
    expect(invoke.mock.calls).toEqual([['import_pet', { name: 'pet.zip', data: 'base64' }], ['list_pets', { source: 'codex' }]])
    expect(store.pet.codexPets).toEqual(codex)
    expect(store.pet.catalogLoaded).toBe(false)
  })

  it('community share opens the Codex pets site through the external URL command', async () => {
    invoke.mockResolvedValue(undefined)
    expect(await openCommunityShare()).toEqual({ ok: true })
    expect(invoke.mock.calls).toEqual([['open_external_url', { url: 'https://codex-pets.net/#/' }]])
  })

  it('xWayland query and action retain native boolean results', async () => {
    invoke.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect(await loadForceXwayland()).toBe(true)
    expect(store.pet.forceXwayland).toBe(true)
    expect(await toggleForceXwayland({ enabled: false })).toEqual({ ok: true })
    expect(store.pet.forceXwayland).toBe(false)
    expect(invoke.mock.calls).toEqual([['get_force_xwayland'], ['set_force_xwayland', { enabled: false }]])
  })

  it('overlay query stores false without treating unsupported platforms as failures', async () => {
    invoke.mockResolvedValue(false)
    expect(await loadPetOverlaySupported()).toBe(false)
    expect(store.pet.overlaySupported).toBe(false)
    expect(invoke.mock.calls).toEqual([['get_pet_overlay_supported']])
  })

  it.each([
    { label: 'load pet catalog', action: loadPetCatalog },
    { label: 'choose pet', action: () => choosePet({ id: 'chosen' }) },
    { label: 'enable pet', action: () => enablePet({ id: 'chosen' }) },
    { label: 'toggle pet', action: () => togglePet({ enabled: true }) },
    { label: 'toggle force xwayland', action: () => toggleForceXwayland({ enabled: true }) },
    { label: 'toggle pet throw', action: () => togglePetThrow({ enabled: true }) },
    { label: 'resize pet', action: () => resizePet({ size: 140 }) },
    { label: 'import pet', action: () => importPetArchive({ name: 'bad.zip', data: 'bad' }) },
    { label: 'open community share', action: openCommunityShare },
  ])('$label preserves error messages and logging labels without changing cached values', async ({ label, action }) => {
    const error = new Error('native refused')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    store.pet.setStatus(status)
    invoke.mockRejectedValue(error)
    expect(await action()).toEqual({ ok: false, error: 'native refused' })
    expect(log).toHaveBeenCalledExactlyOnceWith(`[dsh-tauri-pet] ${label} failed:`, error)
    expect(store.pet.status).toEqual(status)
    expect(store.pet.catalogLoaded).toBe(false)
    expect(store.pet.forceXwayland).toBeNull()
  })

  it('guard stringifies non-Error native rejection', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    invoke.mockRejectedValue('native string')
    expect(await choosePet({ id: 'chosen' })).toEqual({ ok: false, error: 'native string' })
    expect(log).toHaveBeenCalledExactlyOnceWith('[dsh-tauri-pet] choose pet failed:', 'native string')
  })

  it.each([
    { label: 'load pet status', action: loadPetStatus },
    { label: 'load pet overlay support', action: loadPetOverlaySupported },
    { label: 'load force xwayland', action: loadForceXwayland },
  ])('$label failure returns null and retains its previous cache', async ({ label, action }) => {
    const error = new Error('read refused')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    store.pet.setStatus(status)
    store.pet.setOverlaySupported(false)
    store.pet.setForceXwayland(true)
    invoke.mockRejectedValue(error)
    expect(await action()).toBeNull()
    expect(log).toHaveBeenCalledExactlyOnceWith(`[dsh-tauri-pet] ${label} failed:`, error)
    expect(store.pet.$state).toMatchObject({ status, overlaySupported: false, forceXwayland: true })
  })
})

describe('pet session action contracts', () => {
  it('session creation uses the current workspace and prefills before closing and opening', async () => {
    const client = adapter()
    const order: string[] = []
    const close = vi.fn(() => {
      expect(store.pet.prefills).toEqual({ 'new-session': PET_HATCH_PROMPT })
      order.push('close')
    })
    client.sessions.open = vi.fn((id) => {
      expect(id).toBe('new-session')
      order.push('open')
    })
    expect(await createPetSession({ adapter: client, close })).toEqual({ ok: true })
    expect(client.workspaces.connectWorkspace).toHaveBeenCalledExactlyOnceWith('current-workspace')
    expect(order).toEqual(['close', 'open'])
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each([
    { missing: 'workspace', error: 'PET_WORKSPACE_UNAVAILABLE: no workspace can create a pet session' },
    { missing: 'opener', error: 'PET_SESSION_UNAVAILABLE: session opener is unavailable' },
  ])('missing $missing fails before connecting or closing', async ({ missing, error }) => {
    const client = adapter()
    const connect = client.workspaces.connectWorkspace
    const close = vi.fn()
    if (missing === 'workspace')
      client.workspaces.list = undefined
    else
      client.sessions.open = undefined
    expect(await createPetSession({ adapter: client, close })).toEqual({ ok: false, error })
    expect(connect).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(store.pet.prefills).toEqual({})
  })

  it.each(['', undefined, 123])('invalid session id %s fails without prefill or close', async (id) => {
    const client = adapter()
    client.workspaces.connectWorkspace = vi.fn().mockResolvedValue(id)
    const close = vi.fn()
    expect(await createPetSession({ adapter: client, close })).toEqual({ ok: false, error: 'PET_SESSION_UNAVAILABLE: workspace did not return a session id' })
    expect(close).not.toHaveBeenCalled()
    expect(client.sessions.open).not.toHaveBeenCalled()
    expect(store.pet.prefills).toEqual({})
  })

  it('session connection rejection preserves the create logging label and message', async () => {
    const client = adapter()
    const error = new Error('connect refused')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    client.workspaces.connectWorkspace = vi.fn().mockRejectedValue(error)
    expect(await createPetSession({ adapter: client })).toEqual({ ok: false, error: 'connect refused' })
    expect(log).toHaveBeenCalledExactlyOnceWith('[dsh-tauri-pet] create pet session failed:', error)
    expect(client.sessions.open).not.toHaveBeenCalled()
  })
})

describe('pet drag probability', () => {
  it.each([0, 25, 100])('persists %s percent through the native command and commits the returned status', async (probability) => {
    const updated = { ...status, drag_probability: probability }
    invoke.mockResolvedValue(updated)
    expect(await setPetDragProbability({ probability })).toEqual({ ok: true })
    expect(invoke).toHaveBeenCalledExactlyOnceWith('set_pet_drag_probability', { probability })
    expect(store.pet.$state.status).toEqual(updated)
  })

  it.each([-1, 101, 12.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid probability %s before invoking native code', async (probability) => {
    store.pet.setStatus(status)
    expect(await setPetDragProbability({ probability })).toEqual({ ok: false, error: 'PET_DRAG_PROBABILITY_OUT_OF_RANGE: expected 0..=100' })
    expect(invoke).not.toHaveBeenCalled()
    expect(store.pet.$state.status).toEqual(status)
  })

  it('preserves the saved probability when native persistence fails', async () => {
    const previous = { ...status, drag_probability: 30 }
    store.pet.setStatus(previous)
    invoke.mockRejectedValue(new Error('store unavailable'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await setPetDragProbability({ probability: 80 })).toEqual({ ok: false, error: 'store unavailable' })
    expect(store.pet.$state.status).toEqual(previous)
  })
})
