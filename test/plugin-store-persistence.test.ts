import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const memory = new Map<string, string>()
const stores: Array<{ $persist?: { dehydrate: () => void } }> = []

beforeEach(() => {
  vi.resetModules()
  memory.clear()
  vi.doMock('dsh-tauri/client', () => import('../packages/dsh-tauri/src/client/modules/valtio-define'))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
  })
})

afterEach(() => {
  for (const store of stores)
    store.$persist?.dehydrate()
  stores.length = 0
  vi.doUnmock('dsh-tauri/client')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function loadNotification() {
  const { notificationSettings } = await import('../packages/dsh-tauri-notification/src/client/store/modules/settings')
  stores.push(notificationSettings)
  return notificationSettings
}

async function loadScheduler() {
  const { scheduler } = await import('../packages/dsh-tauri-scheduler/src/client/store/modules/scheduler')
  stores.push(scheduler)
  return scheduler
}

describe('global store persistence', () => {
  it('registers persistence before a consuming store is created', async () => {
    const { defineStore } = await import('../packages/dsh-tauri/src/client/modules/valtio-define')
    memory.set('test.preferences', JSON.stringify({ count: 7 }))
    const preferences = defineStore({ state: () => ({ count: 0 }), persist: { key: 'test.preferences' } })
    stores.push(preferences)
    expect(preferences.count).toBe(7)
    preferences.count = 8
    await vi.waitFor(() => expect(memory.get('test.preferences')).toBe('{"count":8}'))
  })

  it('leaves stores without persist in memory', async () => {
    const { defineStore } = await import('../packages/dsh-tauri/src/client/modules/valtio-define')
    const runtime = defineStore({ state: () => ({ loading: false }) })
    runtime.loading = true
    await Promise.resolve()
    expect(runtime.$persist).toBeUndefined()
    expect(memory.size).toBe(0)
  })

  it('keeps stores usable when localStorage is absent', async () => {
    vi.stubGlobal('localStorage', undefined)
    const settings = await loadNotification()
    settings.setApproval(false)
    expect(settings.approval).toBe(false)
    expect(settings.$persist).toBeUndefined()
    expect(memory.size).toBe(0)
  })
})

describe('notification preferences', () => {
  it('starts with notification defaults when storage is empty', async () => {
    const settings = await loadNotification()
    expect(settings.$state).toEqual({
      turnComplete: 'background',
      approval: true,
      question: true,
      sound: 'default',
      customSound: null,
    })
  })

  it('restores preferences synchronously without a hydrate action', async () => {
    memory.set('dsh-tauri-notification.settings', JSON.stringify({ turnComplete: 'always', approval: false, sound: 'classic' }))
    const settings = await loadNotification()
    expect(settings.$state).toEqual({
      turnComplete: 'always',
      approval: false,
      question: true,
      sound: 'classic',
      customSound: null,
    })
    expect('hydrate' in settings).toBe(false)
  })

  it('automatically saves every notification preference', async () => {
    const settings = await loadNotification()
    settings.setTurnComplete('never')
    settings.setApproval(false)
    settings.setQuestion(false)
    settings.setSound('none')
    await vi.waitFor(() => expect(JSON.parse(memory.get('dsh-tauri-notification.settings')!)).toEqual({
      turnComplete: 'never',
      approval: false,
      question: false,
      sound: 'none',
      customSound: null,
    }))
  })

  it('retains custom audio when changing the selected sound', async () => {
    const settings = await loadNotification()
    settings.setCustomSound('data:audio/wav;base64,AAAA')
    expect(settings.sound).toBe('custom')
    settings.setSound('none')
    await vi.waitFor(() => expect(JSON.parse(memory.get('dsh-tauri-notification.settings')!)).toMatchObject({
      sound: 'none',
      customSound: 'data:audio/wav;base64,AAAA',
    }))
  })

  it('returns to the default sound when selected custom audio is removed', async () => {
    const settings = await loadNotification()
    settings.setCustomSound('data:audio/wav;base64,AAAA')
    settings.setCustomSound(null)
    await vi.waitFor(() => expect(JSON.parse(memory.get('dsh-tauri-notification.settings')!)).toMatchObject({
      sound: 'default',
      customSound: null,
    }))
  })
})

describe('open-in-app preferences', () => {
  it('uses the default application when storage is empty', async () => {
    const { openInApp } = await import('../packages/dsh-tauri-model/src/client/store/modules/open-in-app')
    stores.push(openInApp)
    expect(openInApp.choice).toBe('')
  })

  it('restores the selected application synchronously', async () => {
    memory.set('dsh-tauri-model.open-in-app.choice', JSON.stringify({ choice: 'editor' }))
    const { openInApp } = await import('../packages/dsh-tauri-model/src/client/store/modules/open-in-app')
    stores.push(openInApp)
    expect(openInApp.choice).toBe('editor')
  })

  it('persists application changes and a return to the default', async () => {
    const { openInApp } = await import('../packages/dsh-tauri-model/src/client/store/modules/open-in-app')
    stores.push(openInApp)
    openInApp.setChoice('editor')
    await vi.waitFor(() => expect(memory.get('dsh-tauri-model.open-in-app.choice')).toBe('{"choice":"editor"}'))
    openInApp.setChoice('')
    await vi.waitFor(() => expect(memory.get('dsh-tauri-model.open-in-app.choice')).toBe('{"choice":""}'))
  })
})

describe('scheduler read markers', () => {
  it('restores read markers without restoring task runtime state', async () => {
    memory.set('dsh-tauri-scheduler.read', JSON.stringify({ readAt: 123, readIds: ['run-1'] }))
    const scheduler = await loadScheduler()
    expect(scheduler.readAt).toBe(123)
    expect(scheduler.readIds).toEqual(['run-1'])
    expect(scheduler.tasks).toEqual([])
    expect(scheduler.runs).toEqual([])
    expect(scheduler.loading).toBe(false)
    expect(scheduler.loadToken).toBe(0)
  })

  it('persists only read markers when runtime state changes', async () => {
    const scheduler = await loadScheduler()
    scheduler.loading = true
    scheduler.error = 'offline'
    scheduler.loadToken = 9
    scheduler.markRunRead('run-1')
    scheduler.markRunRead('run-1')
    await vi.waitFor(() => expect(JSON.parse(memory.get('dsh-tauri-scheduler.read')!)).toEqual({
      readAt: 0,
      readIds: ['run-1'],
    }))
  })

  it('marks only runs from the opened session read without duplicate markers', async () => {
    const scheduler = await loadScheduler()
    scheduler.runs = [
      { id: 'run-1', taskId: 'task', taskName: 'Task', trigger: 'manual', status: 'succeeded', scheduledFor: '', startedAt: '', sessionId: 'session-1' },
      { id: 'run-2', taskId: 'task', taskName: 'Task', trigger: 'manual', status: 'succeeded', scheduledFor: '', startedAt: '', sessionId: 'session-1' },
      { id: 'run-3', taskId: 'task', taskName: 'Task', trigger: 'manual', status: 'succeeded', scheduledFor: '', startedAt: '', sessionId: 'session-2' },
    ]
    scheduler.markRunRead('run-1')
    scheduler.markSessionRead('session-1')
    scheduler.markSessionRead('session-1')
    scheduler.markSessionRead('missing-session')
    await vi.waitFor(() => expect(JSON.parse(memory.get('dsh-tauri-scheduler.read')!)).toEqual({
      readAt: 0,
      readIds: ['run-1', 'run-2'],
    }))
  })

  it('seeds the read timestamp only once', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200)
    const scheduler = await loadScheduler()
    scheduler.seedReadAt()
    scheduler.seedReadAt()
    await vi.waitFor(() => expect(JSON.parse(memory.get('dsh-tauri-scheduler.read')!)).toEqual({
      readAt: 100,
      readIds: [],
    }))
  })

  it('clears individual read markers when marking all runs read', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(456)
    const scheduler = await loadScheduler()
    scheduler.markRunRead('run-1')
    scheduler.markAllRunsRead()
    await vi.waitFor(() => expect(JSON.parse(memory.get('dsh-tauri-scheduler.read')!)).toEqual({
      readAt: 456,
      readIds: [],
    }))
  })
})
