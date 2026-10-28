import { describe, expect, it } from 'vitest'
import { APPEARANCE_DEFAULTS, APPEARANCE_PALETTES, appearanceBootCss, appearanceColors, appearanceSidebarFill, appearanceStartupFill, appearanceTokens, normalizeAppearance } from './appearance'

describe('appearance preferences', () => {
  it('migrates old transparency settings but respects an explicit disabled switch', () => {
    expect(normalizeAppearance({ opacity: 70 })).toMatchObject({ transparency: true, sidebarOnly: false })
    expect(normalizeAppearance({ opacity: 70, transparency: false })).toMatchObject({ transparency: false, opacity: 70 })
    expect(normalizeAppearance({ opacity: 100, transparency: true, sidebarOnly: true })).toMatchObject({ transparency: true, sidebarOnly: true })
  })

  it.each([undefined, null, {}, 1, 'nord', { palette: 'missing', terminal: 'true', opacity: Number.NaN }])('keeps original defaults for invalid or missing preferences: %j', (value) => {
    expect(normalizeAppearance(value)).toEqual(APPEARANCE_DEFAULTS)
  })

  it.each([[0, 20], [255, 100], [77.4, 77], [80, 80]])('normalizes opacity %s to %s', (input, opacity) => {
    expect(normalizeAppearance({ palette: 'nord', terminal: true, opacity: input })).toEqual({ palette: 'nord', terminal: true, transparency: opacity < 100, opacity, blur: false, sidebarOnly: false })
  })

  it.each([[false, false], [true, true], [0, false], [1, true], [40, true]])('normalizes blur %s to %s', (input, expected) => {
    expect(normalizeAppearance({ transparency: true, opacity: 70, blur: input }).blur).toBe(expected)
  })

  it.each([
    [true, 70, 'color-mix(in srgb,#2e3440 70%,transparent)'],
    [true, 100, 'color-mix(in srgb,#2e3440 100%,transparent)'],
    [false, 70, '#343c4a'],
  ])('gives the shell bar the sidebar column fill for translucent=%s at %s%%', (translucent, percent, expected) => {
    expect(appearanceSidebarFill('#2e3440', '#343c4a', translucent, percent)).toBe(expected)
  })

  it.each([
    [{ transparency: true, opacity: 70 }, 'color-mix(in srgb,#2e3440 70%,transparent)'],
    [{ transparency: true, opacity: 70, sidebarOnly: true }, 'color-mix(in srgb,#2e3440 70%,transparent)'],
    [{ transparency: true, opacity: 100 }, '#2e3440'],
    [{ transparency: false, opacity: 70 }, '#2e3440'],
  ])('fills startup surfaces like the shell bar for preferences=%j', (preferences, expected) => {
    expect(appearanceStartupFill(normalizeAppearance({ palette: 'nord', ...preferences }), '#2e3440')).toBe(expected)
  })

  it('projects the boot page onto the window behind it without doubling the alpha', () => {
    const css = appearanceBootCss(normalizeAppearance({ palette: 'nord', transparency: true, opacity: 70 }))
    expect(css).toContain('html:has(>body>#root>[data-dsh-boot]),body:has(>#root>[data-dsh-boot]),#root:has(>[data-dsh-boot]){background:transparent!important}')
    expect(css).toContain('body[data-ds-dark-theme] > #root > [data-dsh-boot]{background:color-mix(in srgb,#2e3440 70%,transparent)!important}')
    expect(css).toContain('body:not([data-ds-dark-theme]) > #root > [data-dsh-boot]{background:color-mix(in srgb,#eceff4 70%,transparent)!important}')
    expect(css).not.toContain('data-dsh-boot]{background:#2e3440')
  })

  it.each([
    [{ palette: 'nord', transparency: false, opacity: 70 }],
    [{ palette: 'nord', transparency: true, opacity: 100 }],
  ])('leaves the boot page opaque for preferences=%j', (preferences) => {
    expect(appearanceBootCss(normalizeAppearance(preferences))).toBe('')
  })

  it.each(['github', 'github-dimmed', 'github-high-contrast'])('preserves the saved %s palette', (palette) => {
    expect(normalizeAppearance({ palette }).palette).toBe(palette)
  })

  it.each(['light', 'dark'] as const)('keeps high-contrast text at 7:1 and borders at 3:1 in %s mode', (scheme) => {
    const tokens = appearanceTokens(normalizeAppearance({ palette: 'github-high-contrast' }))
    for (const background of ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2']) {
      for (const foreground of ['--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary', '--dsw-alias-label-caption', '--dsw-alias-link', '--dsw-alias-border-l2']) {
        const [dark, light] = [luminance(tokens[background][scheme]), luminance(tokens[foreground][scheme])].sort((a, b) => a - b)
        const minimum = foreground.includes('border') ? 3 : foreground.includes('link') ? 4.5 : 7
        expect((light + 0.05) / (dark + 0.05), `${foreground} on ${background}`).toBeGreaterThanOrEqual(minimum)
      }
    }
  })

  it('does not override core theme tokens under default settings', () => {
    expect(appearanceTokens(APPEARANCE_DEFAULTS)).toEqual({})
  })

  it.each(APPEARANCE_PALETTES)('keeps %s text readable on all opaque palette surfaces in both modes', (palette) => {
    for (const scheme of ['light', 'dark'] as const) {
      const colors = appearanceColors({ ...APPEARANCE_DEFAULTS, palette }, scheme)
      for (const background of [colors.canvas, colors.panel, colors.surface]) {
        for (const foreground of [colors.text, colors.muted, ...(palette.startsWith('github') ? [colors.accent] : [])]) {
          const [dark, light] = [luminance(background), luminance(foreground)].sort((a, b) => a - b)
          expect((light + 0.05) / (dark + 0.05), `${palette}/${scheme}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })
})

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}
