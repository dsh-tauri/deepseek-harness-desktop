import { cssr } from 'dsh-tauri-ui/client'
import { PLUGINS_MORE_HEADER_SELECTOR } from '../constants'

const root = '[data-dsh-extension-plugins]'
const page = `${root} [data-plugin-panel]`
const mainHead = `${page} > header:has(> div:first-child > h1)`
const detail = `${page} > :is([data-plugin-item-detail], [data-plugin-detail], [data-plugin-row-detail])`

export const pluginsStyle = cssr.c([
  cssr.c(root, { position: 'relative' }),
  cssr.c(`${root} > [data-dsh-plugins-icon]`, { display: 'none', position: 'absolute', top: '5px', left: 0, width: '22px', height: '22px', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }),
  cssr.c(`${root}:has([data-plugin-panel] > header > div:first-child > h1) > [data-dsh-plugins-icon]`, { display: 'inline-flex' }),
  cssr.c(page, { height: 'auto', padding: 0, overflow: 'visible', gap: '14px' }),
  cssr.c(`${page} > div:has(> [role="tablist"])`, { marginTop: 0 }),
  cssr.c(mainHead, { paddingTop: 0, flexWrap: 'wrap', alignItems: 'center', gap: '14px 10px' }),
  cssr.c(`${mainHead} > div:first-child`, { display: 'contents' }),
  cssr.c(`${mainHead} > div:first-child > h1`, { margin: 0, paddingLeft: '32px', fontSize: '16px', lineHeight: '24px', fontWeight: 500 }),
  cssr.c(`${mainHead} > div:first-child > :is(p, div)`, { order: 2, width: '100%', margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }),
  cssr.c(`${mainHead} > div:last-child`, { marginLeft: 'auto' }),
  cssr.c(PLUGINS_MORE_HEADER_SELECTOR, { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '10px', paddingTop: 0 }),
  cssr.c(`${PLUGINS_MORE_HEADER_SELECTOR} > button:first-child`, { display: 'inline-flex', flex: '0 0 auto', alignItems: 'center', justifyContent: 'center', gap: '4px', width: 'auto', minWidth: '28px', padding: '0 6px', whiteSpace: 'nowrap', WebkitAppRegion: 'no-drag' }),
  cssr.c(`${PLUGINS_MORE_HEADER_SELECTOR} > h1`, { flex: '1 1 0', minWidth: 0, margin: 0, padding: 0, fontSize: '16px', lineHeight: '24px', fontWeight: 500 }),
  cssr.c(`${detail} > div[data-window-drag]:first-child`, { paddingTop: '12px' }),
  cssr.c(`${detail} > button:first-child`, { marginTop: '12px' }),
])
