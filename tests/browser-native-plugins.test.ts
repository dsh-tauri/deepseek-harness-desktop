import type { ClientContext } from 'dsh-tauri/client'
import { afterEach, expect, it, vi } from 'vitest'
import { apply as notification } from '../packages/builtin-plugin-notification/src/client'
import { apply as desktop } from '../packages/builtin-plugin-tauri/src/client/apply'

afterEach(() => vi.unstubAllGlobals())

it.each([desktop, notification])('skips desktop-only plugin effects in an ordinary browser', (apply) => {
  vi.stubGlobal('window', {})
  vi.stubGlobal('document', {})
  vi.stubGlobal('isTauri', false)
  const effect = vi.fn()
  apply({ effect } as unknown as ClientContext)
  expect(effect).not.toHaveBeenCalled()
})

it.each([[desktop, 9], [notification, 3]] as const)('registers desktop-only plugin effects in the native carrier', (apply, count) => {
  vi.stubGlobal('window', {})
  vi.stubGlobal('document', {})
  vi.stubGlobal('isTauri', true)
  const effect = vi.fn()
  apply({ effect, inject: vi.fn() } as unknown as ClientContext)
  expect(effect).toHaveBeenCalledTimes(count)
})
