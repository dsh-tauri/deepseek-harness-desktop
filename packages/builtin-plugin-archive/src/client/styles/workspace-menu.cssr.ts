import { cssr } from 'dsh-tauri-ui/client'
import { ARCHIVE_MENU_ITEM_ATTRIBUTE } from '../constants'

const { c } = cssr

export default c([
  c(`[${ARCHIVE_MENU_ITEM_ATTRIBUTE}]`, {
    color: 'var(--dsw-alias-label-primary) !important',
    background: 'transparent !important',
  }, [
    c('&:hover:not(:disabled)', {
      color: 'var(--dsw-alias-label-primary) !important',
      background: 'var(--dsw-alias-interactive-bg-hover) !important',
    }),
    c('&:focus', {
      color: 'var(--dsw-alias-label-primary) !important',
    }),
    c(`[class*="itemIcon"]`, {
      color: 'var(--dsw-alias-label-tertiary) !important',
    }),
  ]),
])
