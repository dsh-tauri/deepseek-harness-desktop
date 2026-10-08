import type { ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { patchThemeSettings } from './support/theme-settings-patch'

function createTheme() {
  const source = readFileSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-client-ui-theme/client'), 'utf8')
  const patched = patchThemeSettings(source)
  expect(patched, '锁定核心必须命中生产补丁锚点').toBeTypeOf('string')
  let Theme: typeof ThemeRuntime | undefined
  runInNewContext(patched!, {
    window: {
      __ModuleLoader__: {
        load: (entry: { factory: (require: () => object) => { ThemeRuntime: typeof ThemeRuntime } }) => {
          Theme = entry.factory(() => ({})).ThemeRuntime
        },
      },
    },
  })
  let value = { preference: 'system', fontSize: 14 }
  const subscribers = new Set<() => void>()
  const writes: { field: string, value: string | number, resolve: (accepted: boolean) => void, reject: (error: Error) => void }[] = []
  const host = {
    getSnapshot: () => ({ value }),
    subscribe: (listener: () => void) => {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
    set: (field: string, value: string | number) => new Promise<boolean>((resolve, reject) => writes.push({ field, value, resolve, reject })),
  }
  const theme = new Theme!(
    { effect: (effect: () => void) => effect(), emit: () => {} } as never,
    host as never,
  )
  function adopt(next: typeof value) {
    value = next
    subscribers.forEach(listener => listener())
  }
  return { theme, writes, adopt }
}

describe('core theme settings settlement', () => {
  it('keeps a later selection while an earlier write is acknowledged', async () => {
    const { theme, writes, adopt } = createTheme()
    theme.setTheme('dark')
    theme.setTheme('light')
    adopt({ preference: 'dark', fontSize: 14 })
    writes[0].resolve(true)
    await Promise.resolve()
    expect(theme.getTheme().preference).toBe('light')
    theme.setTheme('dark')
    expect(writes.map(write => write.value)).toEqual(['dark', 'light', 'dark'])
    adopt({ preference: 'light', fontSize: 14 })
    writes[1].resolve(true)
    await Promise.resolve()
    expect(theme.getTheme().preference).toBe('dark')
    adopt({ preference: 'dark', fontSize: 14 })
    writes[2].resolve(true)
    await Promise.resolve()
    expect(theme.getTheme().preference).toBe('dark')
    adopt({ preference: 'system', fontSize: 16 })
    expect(theme.getTheme().preference).toBe('system')
    expect(theme.getTheme().fontSize).toBe(16)
  })

  it('preserves pending font changes alongside theme changes', async () => {
    const { theme, writes, adopt } = createTheme()
    theme.setTheme('dark')
    theme.setFontSize(18)
    adopt({ preference: 'dark', fontSize: 14 })
    writes[0].resolve(true)
    await Promise.resolve()
    expect(theme.getTheme().fontSize).toBe(18)
    adopt({ preference: 'dark', fontSize: 18 })
    writes[1].resolve(true)
    await Promise.resolve()
    expect(theme.getTheme().fontSize).toBe(18)
  })

  it.each(['rejected', 'transport error'])('restores durable settings after a %s write and allows another attempt', async (failure) => {
    const { theme, writes } = createTheme()
    theme.setTheme('dark')
    if (failure === 'rejected')
      writes[0].resolve(false)
    else
      writes[0].reject(new Error('Disconnected'))
    await Promise.resolve()
    expect(theme.getTheme().preference).toBe('system')
    theme.setTheme('dark')
    expect(writes.map(write => write.value)).toEqual(['dark', 'dark'])
    writes[1].resolve(false)
    await Promise.resolve()
  })
})
