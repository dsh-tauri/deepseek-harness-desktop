import { invoke } from '@tauri-apps/api/core'
// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import i18next from 'i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from '@/utils/toast'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@/config/client', () => ({ queryClient: { invalidateQueries: vi.fn() } }))
vi.mock('@/config/hooks', () => ({ hooks: { 'config.dialog.hidden': { trigger: vi.fn() } } }))
vi.mock('@/utils/toast', () => ({ toast: Object.assign(vi.fn(() => 'restart-toast'), { close: vi.fn(), update: vi.fn(), isActive: vi.fn(() => true) }) }))
vi.mock('../harness-updater', () => ({ harnessUpdater: { checkForUpdate: vi.fn() } }))
vi.mock('../plugins', () => import('../plugins/utils'))
vi.mock('../preinstall', () => ({ preinstall: {} }))
vi.mock('../recovery', () => ({ recovery: { listen: vi.fn(), clear: vi.fn(), reset: vi.fn(), hide: vi.fn(), reviewStartupRecovery: vi.fn() } }))
vi.mock('../setting', () => ({ setting: { $state: { installed: true }, refresh: vi.fn() } }))

let harness: typeof import('./store').harness
let shutdown: () => Promise<void>
let launchError: string | undefined
let marker: { id: string, phase?: 'leaving' | 'stopping' | 'loading' } | null
let acceptSuccess: boolean

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubGlobal('__DSH_HOSTED__', true)
  vi.stubGlobal('__DSH_BOOT__', { entries: [] })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await i18next.init({ lng: 'en', keySeparator: false, resources: { en: { translation: {
    'messages.harness_restart_failed': 'Harness restart failed',
  } } } })
  shutdown = async () => {}
  launchError = undefined
  marker = null
  acceptSuccess = false
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    switch (command) {
      case 'begin_harness_restart':
        marker = { id: 'restart-42' }
        return marker
      case 'prepare_harness_restart': return true
      case 'resume_harness_restart':
        await shutdown()
        if (marker)
          marker.phase = 'loading'
        return true
      case 'get_harness_restart': return marker
      case 'finish_harness_restart':
        if ((args as { outcome: string }).outcome === 'success' && !acceptSuccess)
          return false
        marker = null
        return true
      case 'shutdown_harness': return shutdown()
      case 'get_runtime_info': return { service_url: 'http://127.0.0.1:3081' }
      case 'runtime_ready': return true
      case 'get_profiles': return [{ id: 'tauri', active: true }]
      case 'get_preinstall_pending': return false
      case 'proxy_health_check': return 'healthy'
      case 'read_service_logs': return ''
      case 'ensure_internal_plugins':
      case 'cancel_internal_plugins': return
      case 'launch_harness':
        if (launchError)
          throw new Error(launchError)
        return
      case 'harness_ownership': return
      default: throw new Error(`Unexpected command: ${command}`)
    }
  })
  ;({ harness } = await import('./store'))
  harness.markHostedReady()
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('restarts from the bootstrap through native phases and consumes the loading operation after readiness', async () => {
  vi.stubGlobal('__DSH_BOOT__', undefined)
  const original = vi.mocked(invoke).getMockImplementation()!
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'begin_harness_restart') {
      marker = { id: 'restart-42', phase: 'leaving' }
      return marker
    }
    if (command === 'finish_harness_restart' && (args as { outcome: string }).outcome === 'success') {
      if (marker?.phase !== 'loading')
        return false
      marker = null
      return true
    }
    return original(command, args)
  })
  await harness.restart()
  const commands = vi.mocked(invoke).mock.calls.map(([command]) => command)
  expect(commands.filter(command => command === 'prepare_harness_restart')).toHaveLength(1)
  expect(commands.filter(command => command === 'resume_harness_restart')).toHaveLength(1)
  expect(commands).not.toContain('shutdown_harness')
  expect(commands.indexOf('prepare_harness_restart')).toBeLessThan(commands.indexOf('resume_harness_restart'))
  expect(commands.indexOf('resume_harness_restart')).toBeLessThan(commands.indexOf('ensure_internal_plugins'))
  expect(marker).toEqual({ id: 'restart-42', phase: 'loading' })
  await harness.completeRestartDocument()
  expect(marker).toBeNull()
  expect(harness.restartPending).toBe(false)
  expect(toast).not.toHaveBeenCalled()
})

it('leaves the hosted renderer before stopping its backend', async () => {
  await harness.restart()
  expect(invoke).toHaveBeenCalledWith('prepare_harness_restart', { id: 'restart-42' })
  expect(invoke).not.toHaveBeenCalledWith('shutdown_harness')
  expect(invoke).not.toHaveBeenCalledWith('resume_harness_restart', expect.anything())
  expect(invoke).not.toHaveBeenCalledWith('launch_harness')
})

it.each(['leaving', 'stopping'] as const)('the bootstrap resumes %s before plugin ensure and launch exactly once', async (phase) => {
  marker = { id: 'restart-42', phase }
  vi.stubGlobal('__DSH_BOOT__', undefined)
  harness.startup()
  harness.startup()
  await vi.advanceTimersByTimeAsync(0)
  const commands = vi.mocked(invoke).mock.calls.map(([command]) => command)
  expect(commands.filter(command => command === 'resume_harness_restart')).toHaveLength(1)
  expect(commands.indexOf('resume_harness_restart')).toBeLessThan(commands.indexOf('ensure_internal_plugins'))
  expect(commands.indexOf('ensure_internal_plugins')).toBeLessThan(commands.indexOf('launch_harness'))
  expect(commands.filter(command => command === 'launch_harness')).toHaveLength(1)
})

it('does not ensure plugins or launch while the native stop continuation is pending', async () => {
  marker = { id: 'restart-42', phase: 'leaving' }
  vi.stubGlobal('__DSH_BOOT__', undefined)
  let stopped!: () => void
  shutdown = () => new Promise<void>((resolve) => {
    stopped = resolve
  })
  const initialization = harness.initialize()
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenCalledWith('resume_harness_restart', { id: 'restart-42' })
  expect(invoke).not.toHaveBeenCalledWith('ensure_internal_plugins')
  expect(invoke).not.toHaveBeenCalledWith('launch_harness')
  stopped()
  await initialization
  expect(invoke).toHaveBeenCalledWith('ensure_internal_plugins')
  expect(invoke).toHaveBeenCalledWith('launch_harness')
})

it('boots a loading continuation without repeating the native stop', async () => {
  marker = { id: 'restart-42', phase: 'loading' }
  vi.stubGlobal('__DSH_BOOT__', undefined)
  await harness.initialize()
  expect(invoke).not.toHaveBeenCalledWith('resume_harness_restart', expect.anything())
  expect(invoke).not.toHaveBeenCalledWith('shutdown_harness')
  expect(invoke).toHaveBeenCalledWith('launch_harness')
})

it('normal bootstrap reload without a native operation never stops the service', async () => {
  vi.stubGlobal('__DSH_BOOT__', undefined)
  await harness.initialize()
  expect(invoke).not.toHaveBeenCalledWith('resume_harness_restart', expect.anything())
  expect(invoke).not.toHaveBeenCalledWith('shutdown_harness')
  expect(invoke).toHaveBeenCalledWith('launch_harness')
})

it('rejects a stale native continuation without starting the backend', async () => {
  marker = { id: 'restart-42', phase: 'stopping' }
  vi.stubGlobal('__DSH_BOOT__', undefined)
  const original = vi.mocked(invoke).getMockImplementation()!
  vi.mocked(invoke).mockImplementation((command, args) => command === 'resume_harness_restart' ? Promise.resolve(false) : original(command, args))
  await harness.initialize()
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).not.toHaveBeenCalledWith('launch_harness')
  expect(harness.status).toBe('error')
  expect(toast).toHaveBeenCalledWith('Harness restart failed', expect.objectContaining({ description: 'Error: HARNESS_RESTART_RESUME_REJECTED' }))
  expect(harness.busyAction).toBeNull()
})

it('reports a rejected navigation preparation without stopping the hosted backend', async () => {
  const original = vi.mocked(invoke).getMockImplementation()!
  vi.mocked(invoke).mockImplementation((command, args) => command === 'prepare_harness_restart' ? Promise.resolve(false) : original(command, args))
  await harness.restart()
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).not.toHaveBeenCalledWith('shutdown_harness')
  expect(harness.status).toBe('error')
  expect(toast).toHaveBeenCalledWith('Harness restart failed', expect.objectContaining({ description: 'Error: HARNESS_RESTART_PREPARE_REJECTED' }))
})

it('single-flights a bootstrap restart without any toast', async () => {
  vi.stubGlobal('__DSH_BOOT__', undefined)
  let release!: () => void
  shutdown = () => new Promise<void>((resolve) => {
    release = resolve
  })
  const first = harness.restart()
  const second = harness.restart()
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenCalledWith('resume_harness_restart', { id: 'restart-42' })
  expect(invoke).not.toHaveBeenCalledWith('shutdown_harness')
  release()
  await Promise.all([first, second])
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'resume_harness_restart')).toHaveLength(1)
  expect(toast).not.toHaveBeenCalled()
})

it('restores loading in the new document and succeeds once only after native confirmation of real ready', async () => {
  await harness.restart()
  expect(marker).toEqual({ id: 'restart-42' })
  expect(harness.restartPending).toBe(true)
  vi.resetModules()
  vi.clearAllMocks()
  ;({ harness } = await import('./store'))
  expect(await Promise.all([harness.restoreRestartOperation(), harness.restoreRestartOperation()])).toEqual([true, true])
  expect(toast).not.toHaveBeenCalled()
  acceptSuccess = true
  await Promise.all([harness.completeRestartDocument(), harness.completeRestartDocument()])
  expect(invoke).toHaveBeenCalledWith('finish_harness_restart', { id: 'restart-42', outcome: 'success' })
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'finish_harness_restart')).toHaveLength(1)
  expect(marker).toBeNull()
  expect(toast).not.toHaveBeenCalled()
})

it('rejects stale-document ready without losing the loading notification', async () => {
  await harness.restart()
  await harness.completeRestartDocument()
  expect(invoke).toHaveBeenCalledWith('finish_harness_restart', { id: 'restart-42', outcome: 'success' })
  expect(marker).toEqual({ id: 'restart-42' })
  expect(toast).not.toHaveBeenCalled()
})

it('does not report success when the document fails while native confirmation is pending', async () => {
  await harness.restart()
  let confirm!: (accepted: boolean) => void
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => {
    confirm = resolve
  }))
  const ready = harness.completeRestartDocument()
  await vi.advanceTimersByTimeAsync(0)
  harness.fail('CLIENT_EXITED_DURING_READY')
  confirm(true)
  await ready
  expect(toast).toHaveBeenCalledExactlyOnceWith('Harness restart failed', expect.objectContaining({ description: 'CLIENT_EXITED_DURING_READY' }))
})

it('normal reload without a native operation does not report restart success', async () => {
  await harness.restoreRestartOperation()
  await harness.completeRestartDocument()
  expect(invoke).not.toHaveBeenCalledWith('finish_harness_restart', expect.anything())
  expect(toast).not.toHaveBeenCalled()
})

it('waits for restoring the operation before handling a real ready signal', async () => {
  let resolveMarker!: (value: { id: string }) => void
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => {
    resolveMarker = resolve
  }))
  const restoring = harness.restoreRestartOperation()
  acceptSuccess = true
  const ready = harness.completeRestartDocument()
  expect(toast).not.toHaveBeenCalled()
  resolveMarker({ id: 'restart-42' })
  await Promise.all([restoring, ready])
  expect(toast).not.toHaveBeenCalled()
})

it('does not stop the service when the native restart identity cannot be registered', async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error('RESTART_MARKER_FAILED'))
  await harness.restart()
  expect(invoke).not.toHaveBeenCalledWith('shutdown_harness')
  expect(harness.busyAction).toBeNull()
  expect(toast).toHaveBeenCalledExactlyOnceWith('Harness restart failed', expect.objectContaining({ description: 'Error: RESTART_MARKER_FAILED' }))
})

it('does not create a restart notification when another lifecycle action owns the store', async () => {
  harness.busyAction = 'shutdown'
  await harness.restart()
  expect(toast).not.toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalled()
})

it('does not treat health readiness or the old document mount as restart success', async () => {
  vi.stubGlobal('__DSH_BOOT__', undefined)
  await harness.restart()
  expect(harness.serviceHealthy).toBe(true)
  harness.markHostedReady()
  harness.markWebviewLoaded()
  harness.markWebviewAlive(harness.webviewKey)
  harness.markWebviewBootReady()
  expect(toast).not.toHaveBeenCalled()
})

it('turns a navigation failure into one failure toast instead of keeping loading forever', async () => {
  await harness.restart()
  harness.fail('HARNESS_DOCUMENT_NAVIGATION_FAILED: rejected', undefined, undefined, undefined, true)
  await vi.advanceTimersByTimeAsync(0)
  expect(toast).toHaveBeenCalledExactlyOnceWith('Harness restart failed', expect.objectContaining({
    placement: 'bottom end',
    variant: 'danger',
    description: 'HARNESS_DOCUMENT_NAVIGATION_FAILED: rejected',
  }))
})

it('settles one failure toast when the real restart boot catches a launch failure', async () => {
  launchError = 'HARNESS_START_FAILED: launch denied'
  await harness.restart()
  vi.stubGlobal('__DSH_BOOT__', undefined)
  vi.resetModules()
  ;({ harness } = await import('./store'))
  await harness.initialize()
  await vi.advanceTimersByTimeAsync(0)
  expect(harness.status).toBe('error')
  expect(toast).toHaveBeenCalledExactlyOnceWith('Harness restart failed', expect.objectContaining({
    placement: 'bottom end',
    variant: 'danger',
    description: expect.stringContaining('HARNESS_START_FAILED'),
  }))
  harness.fail('duplicate failure')
  await vi.advanceTimersByTimeAsync(0)
  expect(toast).toHaveBeenCalledTimes(1)
})

it('the restart hook checks an already rendered DSH frame after restoring loading', async () => {
  marker = { id: 'restart-42' }
  acceptSuccess = true
  const frame = document.createElement('div')
  frame.className = 'layout_frame'
  frame.append(document.createElement('section'))
  document.body.append(frame)
  const { useRestartSettlement } = await import('@/hooks/use-restart-settlement')
  await act(async () => {
    renderHook(() => useRestartSettlement())
  })
  expect(invoke).toHaveBeenCalledWith('finish_harness_restart', { id: 'restart-42', outcome: 'success' })
  expect(marker).toBeNull()
  expect(toast).not.toHaveBeenCalled()
})

it('the restart hook does not infer an operation from a normal document frame', async () => {
  const frame = document.createElement('div')
  frame.className = 'layout_frame'
  frame.append(document.createElement('section'))
  document.body.append(frame)
  const { useRestartSettlement } = await import('@/hooks/use-restart-settlement')
  await act(async () => {
    renderHook(() => useRestartSettlement())
  })
  expect(toast).not.toHaveBeenCalled()
  expect(invoke).toHaveBeenCalledExactlyOnceWith('get_harness_restart')
})

it('the restart hook stops observing the DSH document after unmount', async () => {
  marker = { id: 'restart-42' }
  acceptSuccess = true
  const { useRestartSettlement } = await import('@/hooks/use-restart-settlement')
  const hook = renderHook(() => useRestartSettlement())
  await act(async () => {})
  hook.unmount()
  const frame = document.createElement('div')
  frame.className = 'layout_frame'
  frame.append(document.createElement('section'))
  await act(async () => {
    document.body.append(frame)
  })
  expect(toast).not.toHaveBeenCalled()
  expect(marker).toEqual({ id: 'restart-42' })
})

it('the new document boot failure settles the restored notification instead of reporting success', async () => {
  marker = { id: 'restart-42' }
  const { useRestartSettlement } = await import('@/hooks/use-restart-settlement')
  await act(async () => {
    renderHook(() => useRestartSettlement())
  })
  await act(async () => {
    harness.fail('CLIENT_BOOT_FAILED')
  })
  expect(toast).toHaveBeenCalledExactlyOnceWith('Harness restart failed', expect.objectContaining({ description: 'CLIENT_BOOT_FAILED' }))
  expect(marker).toBeNull()
})

it('the real restart hook waits for the DSH frame rather than accepting bootstrap metadata', async () => {
  marker = { id: 'restart-42' }
  acceptSuccess = true
  const { useRestartSettlement } = await import('@/hooks/use-restart-settlement')
  await act(async () => {
    renderHook(() => useRestartSettlement())
  })
  expect(toast).not.toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalledWith('finish_harness_restart', expect.anything())
  await act(async () => {
    const frame = document.createElement('div')
    frame.className = 'layout_frame'
    frame.append(document.createElement('section'))
    document.body.append(frame)
  })
  expect(invoke).toHaveBeenCalledWith('finish_harness_restart', { id: 'restart-42', outcome: 'success' })
  expect(marker).toBeNull()
  expect(toast).not.toHaveBeenCalled()
})
