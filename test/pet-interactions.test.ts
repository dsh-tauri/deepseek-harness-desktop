import { describe, expect, it } from 'vitest'
import en from '../src/i18n/locales/en-US.json'
import zh from '../src/i18n/locales/zh-CN.json'
import ru from '../src/i18n/locales/ru-RU.json'
import { readSource } from './setup/read-source'

const bridge = readSource('src-tauri/src/bridge/pet.rs')
const builder = readSource('src-tauri/src/desktop/builder.rs')
const translations = readSource('src-tauri/src/config/i18n.rs')

describe('pet native interaction wiring', () => {
  it.each(['pet_show_main_window', 'pet_show_context_menu'])('registers %s and restricts it to the pet window', (command) => {
    expect(builder).toContain(`crate::bridge::${command},`)
    const body = bridge.split(`pub fn ${command}(`)[1].split('\n}\n')[0]
    expect(body).toContain('window.label() != pet_window::PET_WINDOW_LABEL')
    expect(body).toContain('PET_WINDOW_LABEL_MISMATCH:')
  })

  it('uses the shared native restoration path for double-click and menu activation', () => {
    const body = bridge.split('pub fn pet_show_main_window(')[1].split('\n}\n')[0]
    expect(body).toContain('crate::utils::show_main_window(window.app_handle())')
    expect(builder).toContain('"pet-show-main-window" => show_main_window(app)')
  })

  it('creates only show-main and close actions in the pet native popup', () => {
    const body = bridge.split('pub fn pet_show_context_menu(')[1].split('\n}\n')[0]
    expect([...body.matchAll(/"(pet-[a-z-]+)"/g)].map(match => match[1])).toEqual(['pet-show-main-window', 'pet-close'])
    expect(body).toContain('Menu::with_items(app, &[&show, &close])')
    expect(body).toContain('.popup_menu(&menu)')
  })

  it('closes the pet through the persistent disable path instead of hiding or quitting', () => {
    const action = builder.split('"pet-close" => {')[1].split('"desktop-toggle-sidebar"')[0]
    expect(action).toContain('crate::bridge::set_pet_enabled(app.clone(), false)')
    expect(action).not.toMatch(/\.hide\(|\.exit\(/)
  })

  it.each([
    ['pet.show_main_window', '显示主界面', 'Show Main Window', '기본 창 표시', 'Показать главное окно'],
    ['pet.close', '关闭宠物', 'Close Pet', '펫 닫기', 'Закрыть питомца'],
  ] as const)('keeps %s translated consistently in the shell and native menu', (key, chinese, english, korean, russian) => {
    expect(zh[key]).toBe(chinese)
    expect(en[key]).toBe(english)
    expect(ru[key]).toBe(russian)
    expect(translations).toContain(`"${key}" => ("${chinese}", "${english}", "${korean}", "${russian}")`)
    expect(bridge).toContain(`config::i18n::t("${key}")`)
  })
})
