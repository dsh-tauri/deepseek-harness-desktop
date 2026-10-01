import { describe, expect, it } from 'vitest'
import { readSource } from './setup/read-source'

const builderSource = readSource('src-tauri/src/desktop/builder.rs')
const i18nSource = readSource('src-tauri/src/config/i18n.rs')
const navbarSource = readSource('src/layout/components/navbar.tsx')

describe('menu restart backend contract', () => {
  it('places desktop-restart after the configuration tabs in the Run submenu', () => {
    const runMenu = builderSource.match(/"desktop-run-menu",[\s\S]*?&\[([^\]]+)\]/)
    expect(runMenu).not.toBeNull()
    expect(runMenu![1]).toMatch(/&harness,\s*&run_separator,\s*&restart/)
  })

  it('emits macos-menu-action for desktop-restart in on_menu_event', () => {
    expect(builderSource).toContain('desktop-restart')
    expect(builderSource).toContain('desktop-copy-run-logs')
  })

  it('provides menu.restart i18n key with zh/en translations', () => {
    // 断言键→值的关系，而非孤立 token：要求 "menu.restart" 同时映射到
    // 中文 "重启" 与英文 "Restart"，避免 token 出现在无关代码中时仍能通过。
    expect(i18nSource).toMatch(
      /"menu\.restart"\s*=>\s*\("重启",\s*"Restart"\)/,
    )
  })
})

describe('menu restart frontend contract', () => {
  it('subscribes to the macOS menu event inside the navbar', () => {
    // use-macos-app-menu 已内联进 navbar：断言订阅与事件名都在 navbar 里
    expect(navbarSource).toContain('useListen<string>')
    expect(navbarSource).toContain('\'macos-menu-action\'')
  })

  it('dispatches every native menu action', () => {
    for (const action of [
      'desktop-config',
      'desktop-about',
      'desktop-copy-run-logs',
      'desktop-check-update',
      'desktop-restart',
      'desktop-keyboard-shortcuts',
    ]) {
      expect(navbarSource).toContain(`case '${action}':`)
    }
  })

  it('dispatches desktop-restart to store.harness.restart()', () => {
    // 断言 menu-event case 到 restart 的分发关系，而非孤立 token。
    expect(navbarSource).toMatch(
      /case 'desktop-restart':\s*void store\.harness\.restart\(\)/,
    )
  })
})
