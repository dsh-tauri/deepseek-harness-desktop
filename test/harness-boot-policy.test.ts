import type { ToastOptions } from '../src/utils/toast'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, toast, unlisten } = vi.hoisted(() => ({
  invoke: vi.fn(),
  toast: Object.assign(vi.fn((_title: unknown, _options?: ToastOptions) => 'policy-toast'), {
    close: vi.fn(),
  }),
  unlisten: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => unlisten) }))
vi.mock('@/utils/toast', () => ({ toast }))
vi.mock('@/config/client', () => ({ queryClient: { invalidateQueries: vi.fn() } }))
vi.mock('../src/store/modules/harness-updater', () => ({ harnessUpdater: { checkForUpdate: vi.fn() } }))
vi.mock('../src/store/modules/recovery', () => ({
  recovery: { clear: vi.fn(), reset: vi.fn(), hide: vi.fn(), reviewStartupRecovery: vi.fn() },
}))
vi.mock('i18next', () => ({
  default: { t: (key: string, options?: Record<string, unknown>) => `${key} ${Object.values(options ?? {}).join(' ')}` },
}))

const { harness } = await import('../src/store/modules/harness')
const { preinstall } = await import('../src/store/modules/preinstall')
const { PLUGIN_INACTIVITY_TIMEOUT } = await import('../src/store/modules/harness/constants')
const POLICY = [{ name: '@scope/transitive', version: '1.2.3' }]
const REFUSAL = `INTERNAL_PLUGIN_INSTALL_FAILED: PLUGIN_POLICY_BLOCKED: ${JSON.stringify(POLICY)}`
let ensureFailure: unknown
let grantFailure: unknown
let launchFailure: unknown
let activeProfile: string
let preinstallPending: boolean
let ensureTask: Promise<void> | undefined

function approvalOptions(): ToastOptions {
  const call = toast.mock.calls.find(([, options]) => options?.actionProps !== undefined)
  expect(call, 'boot must expose a persistent authorization action').not.toBeUndefined()
  return call![1]!
}

async function authorize(options = approvalOptions()) {
  const onPress = options.actionProps?.onPress
  expect(onPress).toBeTypeOf('function')
  await onPress!({} as never)
}

beforeEach(() => {
  invoke.mockReset()
  toast.mockClear()
  toast.close.mockClear()
  unlisten.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  ensureFailure = REFUSAL
  grantFailure = undefined
  launchFailure = undefined
  ensureTask = undefined
  activeProfile = 'web'
  preinstallPending = false
  harness.status = 'ready'
  harness.serviceHealthy = false
  harness.serviceRunning = false
  harness.busyAction = null
  preinstall.error = ''
  preinstall.installing = false
  preinstall.policyBlocked = []
  invoke.mockImplementation(async (command: string, args?: { id: string }) => {
    switch (command) {
      case 'set_active_profile':
        activeProfile = args!.id
        return { id: activeProfile, active: true }
      case 'get_runtime_info': return { service_url: activeProfile === 'other' ? 'http://127.0.0.1:3082' : 'http://127.0.0.1:3081' }
      case 'get_app_config': return { installed: true }
      case 'enter_safe_mode': return { quarantined: [], failures: [] }
      case 'runtime_ready': return true
      case 'get_profiles': return [{ id: activeProfile, active: true }]
      case 'ensure_internal_plugins':
        if (ensureTask)
          return ensureTask
        if (ensureFailure !== undefined)
          throw ensureFailure
        return undefined
      case 'get_preinstall_pending': return preinstallPending
      case 'get_preinstall_plugins': return []
      case 'proxy_health_check': return 'healthy'
      case 'read_run_logs': return ''
      case 'allow_plugin_policy_versions':
        if (grantFailure !== undefined)
          throw grantFailure
        ensureFailure = undefined
        return undefined
      case 'launch_harness':
        if (launchFailure !== undefined)
          throw launchFailure
        return undefined
      default: return undefined
    }
  })
})

afterEach(() => {
  harness.serviceHealthy = false
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('window profile connection', () => {
  it('connects the selected profile without restarting either shared runtime', async () => {
    ensureFailure = undefined
    harness.serviceHealthy = true
    harness.serviceRunning = true
    await harness.switchProfile('other')

    expect(activeProfile).toBe('other')
    expect(harness.serviceUrl).toBe('http://127.0.0.1:3082')
    expect(harness.iframeSrc).toContain('http://127.0.0.1:3082')
    expect(harness.serviceHealthy).toBe(true)
    expect(harness.busyAction).toBe(null)
    expect(invoke).toHaveBeenCalledWith('set_active_profile', { id: 'other' })
    expect(invoke).toHaveBeenCalledWith('launch_harness')
    expect(invoke).not.toHaveBeenCalledWith('shutdown_harness')
    expect(invoke).not.toHaveBeenCalledWith('restart_harness')
  })

  it('enters the safe profile without restarting another window already using it', async () => {
    ensureFailure = undefined
    await harness.enterSafeMode()

    expect(invoke).toHaveBeenCalledWith('enter_safe_mode')
    expect(invoke).toHaveBeenCalledWith('launch_harness')
    expect(invoke).not.toHaveBeenCalledWith('shutdown_harness')
    expect(harness.serviceHealthy).toBe(true)
    expect(harness.busyAction).toBe(null)
  })

  it('keeps the previous connection when profile binding fails', async () => {
    harness.serviceHealthy = true
    harness.serviceRunning = true
    harness.serviceUrl = 'http://127.0.0.1:3081'
    invoke.mockRejectedValueOnce(new Error('PROFILE_NOT_FOUND: missing'))
    await expect(harness.switchProfile('missing')).rejects.toThrow('PROFILE_NOT_FOUND')

    expect(activeProfile).toBe('web')
    expect(harness.serviceUrl).toBe('http://127.0.0.1:3081')
    expect(harness.serviceHealthy).toBe(true)
    expect(harness.serviceRunning).toBe(true)
    expect(harness.busyAction).toBe(null)
    expect(invoke).not.toHaveBeenCalledWith('launch_harness')
    expect(invoke).not.toHaveBeenCalledWith('shutdown_harness')
  })
})

describe('harness boot policy refusal recovery', () => {
  it.each([REFUSAL, `PLUGIN_POLICY_BLOCKED: ${JSON.stringify(POLICY)}`])('continues core startup with an exact-version authorization action for %s', async (failure) => {
    ensureFailure = failure
    await harness.boot()

    expect(harness.status).toBe('ready')
    expect(harness.serviceHealthy).toBe(true)
    expect(harness.errorMsg).toBe('')
    expect(invoke).toHaveBeenCalledWith('launch_harness')
    expect(invoke).not.toHaveBeenCalledWith('allow_plugin_policy_versions', expect.anything())
    const options = approvalOptions()
    expect(options).toMatchObject({ timeout: 0, sticky: true, variant: 'warning' })
    expect(options.description).toContain('@scope/transitive@1.2.3')
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('reuses the exact-version authorization IPC before restarting through ensure again', async () => {
    await harness.boot()
    await authorize()

    expect(invoke.mock.calls.filter(([command]) => command === 'allow_plugin_policy_versions')).toEqual([
      ['allow_plugin_policy_versions', { versions: POLICY, expectedProfile: 'web' }],
    ])
    expect(toast.mock.calls.filter(([, options]) => options?.variant === 'danger')).toEqual([])
    expect(invoke.mock.calls.filter(([command]) => command === 'ensure_internal_plugins')).toHaveLength(2)
    expect(invoke).toHaveBeenCalledWith('shutdown_harness')
    expect(invoke).not.toHaveBeenCalledWith('install_plugin_specs', expect.anything())
    expect(harness.serviceHealthy).toBe(true)
    expect(toast.close).toHaveBeenCalledWith('policy-toast')
  })

  it('allows dismissing authorization without granting or preventing core startup', async () => {
    await harness.boot()
    approvalOptions().onClose?.('dismissed')

    expect(harness.serviceHealthy).toBe(true)
    expect(invoke.mock.calls.filter(([command]) => command === 'ensure_internal_plugins')).toHaveLength(1)
    expect(invoke).not.toHaveBeenCalledWith('allow_plugin_policy_versions', expect.anything())
  })

  it('preserves the pending preinstall recovery path after policy refusal', async () => {
    preinstallPending = true
    await harness.boot()

    expect(harness.status).toBe('preinstall')
    expect(invoke).toHaveBeenCalledWith('get_preinstall_plugins')
    expect(invoke).not.toHaveBeenCalledWith('launch_harness')
    expect(approvalOptions().description).toContain('@scope/transitive@1.2.3')
    await preinstall.skip()
    expect(harness.serviceHealthy).toBe(true)
  })

  it('keeps failed authorization visible and retryable without restarting', async () => {
    await harness.boot()
    const options = approvalOptions()
    grantFailure = 'POLICY_WRITE_FAILED: disk full'
    await authorize(options)

    expect(toast).toHaveBeenCalledWith(expect.stringContaining('plugins.authorize_failed'), expect.objectContaining({
      variant: 'danger',
      description: 'POLICY_WRITE_FAILED: disk full',
    }))
    expect(invoke).not.toHaveBeenCalledWith('shutdown_harness')
    expect(harness.serviceHealthy).toBe(true)
    grantFailure = undefined
    await authorize(options)
    expect(invoke).toHaveBeenCalledWith('shutdown_harness')
  })

  it('does not authorize an old boot after a newer boot has started', async () => {
    await harness.boot()
    const oldOptions = approvalOptions()
    ensureFailure = undefined
    await harness.boot()
    await authorize(oldOptions)

    expect(invoke).not.toHaveBeenCalledWith('allow_plugin_policy_versions', expect.anything())
  })

  it('does not apply a previous profile refusal to the newly active profile', async () => {
    await harness.boot()
    activeProfile = 'other'
    await authorize()

    expect(invoke).not.toHaveBeenCalledWith('allow_plugin_policy_versions', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('shutdown_harness')
  })

  it('does not assign an in-flight refusal to a profile activated during ensure', async () => {
    ensureTask = new Promise((_resolve, reject) => {
      ensureFailure = reject
    })
    const boot = harness.boot()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('ensure_internal_plugins'))
    activeProfile = 'other'
    ;(ensureFailure as (error: string) => void)(REFUSAL)
    await boot

    expect(harness.status).toBe('error')
    expect(toast.mock.calls.filter(([, options]) => options?.actionProps)).toEqual([])
    expect(invoke).not.toHaveBeenCalledWith('allow_plugin_policy_versions', expect.anything())
  })

  it.each([
    'INTERNAL_PLUGIN_INSTALL_FAILED: PREINSTALL_FAILED: command failed',
    'INTERNAL_PLUGIN_INSTALL_FAILED: PLUGIN_OPERATION_CANCELLED: cancelled',
    'INTERNAL_PLUGIN_INSTALL_FAILED: PLUGIN_PROCESS_CLEANUP_FAILED: process still alive',
    `${REFUSAL}\nPLUGIN_PROCESS_CLEANUP_FAILED: process still alive`,
    `INTERNAL_PLUGIN_INSTALL_FAILED: PLUGIN_PROCESS_CLEANUP_FAILED: ${REFUSAL}`,
    'INTERNAL_PLUGIN_INSTALL_FAILED: PLUGIN_POLICY_BLOCKED: not-json',
    'INTERNAL_PLUGIN_INSTALL_FAILED: PLUGIN_POLICY_BLOCKED: []',
    'INTERNAL_PLUGIN_INSTALL_FAILED: PLUGIN_POLICY_BLOCKED: [{"name":"x"}]',
    'INTERNAL_PLUGIN_INSTALL_FAILED: PLUGIN_POLICY_BLOCKED: [{"name":"x","version":"*"}]',
  ])('preserves the startup failure contract for %s', async (failure) => {
    ensureFailure = failure
    await harness.boot()

    expect(harness.status).toBe('error')
    expect(harness.errorMsg).toContain(failure)
    expect(invoke).not.toHaveBeenCalledWith('launch_harness')
    expect(toast.mock.calls.filter(([, options]) => options?.actionProps)).toEqual([])
  })

  it('does not hide a subsequent core launch failure behind the policy refusal', async () => {
    launchFailure = 'LAUNCH_FAILED: process exited'
    await harness.boot()

    expect(harness.status).toBe('error')
    expect(harness.errorMsg).toContain('LAUNCH_FAILED: process exited')
    expect(harness.serviceHealthy).toBe(false)
  })

  it('preserves inactivity timeout cancellation and failure handling', async () => {
    vi.useFakeTimers()
    ensureTask = new Promise(() => {})
    const boot = harness.boot()
    await vi.advanceTimersByTimeAsync(PLUGIN_INACTIVITY_TIMEOUT)
    await boot

    expect(invoke).toHaveBeenCalledWith('cancel_internal_plugins')
    expect(harness.status).toBe('error')
    expect(harness.errorMsg).toContain('errors.startup_inactivity')
    expect(invoke).not.toHaveBeenCalledWith('launch_harness')
  })

  it('keeps a timed-out installation cleanup failure blocking', async () => {
    vi.useFakeTimers()
    ensureTask = new Promise(() => {})
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation(async (command: string) => {
      if (command === 'cancel_internal_plugins')
        throw new Error(`PLUGIN_PROCESS_CLEANUP_FAILED: ${REFUSAL}`)
      return original(command)
    })
    const boot = harness.boot()
    await vi.advanceTimersByTimeAsync(PLUGIN_INACTIVITY_TIMEOUT)
    await boot

    expect(harness.status).toBe('error')
    expect(harness.errorMsg).toContain('PLUGIN_PROCESS_CLEANUP_FAILED')
    expect(invoke).not.toHaveBeenCalledWith('launch_harness')
    expect(toast.mock.calls.filter(([, options]) => options?.actionProps)).toEqual([])
  })
})
