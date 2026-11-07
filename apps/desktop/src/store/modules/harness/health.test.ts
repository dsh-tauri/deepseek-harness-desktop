import { afterEach, expect, it, vi } from 'vitest'
import { checkHealthViaProxy } from './utils'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
afterEach(() => vi.restoreAllMocks())
it('treats the owned process launch signal wait as normal startup without warnings', async () => {
  invoke.mockRejectedValue('HARNESS_NOT_READY: waiting for this Harness process launch URL')
  const warn = vi.spyOn(console, 'warn')
  expect(await checkHealthViaProxy()).toEqual({ healthy: false, notOwned: false, notListening: true, phase: 'process-boot', reason: 'HARNESS_NOT_READY: waiting for this Harness process launch URL' })
  expect(warn).not.toHaveBeenCalled()
})
