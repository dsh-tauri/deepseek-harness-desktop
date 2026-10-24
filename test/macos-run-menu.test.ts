import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const builderSource = readFileSync(new URL('../src-tauri/src/desktop/builder.rs', import.meta.url), 'utf8')
const navbarSource = readFileSync(new URL('../src/layout/components/navbar.tsx', import.meta.url), 'utf8')
const i18nSource = readFileSync(new URL('../src-tauri/src/config/i18n.rs', import.meta.url), 'utf8')

function submenuItems(id: string) {
  const match = builderSource.match(new RegExp(`"${id}",\\s*crate::config::i18n::t\\("[^"]+"\\),\\s*true,\\s*&\\[([\\s\\S]*?)\\],?\\s*\\)`))
  expect(match, `${id} must be installed with native menu items`).not.toBeNull()
  return match![1].match(/&\w+(?:\[\d+\])?/g)
}

describe('macOS native menu', () => {
  it('routes every Help link to a single shell window instead of broadcasting it', () => {
    const handler = builderSource.slice(builderSource.indexOf('.on_menu_event(|app, event|'))
    const helpActions = handler.slice(handler.indexOf('"desktop-documentation"'), handler.indexOf('#[cfg(target_os = "macos")]'))
    const broadcastActions = handler.slice(handler.indexOf('"desktop-config"'), handler.indexOf('_ => {}'))
    for (const action of ['desktop-documentation', 'desktop-feedback', 'desktop-harness-feedback']) {
      expect(helpActions).toContain(`"${action}"`)
      expect(broadcastActions).not.toContain(`"${action}"`)
    }
    expect(helpActions).toContain('help_menu_window_label(')
    expect(helpActions).toContain('app.emit_to(label, "macos-menu-action", event.id().as_ref())')
  })
  it('declares English and Simplified Chinese for system-provided menu items', () => {
    const plist = readFileSync(new URL('../src-tauri/Info.plist', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    const localizations = plist.match(/<key>CFBundleLocalizations<\/key>\s*<array>([\s\S]*?)<\/array>/)

    expect(localizations).not.toBeNull()
    expect([...localizations![1].matchAll(/<string>(.*?)<\/string>/g)].map(language => language[1])).toEqual(['en', 'zh-Hans'])
    expect(plist).toMatch(/<key>CFBundleDevelopmentRegion<\/key>\s*<string>en<\/string>/)
  })

  it('leaves system window actions to AppKit and matches the native bring-to-front label', () => {
    expect(submenuItems('desktop-window-menu')).toEqual([
      '&minimize',
      '&zoom',
      '&window_separator',
      '&bring_all_to_front',
    ])
    expect(i18nSource).toContain('"menu.bring_all_to_front" => ("全部置于顶层", "Bring All to Front", "모두 앞으로", "Все окна на передний план")')
  })

  it('keeps the accepted native system menus at the top level', () => {
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

  it('binds the standard editing selectors so ⌘X/⌘C/⌘V/⌘A/⌘Z reach the webview (issue #860)', () => {
    expect(submenuItems('desktop-edit-menu')).toEqual([
      '&undo',
      '&redo',
      '&edit_separator',
      '&cut',
      '&copy',
      '&paste',
      '&select_all',
    ])
    for (const item of ['undo', 'redo', 'cut', 'copy', 'paste', 'select_all'])
      expect(builderSource).toContain(`PredefinedMenuItem::${item}(app, Some(&crate::config::i18n::t("menu.${item}")))`)
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
    ['desktop-config', 'application', 'menu.settings', '设置…', 'Settings…', '설정…', 'Настройки…'],
    ['desktop-profiles', 'profiles', 'menu.profiles', '档案管理…', 'Manage Profiles…', '프로파일 관리…', 'Управление профилями…'],
    ['desktop-plugins', 'plugins', 'menu.plugins', '插件管理…', 'Manage Plugins…', '플러그인 관리…', 'Управление плагинами…'],
    ['desktop-harness', 'harness', 'menu.harness', '核心管理…', 'Manage Core…', '코어 관리…', 'Управление ядром…'],
  ])('routes %s from its native item to the %s configuration tab', (action, tab, key, zh, en, ko, ru) => {
    expect(builderSource).toMatch(new RegExp(`MenuItem::with_id\\(\\s*app,\\s*"${action}",\\s*crate::config::i18n::t\\("${key}"\\)`))
    const eventHandler = builderSource.slice(builderSource.indexOf('.on_menu_event(|app, event|'))
    expect(eventHandler).toMatch(new RegExp(`"${action}"[\\s\\S]*?app.emit_to\\(label, "macos-menu-action", event.id\\(\\).as_ref\\(\\)\\)`))
    expect(navbarSource).toMatch(new RegExp(`case '${action}':\\s*handleOpenConfig\\('${tab}'\\)`))
    expect(i18nSource).toContain(`"${key}" => ("${zh}", "${en}", "${ko}", "${ru}")`)
  })

  it('groups feedback links before run logs, developer tools and the task manager in Help', () => {
    expect(submenuItems('desktop-help-menu')).toEqual([
      '&documentation',
      '&keyboard_shortcuts',
      '&help_separator',
      '&desktop_feedback',
      '&harness_feedback',
      '&feedback_separator',
      '&run_logs',
      '&toggle_devtools',
      '&task_manager',
    ])
    expect(i18nSource).toContain('"menu.toggle_devtools" => ("切换开发者工具", "Toggle Developer Tools", "개발자 도구 전환", "Инструменты разработчика")')
    expect(i18nSource).toContain('"menu.task_manager" => ("任务管理器", "Task Manager", "작업 관리자", "Диспетчер задач")')
  })

  it('provides the native Run title in both languages', () => {
    expect(i18nSource).toContain('"menu.run" => ("运行与管理", "Run & Manage", "실행 및 관리", "Запуск и управление")')
    expect(i18nSource).toContain('"menu.restart" => ("重启 Harness", "Restart Harness", "Harness 다시 시작", "Перезапустить Harness")')
  })

  it('toggles the focused shell window from View without suppressing AppKit fullscreen in Window', () => {
    expect(submenuItems('desktop-view-menu')).toEqual([
      '&view_commands[0]',
      '&view_commands[1]',
      '&view_commands[2]',
      '&view_commands[3]',
      '&view_separator',
      '&zoom_in',
      '&zoom_out',
      '&zoom_reset',
      '&fullscreen_separator',
      '&fullscreen',
    ])
    expect(builderSource).not.toContain('PredefinedMenuItem::fullscreen(')
    expect(builderSource).toMatch(/MenuItem::with_id\(\s*app,\s*"desktop-fullscreen",\s*&fullscreen_label,\s*true,\s*Some\("Ctrl\+Super\+F"\)/)
    const handler = builderSource.slice(builderSource.indexOf('"desktop-fullscreen" =>'))
    expect(handler).toContain('window.label() != crate::desktop::pet::PET_WINDOW_LABEL')
    expect(handler).toContain('window.is_focused().unwrap_or(false)')
    expect(handler).toContain('.and_then(|is_fullscreen| window.set_fullscreen(!is_fullscreen))')
    expect(builderSource).toMatch(/tauri::WindowEvent::Focused\(true\) => sync_macos_fullscreen_menu\(window\)/)
    expect(builderSource).toMatch(/fn fullscreen_menu_label_key\(is_fullscreen: bool\) -> &'static str \{\s*if is_fullscreen \{\s*"menu.exit_fullscreen"\s*\} else \{\s*"menu.enter_fullscreen"\s*\}/)
    expect(builderSource).toContain('let fullscreen_label = crate::config::i18n::t(fullscreen_menu_label_key(is_fullscreen));')
    expect(builderSource).toContain('let label = crate::config::i18n::t(fullscreen_menu_label_key(is_fullscreen));')
    expect(builderSource).toContain('Some(fullscreen)')
    expect(builderSource).toContain('sync_macos_fullscreen_menu(window)')
  })

  it('routes View actions only to the focused shell window', () => {
    const handler = builderSource.slice(builderSource.indexOf('"desktop-toggle-sidebar"\n'))
    expect(handler).toContain('window.label() != crate::desktop::pet::PET_WINDOW_LABEL')
    expect(handler).toContain('window.is_focused().unwrap_or(false)')
    expect(handler).toMatch(/app\.emit_to\(\s*window.label\(\),\s*"macos-menu-action",\s*event.id\(\).as_ref\(\),?\s*\)/)
  })

  it('routes shell commands to one window instead of broadcasting them', () => {
    const handler = builderSource.slice(builderSource.indexOf('.on_menu_event(|app, event|'))
    const shellActions = handler.slice(handler.indexOf('"desktop-config"'), handler.indexOf('_ => {}'))

    for (const action of [
      'desktop-config',
      'desktop-profiles',
      'desktop-plugins',
      'desktop-harness',
      'desktop-about',
      'desktop-copy-run-logs',
      'desktop-check-update',
      'desktop-restart',
      'desktop-keyboard-shortcuts',
      'desktop-new-window',
      'desktop-new-chat',
      'desktop-open-folder',
    ]) {
      expect(shellActions).toContain(`"${action}"`)
    }
    expect(shellActions).toContain('menu_action_window_label(')
    expect(shellActions).toContain('app.emit_to(label, "macos-menu-action", event.id().as_ref())')
    expect(handler).not.toContain('app.emit("macos-menu-action"')
  })

  it('requests current window state only after the rebuilt native menu is installed', () => {
    const install = builderSource.slice(builderSource.indexOf('pub fn install_macos_menu('), builderSource.indexOf('fn fullscreen_menu_label_key'))
    expect(install).toMatch(/app\.set_menu\(menu\)\?[\s\S]*window_menu\.set_as_windows_menu_for_nsapp\(\)\?[\s\S]*app\.emit\("macos-menu-rebuilt", \(\)\)\?/)
  })
})
