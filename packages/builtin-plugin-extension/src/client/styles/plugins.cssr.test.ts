// @vitest-environment node
import { cssr } from 'dsh-tauri-ui/client'
import { expect, it } from 'vitest'
import { pluginsStyle } from './plugins.cssr'

it('clears the embedded plugin page head top inset', () => {
  const block = pluginsStyle.render()
    .split('\n\n')
    .find(rule => rule.startsWith('[data-dsh-extension-plugins] [data-plugin-panel] header:has(> div:first-child > h1) {'))
  expect(block).toContain('padding-top: 0 !important;')
})

void cssr
