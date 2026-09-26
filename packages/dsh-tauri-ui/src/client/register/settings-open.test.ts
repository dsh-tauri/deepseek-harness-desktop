import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSettingsOpen, SETTINGS_OPEN_MESSAGE } from './settings-open'

const mocks = vi.hoisted(() => ({
  openAt: vi.fn(),
  listenParent: vi.fn(),
}))

vi.mock('dsh-tauri/client', () => ({
  defineRegister: (feature: (...args: never[]) => void) => feature,
  listenParent: mocks.listenParent,
}))

vi.mock('../store/modules/settings', () => ({
  settings: { openAt: mocks.openAt },
}))

describe('registerSettingsOpen', () => {
  beforeEach(() => {
    mocks.openAt.mockClear()
    mocks.listenParent.mockReset()
  })

  it('opens the settings overlay at the requested section on the host message', () => {
    mocks.listenParent.mockImplementation((handler: (message: unknown) => void, types: unknown) => {
      expect(types).toBe(SETTINGS_OPEN_MESSAGE)
      handler({ type: SETTINGS_OPEN_MESSAGE, section: 'dsh-tauri-ssh-sync' })
      return () => {}
    })
    const controller = { add: vi.fn() }
    ;(registerSettingsOpen as (controller: unknown) => void)(controller)
    expect(mocks.listenParent).toHaveBeenCalledOnce()
    expect(mocks.openAt).toHaveBeenCalledWith('dsh-tauri-ssh-sync')
  })

  it('ignores non-string sections and opens without a target', () => {
    mocks.listenParent.mockImplementation((handler: (message: unknown) => void) => {
      handler({ type: SETTINGS_OPEN_MESSAGE, section: 42 })
      handler({ type: SETTINGS_OPEN_MESSAGE })
      // 旧形状（payload 包装）不再被识别：层级读错就是静默失效的根因
      handler({ type: SETTINGS_OPEN_MESSAGE, payload: { section: 'dsh-tauri-ssh' } })
      return () => {}
    })
    ;(registerSettingsOpen as (controller: unknown) => void)({ add: vi.fn() })
    expect(mocks.openAt).toHaveBeenNthCalledWith(1, undefined)
    expect(mocks.openAt).toHaveBeenNthCalledWith(2, undefined)
    expect(mocks.openAt).toHaveBeenNthCalledWith(3, undefined)
  })
})
