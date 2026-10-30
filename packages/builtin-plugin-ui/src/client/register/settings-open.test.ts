import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSettingsOpen, SETTINGS_OPEN_MESSAGE } from './settings-open'

const mocks = vi.hoisted(() => ({ openAt: vi.fn() }))

vi.mock('dsh-tauri/client', () => ({
  defineRegister: (feature: (...args: never[]) => void) => feature,
}))

vi.mock('../store/modules/settings', () => ({
  settings: { openAt: mocks.openAt },
}))

function setup() {
  const listenEvent = vi.fn((_event: string, _fn: unknown) => () => {})
  ;(registerSettingsOpen as (controller: unknown) => void)({ add: vi.fn(), listenEvent })
  const handler = listenEvent.mock.calls[0]![1] as (event: { payload: unknown }) => void
  return { listenEvent, handler }
}

describe('registerSettingsOpen', () => {
  beforeEach(() => {
    mocks.openAt.mockClear()
  })

  it('opens the settings overlay at the requested section on the host event', () => {
    const { listenEvent, handler } = setup()
    expect(listenEvent).toHaveBeenCalledWith(SETTINGS_OPEN_MESSAGE, expect.any(Function))
    handler({ payload: { section: 'dsh-tauri-remote-sync' } })
    expect(mocks.openAt).toHaveBeenCalledWith('dsh-tauri-remote-sync')
  })

  it('ignores non-string sections and opens without a target', () => {
    const { handler } = setup()
    handler({ payload: { section: 42 } })
    handler({ payload: null })
    handler({ payload: { payload: { section: 'dsh-tauri-remote' } } })
    expect(mocks.openAt).toHaveBeenNthCalledWith(1, undefined)
    expect(mocks.openAt).toHaveBeenNthCalledWith(2, undefined)
    expect(mocks.openAt).toHaveBeenNthCalledWith(3, undefined)
  })
})
