import type { LocaleDict, LocaleService, Translate } from '../types/harness'
import { defineStore, useStore } from '../modules/valtio-define'
import { effectContext } from '../utils/context'

export interface LocaleDicts<D extends LocaleDict = LocaleDict> {
  zh: D
  en: Record<keyof D & string, string>
}

export interface LocaleHost {
  locale: LocaleService
}

export interface LocaleDefinition<NS extends string = string, K extends string = string> {
  NS: NS
  text: Translate<K>
  activeLocale: () => string
  isEnglishLocale: () => boolean
  useLocale: () => string
  registerLocale: (this: unknown, ctx?: LocaleHost) => () => void
}

const FALLBACK_LOCALE = 'en'

const localeBridge = defineStore({
  state: () => ({ active: FALLBACK_LOCALE }),
  actions: {
    sync(active: string) {
      if (this.active !== active)
        this.active = active
    },
  },
})

export function activeLocale(): string {
  return localeBridge.$state.active
}

export function isEnglishLocale(): boolean {
  return activeLocale().toLowerCase().startsWith('en')
}

export function useLocale(): string {
  return useStore(localeBridge).active
}

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined)
    return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

export function defineLocale<const NS extends string, const D extends LocaleDict>(
  namespace: NS,
  dicts: LocaleDicts<D>,
): LocaleDefinition<NS, keyof D & string> {
  type K = keyof D & string

  const zh: LocaleDict = dicts.zh
  const en: LocaleDict = dicts.en
  let live: Translate | undefined
  let installations = 0

  function text(key: K, params?: Record<string, unknown>): string {
    const translate = live
    if (translate !== undefined)
      return translate(key, params)
    const template = (activeLocale() === 'en' ? en[key] : zh[key]) ?? en[key] ?? key
    return interpolate(template, params)
  }

  function registerLocale(this: unknown, ctx?: LocaleHost): () => void {
    const locale = (ctx ?? effectContext<LocaleHost>(this))?.locale
    if (locale === undefined)
      throw new TypeError('defineLocale: 缺少客户端上下文（用 ctx.effect(registerLocale, LABEL) 或 registerLocale(ctx)）')

    const bound = locale.bind?.(namespace)
    if (bound !== undefined)
      live = bound
    installations += 1

    const sync = (): void => localeBridge.sync(locale.getLocale().active)
    const unregisterZh = locale.register(namespace, 'zh', zh)
    const unregisterEn = locale.register(namespace, 'en', en)
    sync()
    const unsubscribe = locale.subscribe(sync)

    let disposed = false
    return () => {
      if (disposed)
        return
      disposed = true
      unsubscribe()
      unregisterZh()
      unregisterEn()
      installations -= 1
      if (installations === 0 && live === bound)
        live = undefined
    }
  }

  return {
    NS: namespace,
    text,
    activeLocale,
    isEnglishLocale,
    useLocale,
    registerLocale,
  }
}
