import { cssr } from 'dsh-tauri-ui/client'
import { MOBILE_MEDIA_QUERIES } from 'dsh-tauri/client'

const { c } = cssr

export default c(`@media ${MOBILE_MEDIA_QUERIES.join(' and ')}`, [
  c('[data-dsh-mobile-preferences]', {
    display: 'flex',
    flex: '1',
    minWidth: '0',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 0',
  }),
  c('[data-dsh-mobile-preferences] button', {
    marginLeft: 'auto',
    flexShrink: '0',
  }),
  c('[data-slot="conversation.composer.bar"] [class$="_dock"]', {
    display: 'none !important',
  }),
  c('[class$="_composerStack"] > [data-slot="conversation.input.dock"]', {
    display: 'none !important',
  }),
  c('[class$="_turnErrorCode"]', {
    display: 'none !important',
  }),
  c('[data-slot="conversation.header"] [class$="_header"]', {
    display: 'none !important',
  }),
  // 扩展面板内嵌的官方页头由 dsh-tauri-extension 自己排版（同一行左侧还有它叠放的闪光图标），
  // 这里叠加顶距会把标题压低、与图标错轴，因此只给主槽里独立成页的页头让位。
  c('[data-slot="main"] header[class*="_pageHead"]:not([data-dsh-extension-plugins] *)', {
    paddingLeft: '0 !important',
    paddingTop: '24px !important',
  }),
  c('[data-slot="conversation.view"] [class$="_scroll"]', {
    padding: '16px !important',
  }),
  c('[class*="_userStack"]', {
    maxWidth: '100% !important',
  }),
  c('[data-slot="main"] [data-conversation-scroll]', {
    paddingBottom: '0 !important',
  }),
  c('html[data-dsh-mobile-sidebar] [data-slot="root"] > [class$="_frame"]', {
    gridTemplateColumns: 'minmax(0, 1fr) !important',
    background: 'var(--dsw-specific-sidebar-fill) !important',
    transition: 'none !important',
    overscrollBehaviorX: 'none',
  }),
  c('[class$="_bottomRow"]', {
    background: 'var(--dsw-specific-sidebar-fill) !important',
  }),
  c('html[data-dsh-mobile-sidebar] [class$="_sidebarCol"]', {
    position: 'absolute',
    inset: '0 auto 0 0',
    zIndex: '0',
    width: 'var(--dsh-mobile-sidebar-width)',
    maxWidth: '82vw',
    border: '0 !important',
    visibility: 'visible',
    transform: 'none',
    transition: 'none',
  }),
  // keep: 终端模式外观（dsh-tauri appearance）会在 `body [data-sidebar-collapsed] [data-slot="sidebar"]`
  // 上隐藏侧栏；抽屉接管时侧栏就是抽屉内容，这里用更高特异度还原可见性（不用 !important，
  // 免得和外观插件比谁的后缀更靠后）。
  c('html[data-dsh-mobile-sidebar] body [data-slot="sidebar"]', {
    visibility: 'visible',
  }),
  c('html[data-dsh-mobile-sidebar] [class$="_centerCol"]', {
    position: 'absolute',
    inset: '0',
    zIndex: '1',
    colorScheme: 'light',
    backgroundColor: 'Canvas',
    backgroundImage: 'linear-gradient(var(--dsw-alias-bg-base, Canvas), var(--dsw-alias-bg-base, Canvas))',
    overflow: 'hidden',
    transform: 'translate3d(0, 0, 0)',
    borderRadius: '0',
    cornerShape: 'round',
    boxShadow: 'none',
    transition: 'transform 240ms cubic-bezier(.2, .8, .2, 1), border-radius 240ms ease, box-shadow 240ms ease',
    willChange: 'transform',
  }),
  c('html[data-dsh-mobile-sidebar-open] [class$="_centerCol"]', {
    transform: 'translate3d(var(--dsh-mobile-sidebar-width), 0, 0)',
    borderRadius: '24px 0 0 24px',
    boxShadow: 'var(--dsw-shadow-lv3)',
  }),
  c('html[data-dsh-mobile-sidebar] body[data-ds-dark-theme] [class$="_centerCol"]', {
    colorScheme: 'dark',
  }),
  c('html[data-dsh-mobile-sidebar] [class$="_rightbarCol"]', {
    display: 'none !important',
  }),
  c('html[data-dsh-mobile-sidebar] [data-side="sidebar"]', {
    display: 'none !important',
  }),
  c('html[data-dsh-mobile-sidebar] [class$="_centerCol"] > [data-slot="main"]', {
    flex: '1',
    minHeight: '0',
    height: 'auto',
  }),
  c('html[data-dsh-mobile-sidebar] [data-dsh-mobile-navbar-host]', {
    flexShrink: '0',
    minWidth: '0',
  }),
  c('html[data-dsh-mobile-sidebar] [data-shell-overlay]', {
    zIndex: '20',
    pointerEvents: 'none',
  }),
  c('[data-dsh-mobile-sidebar-overlay]', {
    position: 'absolute',
    inset: '0',
    zIndex: '40',
    pointerEvents: 'none',
  }),
  c('[data-dsh-mobile-topbar]', {
    position: 'sticky',
    top: '0',
    zIndex: '3',
    display: 'grid',
    gridTemplateColumns: '24px minmax(0, 1fr) 24px',
    alignItems: 'center',
    gap: '16px',
    height: 'calc(52px + var(--dsh-mobile-safe-area-inset-top, env(safe-area-inset-top, 0px)))',
    padding: 'calc(14px + var(--dsh-mobile-safe-area-inset-top, env(safe-area-inset-top, 0px))) 16px 14px',
    boxSizing: 'border-box',
    backgroundColor: 'Canvas',
    backgroundImage: 'linear-gradient(var(--dsw-alias-bg-base, Canvas), var(--dsw-alias-bg-base, Canvas))',
  }),
  c('[data-dsh-mobile-sidebar-toggle]', {
    display: 'block',
    width: '20px',
    height: '20px',
    padding: '0',
    border: '0',
    color: 'var(--dsw-alias-label-primary)',
    background: 'transparent',
    boxShadow: 'none',
    cursor: 'pointer',
    pointerEvents: 'auto',
    touchAction: 'manipulation',
    outline: 'none',
    WebkitTapHighlightColor: 'transparent',
  }),
  c('[data-dsh-mobile-new-session]', {
    display: 'block',
    width: '24px',
    height: '24px',
    padding: '0',
    border: '0',
    color: 'var(--dsw-alias-label-primary)',
    background: 'transparent',
    boxShadow: 'none',
    cursor: 'pointer',
    pointerEvents: 'auto',
    touchAction: 'manipulation',
    outline: 'none',
    WebkitTapHighlightColor: 'transparent',
  }),
  c('[data-dsh-mobile-sidebar-toggle]:focus-visible, [data-dsh-mobile-new-session]:focus-visible', {
    outline: 'var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))',
    outlineOffset: '4px',
  }),
  c('[data-dsh-mobile-navbar-title]', {
    minWidth: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'center',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: '16px',
    fontWeight: '500',
    lineHeight: '24px',
  }),
  c('[data-dsh-mobile-navbar-status]', {
    position: 'absolute',
    top: '100%',
    left: '16px',
    right: '16px',
    textAlign: 'center',
    color: 'var(--dsw-alias-label-caption)',
    backgroundColor: 'Canvas',
    backgroundImage: 'linear-gradient(var(--dsw-alias-bg-base, Canvas), var(--dsw-alias-bg-base, Canvas))',
    fontSize: '12px',
    lineHeight: '20px',
  }),
  c('[data-dsh-mobile-sidebar-shade]', {
    position: 'absolute',
    inset: 'calc(52px + var(--dsh-mobile-safe-area-inset-top, env(safe-area-inset-top, 0px))) 0 0',
    zIndex: '2',
    display: 'block',
    width: '100%',
    padding: '0',
    border: '0',
    background: 'transparent',
    opacity: '0',
    visibility: 'hidden',
    pointerEvents: 'none',
    transform: 'translate3d(0, 0, 0)',
    transition: 'transform 240ms cubic-bezier(.2, .8, .2, 1), opacity 180ms ease, visibility 0s linear 240ms',
    touchAction: 'pan-y pinch-zoom',
  }),
  c('html[data-dsh-mobile-sidebar-open] [data-dsh-mobile-sidebar-shade]', {
    transform: 'translate3d(var(--dsh-mobile-sidebar-width), 0, 0)',
    opacity: '1',
    visibility: 'visible',
    pointerEvents: 'auto',
    transitionDelay: '0s',
  }),
  c('@media (prefers-reduced-motion: reduce)', [
    c('html[data-dsh-mobile-sidebar] [class$="_centerCol"], html[data-dsh-mobile-sidebar] [data-dsh-mobile-sidebar-shade]', {
      transition: 'none !important',
    }),
  ]),
])
