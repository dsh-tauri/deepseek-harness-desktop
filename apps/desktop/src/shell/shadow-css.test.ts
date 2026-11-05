import { describe, expect, it } from 'vitest'
import { rewriteForShadowRoot } from './shadow-css'

describe('rewriteForShadowRoot', () => {
  it('moves the bare :root variable block onto the shadow host', () => {
    expect(rewriteForShadowRoot(':root{--color-panel:#1b1b1c}'))
      .toBe(':host{--color-panel:#1b1b1c}')
  })

  it('keeps an existing :host selector instead of producing :host,:host', () => {
    expect(rewriteForShadowRoot(':root,:host{--spacing:.25rem}'))
      .toBe(':host{--spacing:.25rem}')
  })

  it('maps quoted html[data-theme] selectors to :host([data-theme])', () => {
    expect(rewriteForShadowRoot('html[data-theme="light"]{--color-panel:#f9fafb}'))
      .toBe(':host([data-theme="light"]){--color-panel:#f9fafb}')
  })

  it('maps unquoted html[data-theme] selectors as well', () => {
    expect(rewriteForShadowRoot('html[data-theme=dark]{--color-panel:#1b1b1c}'))
      .toBe(':host([data-theme=dark]){--color-panel:#1b1b1c}')
  })

  it('rewrites every occurrence across a multi-rule stylesheet', () => {
    const input = ':root{a:1}html[data-theme="light"]{b:2}html[data-theme=dark]{c:3}:root{d:4}'
    expect(rewriteForShadowRoot(input))
      .toBe(':host{a:1}:host([data-theme="light"]){b:2}:host([data-theme=dark]){c:3}:host{d:4}')
  })

  it('leaves unrelated selectors untouched', () => {
    expect(rewriteForShadowRoot('.flex{display:flex}@media (min-width:40rem){.sm\\:flex{display:flex}}'))
      .toBe('.flex{display:flex}@media (min-width:40rem){.sm\\:flex{display:flex}}')
  })
})
