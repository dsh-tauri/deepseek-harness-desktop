import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { recovery } from '../recovery'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@/config/client', () => ({ queryClient: { invalidateQueries: vi.fn() } }))
vi.mock('@/config/hooks', () => ({ hooks: { 'config.dialog.hidden': { trigger: vi.fn() } } }))
vi.mock('@/utils/toast', () => ({ toast: Object.assign(vi.fn(), { close: vi.fn() }) }))
vi.mock('../harness-updater', () => ({ harnessUpdater: { checkForUpdate: vi.fn() } }))
vi.mock('../plugins', () => import('../plugins/utils'))
vi.mock('../preinstall', () => ({ preinstall: {} }))
vi.mock('../recovery', () => ({ recovery: { listen: vi.fn(), clear: vi.fn(), reset: vi.fn(), hide: vi.fn(), reviewStartupRecovery: vi.fn() } }))
vi.mock('../setting', () => ({ setting: { $state: { installed: true }, refresh: vi.fn() } }))

let harness: typeof import('./store').harness
let remoteState: { machineId: string } | null
let owned: boolean

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubGlobal('__DSH_HOSTED__', true)
  vi.stubGlobal('__DSH_BOOT__', { entries: [] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  remoteState = null
  owned = false
  vi.mocked(invoke).mockImplementation(async (command) => {
    switch (command) {
      case 'prepare_harness_restart': return true
      case 'begin_harness_restart': return { id: 'hosted-restart' }
      case 'get_harness_restart': return null
      case 'finish_harness_restart': return true
      case 'get_remote_shell_state': return remoteState
      case 'proxy_health_check':
        if (!owned)
          throw new Error('HARNESS_NOT_OWNED')
        return 'healthy'
      case 'read_service_logs': return ''
      case 'get_runtime_info': return { service_url: 'http://127.0.0.1:3080' }
      case 'runtime_ready': return true
      case 'get_profiles': return [{ id: 'tauri', active: true }]
      case 'get_preinstall_pending': return false
      case 'ensure_internal_plugins':
      case 'cancel_internal_plugins':
      case 'shutdown_harness':
      case 'harness_ownership': return
      case 'launch_harness':
        owned = true
        return
      default: throw new Error(`Unexpected command: ${command}`)
    }
  })
  ;({ harness } = await import('./store'))
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('subscribes hosted startup once without launching the already hosted service', async () => {
  harness.markHostedReady()
  harness.startup()
  harness.startup()
  await vi.advanceTimersByTimeAsync(0)
  expect(recovery.listen).toHaveBeenCalledTimes(1)
  expect(vi.mocked(listen).mock.calls.map(([event]) => event)).toEqual(['internal-plugins-phase', 'harness-process-exited'])
  expect(invoke).not.toHaveBeenCalled()
  expect(harness.status).toBe('ready')
  expect(harness.serviceHealthy).toBe(true)
})

it('fails the hosted local document when its owned process exits', async () => {
  harness.markHostedReady()
  harness.startup()
  await vi.advanceTimersByTimeAsync(0)
  const listener = vi.mocked(listen).mock.calls.find(([event]) => event === 'harness-process-exited')![1]
  listener({ payload: { pid: 44856, exitCode: 1 } } as Parameters<typeof listener>[0])
  await vi.advanceTimersByTimeAsync(0)
  expect(harness.status).toBe('error')
  expect(harness.serviceHealthy).toBe(false)
  expect(harness.serviceRunning).toBe(false)
  expect(recovery.reviewStartupRecovery).toHaveBeenCalledWith([], expect.any(Function))
})

it('ignores a local process exit while native state identifies a remote hosted document', async () => {
  remoteState = { machineId: 'remote-machine' }
  harness.markHostedReady()
  await harness.handleProcessExit({ pid: 44856, exitCode: 1 })
  expect(invoke).toHaveBeenCalledExactlyOnceWith('get_remote_shell_state')
  expect(harness.status).toBe('ready')
  expect(harness.serviceHealthy).toBe(true)
  expect(recovery.reviewStartupRecovery).not.toHaveBeenCalled()
})

it('ignores a delayed process exit after the local runtime has recovered ownership', async () => {
  owned = true
  harness.markHostedReady()
  await harness.handleProcessExit({ pid: 44856, exitCode: 1 })
  expect(invoke).toHaveBeenCalledWith('proxy_health_check')
  expect(harness.status).toBe('ready')
  expect(harness.serviceHealthy).toBe(true)
  expect(recovery.reviewStartupRecovery).not.toHaveBeenCalled()
})

it('keeps a restarted hosted runtime ready when an older exit ownership check finishes', async () => {
  let rejectProbe!: (error: Error) => void
  vi.mocked(invoke)
    .mockImplementationOnce(async () => null)
    .mockImplementationOnce(() => new Promise((_, reject) => { rejectProbe = reject }))
  harness.markHostedReady()
  const handling = harness.handleProcessExit({ pid: 44856, exitCode: 1 })
  await vi.advanceTimersByTimeAsync(0)
  await harness.restart()
  rejectProbe(new Error('HARNESS_NOT_OWNED'))
  await handling
  expect(harness.status).toBe('ready')
  expect(harness.serviceHealthy).toBe(false)
  expect(recovery.reviewStartupRecovery).not.toHaveBeenCalled()
})

it('allows an explicit restart from a hosted document', async () => {
  harness.markHostedReady()
  await harness.restart()
  expect(invoke).toHaveBeenCalledWith('prepare_harness_restart', { id: 'hosted-restart' })
  expect(invoke).not.toHaveBeenCalledWith('shutdown_harness')
  expect(invoke).not.toHaveBeenCalledWith('launch_harness')
  expect(harness.status).toBe('ready')
  expect(harness.serviceHealthy).toBe(false)
})

it('boots a normal desktop document after registering lifecycle listeners', async () => {
  vi.stubGlobal('__DSH_BOOT__', undefined)
  harness.startup()
  await vi.advanceTimersByTimeAsync(0)
  expect(recovery.listen).toHaveBeenCalledTimes(1)
  expect(invoke).toHaveBeenCalledWith('launch_harness')
  expect(harness.status).toBe('ready')
  expect(harness.serviceHealthy).toBe(true)
})
