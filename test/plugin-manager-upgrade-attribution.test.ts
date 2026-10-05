import i18next from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resources } from '../src/i18n/index.resource'

interface ToastCallOptions {
  timeout?: number
  variant?: string
  isLoading?: boolean
  description?: string
  actionProps?: { children?: string }
  onClose?: (reason: string) => void
}

const { invoke, restart, toast } = vi.hoisted(() => {
  let index = 0
  const toastFn = vi.fn((_message: string, _options?: ToastCallOptions): string => `toast-${++index}`)
  return {
    invoke: vi.fn(),
    restart: vi.fn(),
    toast: Object.assign(toastFn, { close: vi.fn(), update: vi.fn(), clear: vi.fn(), isActive: vi.fn(() => true) }),
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../src/store/modules/harness', () => ({ harness: { restart } }))
vi.mock('@/utils/toast', () => ({ toast }))

await i18next.init({
  lng: 'en-US',
  fallbackLng: 'en-US',
  resources: resources as unknown as Record<string, { translation: Record<string, string> }>,
  interpolation: { escapeValue: false },
  keySeparator: false,
  nsSeparator: false,
  initAsync: false,
})

const { plugins } = await import('../src/store/modules/plugins')
const { parseUpdateFailures } = await import('../src/store/modules/plugins/utils')

const RUNTIME = { toast: true, restartOnSettle: false }
const NETWORK_MESSAGE = 'NETWORK_ERROR: plugin registry request failed; check network or proxy settings and retry.'
const ENTRY_MESSAGE = 'PLUGIN_ENTRY_MISSING: bbb declared entry dist/index.js was not built'

function failureError(entries: unknown): Error {
  return new Error(`PLUGIN_UPDATE_FAILED: ${JSON.stringify(entries)}`)
}

function holdLine(payload: unknown): string {
  return `PLUGIN_UPDATE_NO_CHANGE: ${JSON.stringify(payload)}`
}

function resultToasts() {
  return toast.mock.calls.filter(call => call[1]?.isLoading !== true)
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue(undefined)
  toast.mockClear()
  toast.close.mockClear()
  restart.mockClear()
  plugins.groups = []
  plugins.processes = []
  plugins.logs = []
  plugins.activeGroupId = null
  plugins.cancelling = false
  plugins.installedSource = []
  plugins.installedLoaded = false
  plugins.progressKey = null
  plugins.progressDetail = ''
})

describe('plugins manager upgrade attribution', () => {
  it('parses failures out of any line of a multi-part payload', () => {
    const message = [
      holdLine([{ name: 'aaa', version: '1.0.0', latest: '1.1.0', retryable: false }]),
      `PLUGIN_UPDATE_FAILED: ${JSON.stringify([{ name: 'bbb', message: ENTRY_MESSAGE }])}`,
    ].join('\n')

    expect(parseUpdateFailures(message)).toEqual([{ name: 'bbb', message: ENTRY_MESSAGE }])
    expect(parseUpdateFailures('PLUGIN_UPDATE_FAILED: not-json')).toEqual([])
    expect(parseUpdateFailures('NETWORK_ERROR: unreachable')).toEqual([])
  })

  it('keeps the explicit target that landed when the implicit stage fails as a whole', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'update_dsh_plugins')
        throw failureError([{ name: 'bbb', message: NETWORK_MESSAGE }])
      return undefined
    })

    const results = await plugins.enqueue('upgrade', ['aaa@2.0.0', 'bbb'], RUNTIME)

    expect(results.map(result => [result.process.name, result.ok, result.reason])).toEqual([
      ['aaa', true, undefined],
      ['bbb', false, undefined],
    ])
    expect(results[1].error).toBe(NETWORK_MESSAGE)
    expect(results[1].code).toBe('NETWORK_ERROR')

    const toasts = resultToasts()
    expect(toasts).toHaveLength(1)
    expect(toasts[0][0]).toBe('Plugin operations finished')
    expect(toasts[0][1]?.description).toBe('1 succeeded · 1 failed')
    expect(toasts[0][1]?.variant).toBe('danger')
  })

  it('keeps a verified failure attributed when a later stage returns a general error', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'update_dsh_plugins') {
        throw new Error([
          `PLUGIN_UPDATE_FAILED: ${JSON.stringify([{ name: 'aaa', message: ENTRY_MESSAGE }])}`,
          `PLUGIN_UPDATE_FAILED: ${JSON.stringify([{ name: 'ccc', message: NETWORK_MESSAGE }])}`,
        ].join('\n'))
      }
      return undefined
    })

    const results = await plugins.enqueue('upgrade', ['aaa@2.0.0', 'bbb@3.0.0'], RUNTIME)

    expect(results.map(result => [result.process.name, result.ok, result.error])).toEqual([
      ['aaa', false, ENTRY_MESSAGE],
      ['bbb', true, undefined],
    ])
  })

  it('keeps the restart entry for the target that landed despite the general error', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'update_dsh_plugins')
        throw failureError([{ name: 'bbb', message: NETWORK_MESSAGE }])
      return undefined
    })

    const results = await plugins.enqueue('upgrade', ['aaa@2.0.0', 'bbb'], { toast: true, restartOnSettle: true })

    expect(results.map(result => [result.process.name, result.ok])).toEqual([
      ['aaa', true],
      ['bbb', false],
    ])
    const toasts = resultToasts()
    expect(toasts).toHaveLength(1)
    expect(toasts[0][1]?.timeout).toBe(0)
    expect(toasts[0][1]?.actionProps?.children).toBe('Restart')
    toasts[0][1]?.actionProps?.onPress?.()
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('attributes a failure inside a batch that also holds an authorised target', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command !== 'update_dsh_plugins')
        return undefined
      throw new Error([
        holdLine([{ name: 'bbb', version: '0.2.0', latest: '0.2.1', retryable: false }]),
        `PLUGIN_UPDATE_FAILED: ${JSON.stringify([{ name: 'aaa', message: ENTRY_MESSAGE }])}`,
      ].join('\n'))
    })

    const results = await plugins.enqueue('upgrade', ['aaa', 'bbb', 'ccc'], RUNTIME)

    expect(results.map(result => [result.process.name, result.ok])).toEqual([
      ['aaa', false],
      ['bbb', false],
      ['ccc', true],
    ])
    expect(results[0].error).toBe(ENTRY_MESSAGE)
    expect(plugins.pendingApprovals).toHaveLength(0)
  })

  it('settles a failed target while another waits for authorisation', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command !== 'update_dsh_plugins')
        return undefined
      throw new Error([
        `PLUGIN_POLICY_BLOCKED: ${JSON.stringify([{ name: 'bbb', version: '2.0.0' }])}`,
        `PLUGIN_UPDATE_FAILED: ${JSON.stringify([{ name: 'aaa', message: ENTRY_MESSAGE }])}`,
      ].join('\n'))
    })

    const done = plugins.enqueue('upgrade', ['aaa', 'bbb'], RUNTIME)
    await vi.waitFor(() => expect(plugins.pendingApprovals).toHaveLength(1))

    expect(plugins.pendingApprovals.map(process => process.name)).toEqual(['bbb'])
    // 已结算的目标会被 detach，只剩下等授权的那一个留在组里
    expect(plugins.processes.map(process => process.name)).toEqual(['bbb'])
    expect(plugins.logs.map(log => log.message)).toContain(ENTRY_MESSAGE)

    await plugins.cancel()
    const results = await done
    expect(results.map(result => [result.process.name, result.ok, result.reason])).toEqual([
      ['aaa', false, undefined],
      ['bbb', false, 'cancelled'],
    ])
  })
})
