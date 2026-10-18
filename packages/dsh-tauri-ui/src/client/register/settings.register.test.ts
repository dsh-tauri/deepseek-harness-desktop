import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerSettings } from './settings'

const mocks = vi.hoisted(() => ({
  settings: {
    launcherAvailable: false,
    launcherShortcut: undefined as { keys: readonly string[], aria?: string } | undefined,
    setLauncherAvailable(value: boolean): void {
      mocks.settings.launcherAvailable = value
    },
    setLauncherShortcut(value: { keys: readonly string[], aria?: string } | undefined): void {
      mocks.settings.launcherShortcut = value
    },
  },
}))

vi.mock('../store', () => ({ store: { settings: mocks.settings } }))
vi.mock('../ui/settings-sidebar', () => ({ SettingsSidebar: () => null }))
vi.mock('../ui/settings-trigger', () => ({ SettingsTrigger: () => null }))
vi.mock('@deepseek-ai/dsh-client-ui-renderer', () => ({ SlotOutlet: () => null }))
vi.mock('dsh-tauri/client', async () => ({
  ...await import('../../../../dsh-tauri/src/client/register'),
  ...await import('../../../../dsh-tauri/src/client/modules/reause'),
  ...await import('../../../../dsh-tauri/src/client/utils/device'),
}))

interface MatchMediaHost {
  window?: { matchMedia?: (query: string) => { matches: boolean } }
}

const host = globalThis as unknown as MatchMediaHost
const originalWindow = host.window
const disposers: Array<() => void> = []

/** 手机端才有三条设备查询加窄屏门槛全部成立；触屏为主但另接鼠标的设备缺 `(any-hover: none)`。 */
const MOBILE_DEVICE = {
  '(pointer: coarse)': true,
  '(any-pointer: coarse)': true,
  '(any-hover: none)': true,
  '(max-width: 1023px)': true,
}
const TOUCHSCREEN_WITH_MOUSE = {
  '(pointer: coarse)': true,
  '(any-pointer: coarse)': true,
  '(any-hover: none)': false,
}
/** issue #1128：触屏笔记本命中三条指针查询，但宽度在 1024px 以上仍走桌面布局。 */
const TOUCHSCREEN_DESKTOP = {
  '(pointer: coarse)': true,
  '(any-pointer: coarse)': true,
  '(any-hover: none)': true,
  '(max-width: 1023px)': false,
}

function stubDevice(answers: Record<string, boolean>): void {
  host.window = {
    ...host.window,
    matchMedia: (query: string) => ({ matches: answers[query] ?? false }),
  }
}

afterEach(() => {
  for (const dispose of disposers.splice(0))
    dispose()
  host.window = originalWindow
  mocks.settings.launcherAvailable = false
  mocks.settings.launcherShortcut = undefined
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** 用最小 slots 面记录注入点：inject 只登记，register 由激活回调按需触发。 */
function activate(shortcuts?: unknown) {
  const injected: Array<{ key: string, activate: () => unknown }> = []
  const registered: string[] = []
  const ctx = {
    slots: {
      inject(key: string, callback: () => unknown) {
        let dispose: (() => void) | undefined
        injected.push({
          key,
          activate() {
            const result = callback()
            if (typeof result === 'function')
              dispose = result as () => void
            return result
          },
        })
        return () => dispose?.()
      },
      register(options: { name: string }) {
        registered.push(options.name)
        return (): void => {}
      },
    },
    effect(callback: () => () => void) {
      return callback()
    },
    get: (name: string) => name === 'slots' ? ctx.slots : shortcuts,
  }

  disposers.push(registerSettings.call(ctx))

  return { injected, registered }
}

describe('registerSettings launcher seat', () => {
  it('registers the settings seats and probes the official launcher slot', () => {
    const { injected, registered } = activate()

    expect(injected.map(entry => entry.key)).toEqual([
      'shell.overlay',
      'sidebar.settings',
      'settings.launcher',
    ])

    for (const entry of injected)
      entry.activate()

    expect(registered).toContain('shell.overlay')
    expect(registered).toContain('sidebar.settings')
  })

  /** 手机端把 `sidebar.settings` 交还官方：自有侧栏与触发器都不许抢座位。 */
  it('leaves every settings seat to the official dialog on mobile', () => {
    stubDevice(MOBILE_DEVICE)

    const { injected, registered } = activate()

    expect(injected).toEqual([])
    expect(registered).toEqual([])
  })

  /** 触屏为主但接了鼠标的设备仍有鼠标可用：不能被手机端判据误伤。 */
  it('keeps the own sidebar on a touchscreen with a secondary mouse', () => {
    stubDevice(TOUCHSCREEN_WITH_MOUSE)

    const { injected } = activate()

    expect(injected.map(entry => entry.key)).toEqual([
      'shell.overlay',
      'sidebar.settings',
      'settings.launcher',
    ])
  })

  /** 触屏笔记本在桌面宽度下仍可用鼠标式设置面板：不能被手机端判据误伤。 */
  it('keeps the own sidebar on a touchscreen desktop window', () => {
    stubDevice(TOUCHSCREEN_DESKTOP)

    const { injected } = activate()

    expect(injected.map(entry => entry.key)).toEqual([
      'shell.overlay',
      'sidebar.settings',
      'settings.launcher',
    ])
  })

  /** 桌面端仍走自有侧栏，手机端判据不误伤。 */
  it('keeps the own sidebar on a touchscreen desktop', () => {
    stubDevice({ '(pointer: coarse)': false, '(any-pointer: coarse)': true, '(any-hover: none)': false })

    const { injected } = activate()

    expect(injected.map(entry => entry.key)).toEqual([
      'shell.overlay',
      'sidebar.settings',
      'settings.launcher',
    ])
  })

  /** 官方账号菜单落在 `settings.launcher`：声明前必须退回自有触发器，声明后由官方条目渲染。 */
  it('hosts the official account launcher only while it is declared', () => {
    const { injected } = activate()
    const launcher = injected.find(entry => entry.key === 'settings.launcher')

    expect(launcher).toBeDefined()
    const dispose = launcher?.activate() as (() => void) | undefined
    expect(mocks.settings.launcherAvailable).toBe(true)

    dispose?.()
    expect(mocks.settings.launcherAvailable).toBe(false)
  })

  /** 左下菜单的「Ctrl+,」提示来自核心 `settings.open` 的生效绑定，配置变更后重发。 */
  it('publishes the settings shortcut for the official launcher', () => {
    let notify = (): void => {}
    const { injected } = activate({
      catalog: {
        getSnapshot: () => [
          { id: 'session.new', keys: ['Ctrl+N'] },
          { id: 'settings.open', keys: ['Ctrl+,'], aria: 'Control+,' },
        ],
        subscribe(listener: () => void) {
          notify = listener
          return (): void => {}
        },
      },
    })

    for (const entry of injected)
      entry.activate()

    expect(mocks.settings.launcherShortcut).toEqual({ keys: ['Ctrl+,'], aria: 'Control+,' })

    notify()
    expect(mocks.settings.launcherShortcut).toEqual({ keys: ['Ctrl+,'], aria: 'Control+,' })
  })

  /** 老核心没有快捷键服务：不写值，座位拿不到就不渲染提示。 */
  it('leaves the shortcut unset without the core service', () => {
    const { injected } = activate()

    for (const entry of injected)
      entry.activate()

    expect(mocks.settings.launcherShortcut).toBeUndefined()
  })
})
