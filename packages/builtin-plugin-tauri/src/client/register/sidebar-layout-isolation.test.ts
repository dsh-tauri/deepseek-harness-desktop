import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isolateSidebarLayout } from './sidebar-fullwindow'

const KEY = 'dsh.sidebar-right.v1.session-1'
const ISOLATED = 'data-dsh-tauri-layout-isolated'

class FakeStorage {
  map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
}

const attributes = new Map<string, string>()
const shared = new FakeStorage()
const own = new FakeStorage()

const native = {
  getItem: FakeStorage.prototype.getItem,
  setItem: FakeStorage.prototype.setItem,
  removeItem: FakeStorage.prototype.removeItem,
}

function stubGlobals(): void {
  vi.stubGlobal('window', { localStorage: shared, sessionStorage: own })
  vi.stubGlobal('localStorage', shared)
  vi.stubGlobal('sessionStorage', own)
  vi.stubGlobal('document', {
    documentElement: {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      hasAttribute: (name: string) => attributes.has(name),
    },
  })
}

function sharedValue(key: string): string | null {
  return shared.map.get(key) ?? null
}

describe('isolateSidebarLayout', () => {
  beforeEach(() => {
    attributes.clear()
    shared.map.clear()
    own.map.clear()
    stubGlobals()
  })

  afterEach(() => {
    FakeStorage.prototype.getItem = native.getItem
    FakeStorage.prototype.setItem = native.setItem
    FakeStorage.prototype.removeItem = native.removeItem
    vi.unstubAllGlobals()
  })

  it('把本窗口要用的右栏布局搬进 sessionStorage 并强制成全屏形态', () => {
    shared.setItem(KEY, JSON.stringify({ bySession: { 'session-1': { layout: { expanded: false, mode: 'push' }, minted: 3 } } }))

    isolateSidebarLayout('session-1')

    expect(JSON.parse(own.getItem(KEY) ?? '')).toEqual({
      bySession: { 'session-1': { layout: { expanded: true, mode: 'fullscreen' }, minted: 3 } },
    })
  })

  it('隔离后的写入不再落到主窗口共享的 localStorage', () => {
    isolateSidebarLayout('session-1')

    localStorage.setItem(KEY, 'own-layout')

    expect(sharedValue(KEY)).toBeNull()
    expect(own.getItem(KEY)).toBe('own-layout')
    expect(localStorage.getItem(KEY)).toBe('own-layout')
  })

  it('同一文档只装一次，别的会话不会被顺带隔离', () => {
    isolateSidebarLayout('session-1')
    isolateSidebarLayout('session-2')

    expect(attributes.get(ISOLATED)).toBe('session-1')
    expect(own.getItem('dsh.sidebar-right.v1.session-2')).toBeNull()
  })
})
