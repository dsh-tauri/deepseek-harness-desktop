import { describe, expect, it } from 'vitest'
import { REMOTE_PLUGIN_NAME } from '../../shared/constants'
import { LOCALE_EFFECT, PLUGIN_ID, POLL_EFFECT, REMOTE_TABS_ID, SECTION_EFFECT, SETTINGS_SECTION_ID } from './index'

describe('client identity derivation', () => {
  it('derives the settings section and locale namespace from the plugin name', () => {
    expect(REMOTE_PLUGIN_NAME).toBe('dsh-tauri-remote')
    expect(PLUGIN_ID).toBe(REMOTE_PLUGIN_NAME)
    expect(SETTINGS_SECTION_ID).toBe(REMOTE_PLUGIN_NAME)
  })

  it('derives the tabs id and every effect label from the plugin name', () => {
    expect(REMOTE_TABS_ID).toBe(`${REMOTE_PLUGIN_NAME}-tabs`)
    expect([LOCALE_EFFECT, SECTION_EFFECT, POLL_EFFECT]).toEqual([
      `${PLUGIN_ID}: locale`,
      `${PLUGIN_ID}: settings section`,
      `${PLUGIN_ID}: machine polling`,
    ])
  })
})
