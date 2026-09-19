import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// ── Suite A — i18n keys exist (source assertion on JSON) ─────────────────────
describe('plugin preset chip i18n keys', () => {
  it('provides plugins.preset in en-US = "Preset"', () => {
    const source = readFileSync(new URL('../src/i18n/locales/en-US.json', import.meta.url), 'utf8')
    const messages = JSON.parse(source) as Record<string, string>
    expect(messages).toHaveProperty('plugins.preset')
    expect(messages['plugins.preset']).toBe('Preset')
  })

  it('provides plugins.preset in zh-CN = "预设"', () => {
    const source = readFileSync(new URL('../src/i18n/locales/zh-CN.json', import.meta.url), 'utf8')
    const messages = JSON.parse(source) as Record<string, string>
    expect(messages).toHaveProperty('plugins.preset')
    expect(messages['plugins.preset']).toBe('预设')
  })

  it('updates plugins.panel_tooltip in en-US to mention uninstall', () => {
    const source = readFileSync(new URL('../src/i18n/locales/en-US.json', import.meta.url), 'utf8')
    const messages = JSON.parse(source) as Record<string, string>
    expect(messages['plugins.panel_tooltip']).toContain('Preset plugins can be uninstalled here')
  })

  it('updates plugins.panel_tooltip in zh-CN to mention uninstall', () => {
    const source = readFileSync(new URL('../src/i18n/locales/zh-CN.json', import.meta.url), 'utf8')
    const messages = JSON.parse(source) as Record<string, string>
    expect(messages['plugins.panel_tooltip']).toContain('预设插件可在此卸载')
  })
})

// ── Suite B — component references the preset key + condition ────────────────
describe('configPlugin preset chip', () => {
  it('renders the plugins.preset key', () => {
    const source = readFileSync(new URL('../src/ui/config/plugin.tsx', import.meta.url), 'utf8')
    expect(source).toContain('plugins.preset')
  })

  it('guards the chip on recommended (preset, non-internal)', () => {
    const source = readFileSync(new URL('../src/ui/config/plugin.tsx', import.meta.url), 'utf8')
    expect(source).toContain('!plugin.internal && plugin.recommended')
  })
})

// ── Suite C — uninstall flow wires to remove_dsh_plugin + restart ────────────
describe('configPlugin uninstall flow', () => {
  it('calls remove_dsh_plugin', () => {
    const source = readFileSync(new URL('../src/ui/config/plugin.tsx', import.meta.url), 'utf8')
    expect(source).toContain('remove_dsh_plugin')
  })

  it('restarts the service after uninstall', () => {
    const source = readFileSync(new URL('../src/ui/config/plugin.tsx', import.meta.url), 'utf8')
    expect(source).toContain('store.harness.restart()')
  })

  it('shows a confirm dialog before uninstall', () => {
    const source = readFileSync(new URL('../src/ui/config/plugin.tsx', import.meta.url), 'utf8')
    expect(source).toContain('remove_confirm_title')
  })
})
