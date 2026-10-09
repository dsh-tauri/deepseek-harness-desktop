import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const tauriRoot = new URL('../src-tauri/', import.meta.url)
const config = JSON.parse(readFileSync(new URL('tauri.conf.json', tauriRoot), 'utf8'))
const nightly = JSON.parse(readFileSync(new URL('tauri.nightly.conf.json', tauriRoot), 'utf8'))

describe('native application identity', () => {
  it('configures a bundled PNG rather than an executable icon resource', () => {
    expect(config.plugins.notifications.windows.iconPath).toBe('icons/32x32.png')
    expect(config.bundle.resources).toContain('icons/32x32.png')
    const icon = readFileSync(fileURLToPath(new URL('icons/32x32.png', tauriRoot)))
    expect([...icon.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(icon.readUInt32BE(16)).toBe(32)
    expect(icon.readUInt32BE(20)).toBe(32)
  })

  it('nightly uses a separate notification identity and its bundled icon', () => {
    expect(nightly.identifier).toBe('dsh-tauri-nightly')
    expect(nightly.productName).toBe('DSH Tauri Nightly')
    expect(nightly.mainBinaryName).toBe('deepseek-harness-desktop-nightly')
    expect(config.identifier).toBe('dsh-tauri')
    expect(config.productName).toBe('DSH Tauri')
    expect(nightly.plugins.notifications.windows.toastActivatorClsid).toBe('77B0D48C-22BB-46A8-B57D-895B403B3148')
    expect(nightly.plugins.notifications.windows.toastActivatorClsid).not.toBe(config.plugins.notifications.windows.toastActivatorClsid)
    expect(nightly.plugins.notifications.windows.iconPath).toBe('icons/nightly/32x32.png')
    expect(nightly.bundle.resources).toContain('icons/nightly/32x32.png')
    const icon = readFileSync(new URL('icons/nightly/32x32.png', tauriRoot))
    expect([...icon.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(icon.readUInt32BE(16)).toBe(32)
    expect(icon.readUInt32BE(20)).toBe(32)
    expect(nightly.plugins['deep-link'].desktop.schemes).toEqual(['dsh-nightly'])
    expect(config.plugins['deep-link'].desktop.schemes).toEqual(['dsh'])
    expect(config.bundle.windows.wix.upgradeCode).toBe('d6340322-9fd6-54cd-a64f-28a2ade67a65')
    expect(nightly.bundle.windows.wix.upgradeCode).toBe('11f927a0-72f4-5b2c-b24a-6b1c0fb6602f')
    expect(nightly.bundle.windows.wix.fragmentPaths).toEqual(['./windows/fragments/autostart-cleanup-nightly.wxs'])
  })

  it('stable Debian packages take over the legacy package instead of colliding with its binary', () => {
    expect(config.bundle.linux?.deb?.conflicts).toEqual(['deepseek-harness-desktop'])
    expect(config.bundle.linux?.deb?.replaces).toEqual(['deepseek-harness-desktop'])
  })

  it('nightly Debian packages clear the inherited legacy takeover to coexist with stable', () => {
    expect(nightly.bundle.linux?.deb?.conflicts).toEqual([])
    expect(nightly.bundle.linux?.deb?.replaces).toEqual([])
  })

  it('writes a plain IconUri because the verbatim form is ignored by the toast platform', () => {
    const source = readFileSync(
      new URL('vendor/tauri-plugin-notifications/src/windows.rs', tauriRoot),
      'utf8',
    )
    expect(source).toContain('Some("IconUri"), &plain_icon_path(path)')
    expect(source).not.toContain('Some("IconUri"), &path.to_string_lossy()')
    expect(source).toContain(String.raw`strip_prefix(r"\\?\")`)
    expect(source).toContain(String.raw`strip_prefix(r"\\?\UNC\")`)
  })
})
