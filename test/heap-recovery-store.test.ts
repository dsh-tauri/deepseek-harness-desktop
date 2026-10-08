import type { Event } from '@tauri-apps/api/event'
import i18next from 'i18next'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resources } from '../src/i18n/index.resource'

const eventListeners = new Map<string, (event: Event<unknown>) => void>()
const invoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, callback: (event: Event<unknown>) => void) => {
    eventListeners.set(event, callback)
    return vi.fn()
  }),
}))
vi.mock('@/config/client', () => ({ queryClient: { invalidateQueries: vi.fn() } }))
vi.mock('../src/store/modules/harness-updater', () => ({
  harnessUpdater: { checkForUpdate: vi.fn() },
}))

const { harness } = await import('../src/store/modules/harness')
const { recovery } = await import('../src/store/modules/recovery')

const V8_HEAP_OOM_LINE = 'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory'
const V8_HEAP_PEAK_LINE = 'Mark-Compact 8058.3 (8224.0) -> 8051.0 (8234.2) MB'
const SERVICE_LOG = `${V8_HEAP_OOM_LINE}\n${V8_HEAP_PEAK_LINE}`

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** 记录每次 invoke，并按命令给出一条「能跑完一轮 boot」的应答 */
function stubRuntime(
  recoveryLimitMb: number | null,
  onUpdateConfig?: () => Promise<void>,
  onPatchRepair?: (command: string) => Promise<void>,
) {
  let healthChecks = 0
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'harness_ownership') {
      return undefined
    }
    if (command === 'proxy_health_check') {
      healthChecks += 1
      // 第一次：退出后的归属探测——旧进程已经没了
      if (healthChecks === 1) {
        throw new Error('HARNESS_NOT_OWNED: no Harness process is owned by this app')
      }
      return 'Healthy'
    }
    if (command === 'read_service_logs') {
      return SERVICE_LOG
    }
    if (command === 'quarantine_broken_patch_layers' || command === 'enter_safe_mode' || command === 'strip_unresolved_patch_entries') {
      await onPatchRepair?.(command)
      return { quarantined: [], failures: [], layers: [] }
    }
    if (command === 'detect_plugin_recovery') {
      return { plugins: [], reason: 'unknown', detail: '', rawError: '' }
    }
    if (command === 'get_effective_heap_limit_mb') {
      return 16384
    }
    if (command === 'get_heap_recovery_limit_mb') {
      return recoveryLimitMb
    }
    if (command === 'update_app_config') {
      await onUpdateConfig?.()
      return undefined
    }
    if (command === 'get_app_config') {
      return {
        proxy_url: '',
        installed: true,
        port: 3080,
        harness_max_heap_mb: 16384,
        auto_start: true,
        cli_link_enabled: true,
        zoom_factor: 1,
        close_action: 'tray',
        backup_retention_count: 10,
        backup_include_credentials: false,
        language: null,
      }
    }
    if (command === 'runtime_ready') {
      return true
    }
    if (command === 'ensure_internal_plugins') {
      return undefined
    }
    if (command === 'get_preinstall_pending') {
      return false
    }
    if (command === 'get_runtime_info') {
      return { service_url: 'http://127.0.0.1:31415' }
    }
    if (command === 'launch_harness' || command === 'shutdown_harness') {
      return undefined
    }
    throw new Error(`unexpected invoke: ${command} ${JSON.stringify(args)}`)
  })
}

function callsOf(command: string): Array<Record<string, unknown> | undefined> {
  return invoke.mock.calls.filter(call => call[0] === command).map(call => call[1] as Record<string, unknown> | undefined)
}

describe('harness heap OOM recovery', () => {
  beforeAll(async () => {
    await i18next.init({
      resources,
      lng: 'zh-CN',
      keySeparator: false,
      nsSeparator: false,
      initAsync: false,
    })
  })

  beforeEach(() => {
    eventListeners.clear()
    invoke.mockReset()
    Object.assign(harness, {
      status: 'ready',
      errorMsg: '',
      errorLogs: [],
      pluginConflictHint: '',
      inotifyLimitHint: '',
      heapOomHint: '',
      serviceHealthy: true,
      serviceRunning: true,
      iframeLoaded: true,
      iframeError: true,
      busyAction: null,
    })
    recovery.reset()
  })

  it('restarts the service with a doubled limit after V8 heap exhaustion', async () => {
    stubRuntime(16384)
    await harness.handleProcessExit({ pid: 42, exitCode: 134 })

    expect(callsOf('get_heap_recovery_limit_mb')).toHaveLength(1)
    expect(callsOf('update_app_config')).toEqual([{ harnessMaxHeapMb: 16384 }])
    expect(callsOf('launch_harness').length).toBeGreaterThan(0)
    expect(harness.status).toBe('ready')
    expect(harness.serviceHealthy).toBe(true)
  })

  it('keeps the error page when the limit already sits at the cap', async () => {
    stubRuntime(null)
    await harness.handleProcessExit({ pid: 42, exitCode: 134 })

    expect(callsOf('get_heap_recovery_limit_mb')).toHaveLength(1)
    expect(callsOf('update_app_config')).toHaveLength(0)
    expect(callsOf('launch_harness')).toHaveLength(0)
    expect(harness.status).toBe('error')
    expect(harness.heapOomHint).toContain('16384 MB')
    expect(harness.heapOomHint).toContain('8234')
  })

  it('reserves the patch repair action before its first await so exit recovery cannot restart underneath it', async () => {
    const entered = deferred()
    const gate = deferred()
    stubRuntime(16384, undefined, async (command) => {
      if (command === 'quarantine_broken_patch_layers') {
        entered.resolve()
        await gate.promise
      }
    })

    const repair = harness.quarantineBrokenPatchLayers()
    expect(harness.busyAction).toBe('repair')
    await entered.promise

    await harness.handleProcessExit({ pid: 42, exitCode: 134 })
    expect(callsOf('get_heap_recovery_limit_mb')).toHaveLength(0)
    expect(callsOf('update_app_config')).toHaveLength(0)
    expect(callsOf('launch_harness')).toHaveLength(0)

    gate.resolve()
    await repair

    expect(harness.busyAction).toBe(null)
    expect(callsOf('launch_harness')).toHaveLength(1)
    expect(harness.status).toBe('ready')
  })

  it('does not relaunch the service when the user stops it while the new limit is being written', async () => {
    const entered = deferred()
    const gate = deferred()
    stubRuntime(16384, async () => {
      entered.resolve()
      await gate.promise
    })

    const exit = harness.handleProcessExit({ pid: 42, exitCode: 134 })
    await entered.promise
    await harness.shutdown()
    gate.resolve()
    await exit

    expect(callsOf('launch_harness')).toHaveLength(0)
    expect(harness.status).toBe('error')
    expect(harness.errorMsg).toBe('已停止')
  })
})
