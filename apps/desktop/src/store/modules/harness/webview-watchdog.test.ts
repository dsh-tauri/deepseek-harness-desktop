import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { harness } from './store'

vi.mock('@/config/client', () => ({ queryClient: {} }))
vi.mock('@/config/hooks', () => ({ hooks: {} }))
vi.mock('@/utils/toast', () => ({ toast: {} }))
vi.mock('../harness-updater', () => ({ harnessUpdater: {} }))
vi.mock('../plugins', () => ({ parseBlockedRefusal: vi.fn() }))
vi.mock('../preinstall', () => ({ preinstall: {} }))
vi.mock('../recovery', () => ({ recovery: {} }))
vi.mock('../setting', () => ({ setting: {} }))
vi.mock('./utils', () => ({}))

beforeEach(async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  Object.assign(harness, {
    status: 'ready',
    serviceHealthy: true,
    serviceRunning: true,
    webviewKey: 0,
    webviewAliveKey: null,
    webviewLoaded: false,
    webviewError: false,
  })
  await vi.advanceTimersByTimeAsync(0)
})

afterEach(async () => {
  harness.serviceHealthy = false
  await vi.advanceTimersByTimeAsync(0)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('cancels the five-second watchdog when the current guest proves its document', async () => {
  harness.markWebviewLoaded()
  await vi.advanceTimersByTimeAsync(4999)
  expect(harness.webviewError).toBe(false)
  harness.markWebviewAlive(0)
  await vi.advanceTimersByTimeAsync(20001)
  expect(harness.webviewAlive).toBe(true)
  expect(harness.webviewError).toBe(false)
})

it('rejects document proof from an earlier guest generation', () => {
  harness.webviewKey = 1
  harness.markWebviewAlive(0)
  expect(harness.webviewAlive).toBe(false)
})

it('reports a loaded guest without document proof after five seconds', async () => {
  harness.markWebviewLoaded()
  await vi.advanceTimersByTimeAsync(4999)
  expect(harness.webviewError).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(harness.webviewError).toBe(true)
  expect(harness.webviewLoaded).toBe(false)
  expect(harness.webviewAlive).toBe(false)
})

it('gives a replacement generation its own grace period when loaded stays true', async () => {
  harness.markWebviewLoaded()
  await vi.advanceTimersByTimeAsync(4000)
  harness.webviewKey++
  await vi.advanceTimersByTimeAsync(1000)
  expect(harness.webviewError).toBe(false)
  await vi.advanceTimersByTimeAsync(4000)
  expect(harness.webviewError).toBe(true)
})

it('reloads only the document generation and never stops the service', async () => {
  harness.markWebviewLoaded()
  harness.markWebviewAlive(0)

  harness.reloadWebview()
  expect(harness.webviewLoaded).toBe(false)
  expect(harness.serviceRunning).toBe(true)
  await vi.advanceTimersByTimeAsync(800)
  expect(harness.webviewKey).toBe(1)
})

it('reloads the hosted document itself when the window carries the page', async () => {
  vi.stubGlobal('__DSH_HOSTED__', true)
  vi.stubGlobal('__DSH_BOOT__', { entries: [] })
  const reload = vi.fn()
  vi.stubGlobal('location', { reload })
  harness.markWebviewLoaded()
  harness.markWebviewAlive(0)

  harness.reloadWebview()
  await vi.advanceTimersByTimeAsync(1000)

  expect(reload).toHaveBeenCalledOnce()
  expect(harness.webviewKey).toBe(0)
  expect(harness.serviceRunning).toBe(true)
})

it('ignores a reload request while the service is stopped', async () => {
  harness.serviceRunning = false
  const generation = harness.webviewKey

  harness.reloadWebview()
  await vi.advanceTimersByTimeAsync(1000)

  expect(harness.webviewKey).toBe(generation)
})
