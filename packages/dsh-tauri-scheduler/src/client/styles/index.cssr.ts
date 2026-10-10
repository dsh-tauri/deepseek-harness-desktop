import { cssr } from 'dsh-tauri-ui/client'

export default cssr.c([
  cssr.c('button:has(.dshp-scheduler__nav-dot)', { position: 'relative' }),
])
