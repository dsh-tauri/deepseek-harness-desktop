import { invoke } from '@tauri-apps/api/core'
import { afterEach, expect, it, vi } from 'vitest'
import { isElectronRuntime } from '@/utils/runtime'
import { toast } from '@/utils/toast'
import { harnessUpdater } from './store'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }))
vi.mock('@/utils/runtime', () => ({ isElectronRuntime: vi.fn(() => false) }))
vi.mock('@/utils/toast', () => ({ toast: Object.assign(vi.fn(() => 'k'), { clear: vi.fn(), close: vi.fn() }) }))
vi.mock('../harness', () => ({ harness: {} }))
vi.mock('i18next', () => ({ default: { t: (key: string) => key }, t: (key: string) => key }))

const info = { tag: 'v1.2.3', commit: 'abcdef1234567890' } as never

afterEach(() => {
  vi.clearAllMocks()
})

it('uses the transparent overlay window under Electron so the toast is not covered', async () => {
  vi.mocked(isElectronRuntime).mockReturnValue(true)
  harnessUpdater.updateInfo = info
  harnessUpdater.showToast(() => {})
  expect(toast).not.toHaveBeenCalled()
  expect(invoke).toHaveBeenCalledWith('show_toast_overlay', {
    content: expect.objectContaining({ title: 'update.available', description: 'abcdef1', action_label: 'update.now', source: 'main' }),
  })
  harnessUpdater.hideToast()
  expect(invoke).toHaveBeenCalledWith('hide_toast_overlay')
})

it('falls back to the in-page toast outside Electron', async () => {
  vi.mocked(isElectronRuntime).mockReturnValue(false)
  harnessUpdater.updateInfo = info
  harnessUpdater.showToast(() => {})
  expect(toast).toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalledWith('show_toast_overlay', expect.anything())
  harnessUpdater.hideToast()
  expect(invoke).not.toHaveBeenCalledWith('hide_toast_overlay')
})
