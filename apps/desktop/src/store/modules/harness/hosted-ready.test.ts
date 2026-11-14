import { beforeEach, expect, it, vi } from 'vitest'
import { harnessUpdater } from '../harness-updater'
import { setting } from '../setting'
import { harness } from './store'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }))
vi.mock('@/config/client', () => ({ queryClient: { invalidateQueries: vi.fn() } }))
vi.mock('@/config/hooks', () => ({ hooks: {} }))
vi.mock('@/utils/toast', () => ({ toast: Object.assign(vi.fn(), { close: vi.fn() }) }))
vi.mock('../harness-updater', () => ({ harnessUpdater: { checkForUpdate: vi.fn() } }))
vi.mock('../plugins', () => import('../plugins/utils'))
vi.mock('../preinstall', () => ({ preinstall: {} }))
vi.mock('../recovery', () => ({ recovery: { listen: vi.fn(), clear: vi.fn(), reset: vi.fn(), reviewStartupRecovery: vi.fn() } }))
vi.mock('../setting', () => ({ setting: { $state: { installed: true }, refresh: vi.fn() } }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('__DSH_HOSTED__', true)
  vi.stubGlobal('__DSH_BOOT__', { entries: [] })
  Object.assign(harness, { status: 'setup', serviceHealthy: false, serviceRunning: false, errorMsg: 'stale' })
  Object.assign(setting.$state, { installed: true })
})

it('marks the hosted document ready without running startup', () => {
  harness.markHostedReady()
  expect(harness.status).toBe('ready')
  expect(harness.serviceHealthy).toBe(true)
  expect(harness.serviceRunning).toBe(true)
  expect(harness.errorMsg).toBe('')
})

it('checks the core update for a hosted document that never runs boot', async () => {
  await harness.initialize()
  expect(setting.refresh).toHaveBeenCalled()
  expect(harnessUpdater.checkForUpdate).toHaveBeenCalledTimes(1)
})

it('skips the core update while the runtime is not installed yet', async () => {
  setting.$state.installed = false
  await harness.initialize()
  expect(harnessUpdater.checkForUpdate).not.toHaveBeenCalled()
})
