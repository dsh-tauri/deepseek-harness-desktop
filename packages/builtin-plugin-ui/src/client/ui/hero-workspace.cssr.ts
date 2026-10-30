import { cssr } from '../utils/cssr'

const { c } = cssr

const HERO_ROW = '[class$="heroWorkspaceRow"]'

const OFFICIAL_CHIP = ['选择工作区', 'Choose workspace']
  .map(label => `${HERO_ROW}:has([data-hero-workspace]) button[aria-label="${label}"]:not([data-hero-workspace])`)
  .join(',')

export const HERO_WORKSPACE_STYLE_ID = 'dsh-tauri-ui-hero-workspace-styles'

export default c([
  c(OFFICIAL_CHIP, { display: 'none !important' }),
])
