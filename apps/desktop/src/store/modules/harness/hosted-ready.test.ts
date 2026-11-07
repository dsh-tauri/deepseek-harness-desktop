import { beforeEach, expect, it, vi } from 'vitest'
import { harness } from './store'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@/config/client', () => ({ queryClient: { invalidateQueries: vi.fn() } }))
vi.mock('@/config/hooks', () => ({ hooks: {} }))
vi.mock('@/utils/toast', () => ({ toast: Object.assign(vi.fn(), { close: vi.fn() }) }))
vi.mock('../harness-updater', () => ({ harnessUpdater: { checkForUpdate: vi.fn() } }))
vi.mock('../plugins', () => import('../plugins/utils'))
vi.mock('../preinstall', () => ({ preinstall: {} }))
vi.mock('../recovery', () => ({ recovery: { clear: vi.fn(), reset: vi.fn(), reviewStartupRecovery: vi.fn() } }))
vi.mock('../setting', () => ({ setting: { $state: { installed: true }, refresh: vi.fn() } }))

beforeEach(() => {
  Object.assign(harness, { status: 'setup', serviceHealthy: false, serviceRunning: false, errorMsg: 'stale' })
})

it('marks the hosted document ready without running startup', () => {
  harness.markHostedReady()
  expect(harness.status).toBe('ready')
  expect(harness.serviceHealthy).toBe(true)
  expect(harness.serviceRunning).toBe(true)
  expect(harness.errorMsg).toBe('')
})
