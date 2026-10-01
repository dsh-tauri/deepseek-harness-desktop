import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const builderSource = readFileSync(new URL('../src-tauri/src/desktop/builder.rs', import.meta.url), 'utf8')
const navbarSource = readFileSync(new URL('../src/layout/components/navbar.tsx', import.meta.url), 'utf8')
const i18nSource = readFileSync(new URL('../src-tauri/src/config/i18n.rs', import.meta.url), 'utf8')

function submenuItems(id: string) {
  const match = builderSource.match(new RegExp(`"${id}",\\s*crate::config::i18n::t\\("[^"]+"\\),\\s*true,\\s*&\\[([^\\]]+)\\]`))
  expect(match, `${id} must be installed with native menu items`).not.toBeNull()
  return match![1].match(/&\w+/g)
}

describe('macOS native menu', () => {
  it('orders File, Edit, View, Run, Window and Help after the macOS application menu', () => {
    const nativeMenuSource = builderSource.slice(builderSource.indexOf('pub fn install_macos_menu('))
    const menu = nativeMenuSource.match(/let menu = Menu::with_items\(\s*app,\s*&\[([^\]]+)\]/)
    expect(menu).not.toBeNull()
    expect(menu![1].match(/&\w+/g)).toEqual([
      '&system_application_menu',
      '&file_menu',
      '&edit_menu',
      '&view_menu',
      '&run_menu',
      '&window_menu',
      '&help_menu',
    ])
    expect(builderSource).not.toContain('"desktop-application-menu"')
    expect(nativeMenuSource).toContain('window_menu.set_as_windows_menu_for_nsapp()?')
    expect(nativeMenuSource).toContain('help_menu.set_as_help_menu_for_nsapp()?')
  })

  it('places Profiles, Plugins, Core and Restart in the Run submenu', () => {
    expect(submenuItems('desktop-run-menu')).toEqual([
      '&profiles',
      '&plugins',
      '&harness',
      '&run_separator',
      '&restart',
    ])
    expect(builderSource).toMatch(/"desktop-run-menu",\s*crate::config::i18n::t\("menu.run"\)/)
  })

  it.each([
    ['desktop-config', 'application', 'menu.settings', '设置…', 'Settings…'],
    ['desktop-profiles', 'profiles', 'menu.profiles', '档案', 'Profiles'],
    ['desktop-plugins', 'plugins', 'menu.plugins', '插件', 'Plugins'],
    ['desktop-harness', 'harness', 'menu.harness', '核心', 'Core'],
  ])('routes %s from its native item to the %s configuration tab', (action, tab, key, zh, en) => {
    expect(builderSource).toMatch(new RegExp(`MenuItem::with_id\\(\\s*app,\\s*"${action}",\\s*crate::config::i18n::t\\("${key}"\\)`))
    const eventHandler = builderSource.slice(builderSource.indexOf('.on_menu_event(|app, event|'))
    expect(eventHandler).toMatch(new RegExp(`"${action}"[\\s\\S]*?app.emit\\("macos-menu-action", event.id\\(\\).as_ref\\(\\)\\)`))
    expect(navbarSource).toMatch(new RegExp(`case '${action}':\\s*handleOpenConfig\\('${tab}'\\)`))
    expect(i18nSource).toContain(`"${key}" => ("${zh}", "${en}")`)
  })

  it('provides the native Run title in both languages', () => {
    expect(i18nSource).toContain('"menu.run" => ("运行", "Run")')
  })

  it('keeps fullscreen as a native action with state-dependent labels', () => {
    expect(submenuItems('desktop-view-menu')).toEqual(['&fullscreen'])
    expect(builderSource).toContain('PredefinedMenuItem::fullscreen(app, Some(&fullscreen_label))?')
    expect(builderSource).toMatch(/fn fullscreen_menu_label_key\(is_fullscreen: bool\) -> &'static str \{\s*if is_fullscreen \{\s*"menu.exit_fullscreen"\s*\} else \{\s*"menu.enter_fullscreen"\s*\}/)
    expect(builderSource).toContain('let fullscreen_label = crate::config::i18n::t(fullscreen_menu_label_key(is_fullscreen));')
    expect(builderSource).toContain('let label = crate::config::i18n::t(fullscreen_menu_label_key(is_fullscreen));')
    expect(builderSource).toContain('Some(fullscreen)')
    expect(builderSource).toContain('sync_macos_fullscreen_menu(window)')
  })
})
