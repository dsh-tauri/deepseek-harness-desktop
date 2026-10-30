import type { LocaleDict, LocaleService } from '../types'
import { describe, expect, it, vi } from 'vitest'
import { defineLocale } from './index'

type Dicts = Record<string, LocaleDict>

interface FakeLocale {
  service: LocaleService
  register: (ns: string, dicts: Dicts) => () => void
  dicts: Map<string, Map<string, Dicts[string]>>
  listeners: Set<() => void>
  setLocale: (id: string) => void
}

function createFakeLocale(): FakeLocale {
  const dicts = new Map<string, Map<string, LocaleDict>>()
  const bound = new Map<string, (key: string, params?: Record<string, unknown>) => string>()
  const listeners = new Set<() => void>()
  let active = 'en'
  let revision = 0

  function lookup(ns: string, key: string): string | undefined {
    const table = dicts.get(ns)
    return table?.get(active)?.[key] ?? table?.get('en')?.[key]
  }

  function publish(): void {
    revision += 1
    for (const listener of [...listeners])
      listener()
  }

  const service = {
    register(ns: string, localeOrDicts: string | Dicts, dict?: LocaleDict) {
      const pairs: Array<[string, LocaleDict]> = typeof localeOrDicts === 'string'
        ? [[localeOrDicts, dict as LocaleDict]]
        : Object.entries(localeOrDicts)
      const table = dicts.get(ns) ?? new Map<string, LocaleDict>()
      dicts.set(ns, table)
      for (const [locale, entries] of pairs)
        table.set(locale, entries)
      publish()
      return () => {
        for (const [locale, entries] of pairs) {
          if (table.get(locale) === entries)
            table.delete(locale)
        }
      }
    },
    bind(ns: string) {
      let translate = bound.get(ns)
      if (translate === undefined) {
        translate = (key, params) => {
          const template = lookup(ns, key) ?? lookup('common', key) ?? key
          if (params === undefined)
            return template
          return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
        }
        bound.set(ns, translate)
      }
      return translate
    },
    getLocale: () => ({ active, locales: [], revision }),
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setLocale(id: string) {
      active = id
      publish()
    },
  }

  return {
    service: service as unknown as LocaleService,
    register: (ns: string, dicts2: Dicts) => service.register(ns, dicts2),
    dicts,
    listeners,
    setLocale: (id: string) => service.setLocale(id),
  }
}

async function setup() {
  vi.resetModules()
  const mod = await import('./index')
  const fake = createFakeLocale()
  const locale = mod.defineLocale('probe', {
    zh: { greeting: '你好', welcomed: '欢迎，{name}' },
    en: { greeting: 'Hello', welcomed: 'Welcome, {name}' },
  })
  return { mod, fake, locale, ctx: { locale: fake.service } }
}

describe('defineLocale', () => {
  it('未安装时读本地词典并保留缺失的占位符', async () => {
    const { locale } = await setup()
    expect(locale.NS).toBe('probe')
    expect(locale.activeLocale()).toBe('en')
    expect(locale.isEnglishLocale()).toBe(true)
    expect(locale.text('greeting')).toBe('Hello')
    expect(locale.text('welcomed', { name: 'Ada' })).toBe('Welcome, Ada')
    expect(locale.text('welcomed', {})).toBe('Welcome, {name}')
  })

  it('一次注册双语并把活跃语言桥接进共享 store', async () => {
    const { locale, fake, ctx } = await setup()
    const dispose = locale.registerLocale(ctx)

    const table = fake.dicts.get('probe')
    expect(table?.get('zh')).toEqual({ greeting: '你好', welcomed: '欢迎，{name}' })
    expect(table?.get('en')).toEqual({ greeting: 'Hello', welcomed: 'Welcome, {name}' })

    fake.setLocale('zh')
    expect(locale.activeLocale()).toBe('zh')
    expect(locale.isEnglishLocale()).toBe(false)
    expect(locale.text('greeting')).toBe('你好')

    dispose()
  })

  it('安装后让位给运行时（common 兜底生效）', async () => {
    const { locale, fake, ctx } = await setup()
    fake.register('common', { zh: { cancel: '取消' }, en: { cancel: 'Cancel' } })
    const dispose = locale.registerLocale(ctx)

    const t = locale.text as (key: string) => string
    expect(t('cancel')).toBe('Cancel')
    fake.setLocale('zh')
    expect(t('cancel')).toBe('取消')

    dispose()
    expect(t('cancel')).toBe('cancel')
  })

  it('disposer 幂等：注销词典与订阅', async () => {
    const { locale, fake, ctx } = await setup()
    const dispose = locale.registerLocale(ctx)
    expect(fake.listeners.size).toBe(1)

    dispose()
    dispose()
    expect(fake.listeners.size).toBe(0)
    expect(fake.dicts.get('probe')?.size).toBe(0)
    expect(locale.text('greeting')).toBe('Hello')
  })

  it('重叠安装时，最后一个 disposer 才解除运行时绑定', async () => {
    const { locale, fake, ctx } = await setup()
    fake.register('common', { zh: { cancel: '取消' }, en: { cancel: 'Cancel' } })
    const first = locale.registerLocale(ctx)
    const second = locale.registerLocale(ctx)
    const t = locale.text as (key: string) => string

    first()
    expect(t('cancel')).toBe('Cancel')

    second()
    expect(t('cancel')).toBe('cancel')
  })

  it('支持 ctx.effect(registerLocale, LABEL) 的 this 取 ctx 形式', async () => {
    const { locale, fake, ctx } = await setup()
    const dispose = locale.registerLocale.call(ctx)

    expect(fake.dicts.get('probe')?.get('en')).toEqual({ greeting: 'Hello', welcomed: 'Welcome, {name}' })
    expect(fake.dicts.get('probe')?.get('zh')).toEqual({ greeting: '你好', welcomed: '欢迎，{name}' })
    expect(fake.listeners.size).toBe(1)

    fake.register('probe', { en: { greeting: 'Runtime hello' } })
    expect(locale.text('greeting')).toBe('Runtime hello')

    dispose()
    expect(fake.listeners.size).toBe(0)
    expect(fake.dicts.get('probe')?.has('zh')).toBe(false)
    expect(locale.text('greeting')).toBe('Hello')
  })

  it('this 是 cordis Fiber 时取 fiber.ctx（effect 回调的真实形态）', async () => {
    const { locale, fake, ctx } = await setup()
    const dispose = locale.registerLocale.call({ uid: 1, ctx })
    expect(fake.dicts.get('probe')?.get('en')).toBeDefined()
    expect(locale.text('greeting')).toBe('Hello')
    dispose()
  })

  it('缺 ctx 时抛 TypeError', async () => {
    const { locale } = await setup()
    expect(() => locale.registerLocale()).toThrow(TypeError)
  })

  it('en 必须与 zh 等键集（编译期）', () => {
    // @ts-expect-error en 缺 `a`：键集平衡由类型系统强制
    defineLocale('probe-bad', { zh: { a: 'a' }, en: {} })
  })
})
