import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => {}),
  changeLanguage: vi.fn(async () => {}),
  setting: { language: null as string | null },
  stored: new Map<string, string>(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('i18next', () => {
  const instance = {
    use: () => instance,
    init: () => instance,
    t: (key: string) => key,
    changeLanguage: mocks.changeLanguage,
  }
  return { default: instance }
})
vi.mock('react-i18next', () => ({ initReactI18next: {} }))
vi.mock('../store', () => ({ store: { setting: mocks.setting } }))

const { changeLanguage, i18n } = await import('./index')

beforeEach(() => {
  mocks.invoke.mockClear()
  mocks.changeLanguage.mockClear()
  mocks.setting.language = null
  mocks.stored.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => mocks.stored.get(key) ?? null,
    setItem: (key: string, value: string) => mocks.stored.set(key, value),
  })
})

describe('changeLanguage', () => {
  it('归一化后同时写壳层、前端存储与核心偏好', async () => {
    await changeLanguage('zh_CN.UTF-8')

    expect(i18n).toBeDefined()
    expect(mocks.changeLanguage).toHaveBeenCalledWith('zh-CN')
    expect(mocks.stored.get('deepseek-harness-desktop-language')).toBe('zh-CN')
    expect(mocks.setting.language).toBe('zh-CN')
    expect(mocks.invoke).toHaveBeenCalledWith('set_language', { lang: 'zh' })
  })

  it('把未打包语言回落到英文，而不是写进持久化', async () => {
    await changeLanguage('fr-FR')

    expect(mocks.changeLanguage).toHaveBeenCalledWith('en-US')
    expect(mocks.stored.get('deepseek-harness-desktop-language')).toBe('en-US')
    expect(mocks.invoke).toHaveBeenCalledWith('set_language', { lang: 'en' })
  })

  it('给核心的短码与桌面端语言保持一致', async () => {
    for (const [input, expected] of [['ko-KR', 'ko'], ['ru_RU@euro', 'ru'], ['en-GB', 'en']] as const) {
      mocks.invoke.mockClear()
      await changeLanguage(input)
      expect(mocks.invoke).toHaveBeenCalledWith('set_language', { lang: expected })
    }
  })
})
