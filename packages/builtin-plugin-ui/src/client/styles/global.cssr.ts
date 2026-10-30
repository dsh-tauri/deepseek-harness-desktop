import { cssr } from '../utils/cssr'

export const GLOBAL_STYLE_ID = 'dsh-tauri-ui-global-styles'

const { c } = cssr

const INPUT_DOCK_SELECTOR = '[data-slot="conversation.input.dock"]:has(> :nth-child(3 of :not([data-dsh-tauri-worktree-mode-anchor])))'

export default c([
  c(`:where(${INPUT_DOCK_SELECTOR})`, {
    display: 'flex !important',
    flexDirection: 'column',
    width: 'calc(100% - var(--dsh-composer-side-clearance, 0px) * 2)',
    maxWidth: 'var(--dsh-composer-card-max-width, 100%)',
    marginInline: 'auto',
    rowGap: '0',
  }),
  c(`${INPUT_DOCK_SELECTOR} > :not([data-dsh-tauri-worktree-mode-anchor])`, {
    '--dsh-composer-side-clearance': '0px',
  }),
  ...[2, 3, 4].flatMap((index) => {
    const child = `> :nth-last-child(${index} of :not([data-dsh-tauri-worktree-mode-anchor]))`
    return [
      c(`${INPUT_DOCK_SELECTOR} ${child}`, {
        position: 'relative',
        height: 'auto',
        minHeight: '0',
        marginBlock: '0',
        boxSizing: 'border-box',
        overflow: 'clip',
        transformOrigin: 'top center',
        interpolateSize: 'allow-keywords',
        transition: 'height 220ms ease, transform 220ms ease, margin-bottom 220ms ease',
      }),
      c(`${INPUT_DOCK_SELECTOR}:not(:has(> :not([data-dsh-tauri-worktree-mode-anchor]):hover)):not(:focus-within) ${child}`, {
        height: '12px',
        transform: `scale(${1 - (index - 1) * 0.02})`,
      }),
      c(`${INPUT_DOCK_SELECTOR}:is(:has(> :not([data-dsh-tauri-worktree-mode-anchor]):hover), :focus-within) ${child}`, {
        transform: 'scale(1)',
        marginBottom: '6px',
        overflow: 'visible',
      }),
      c(`${INPUT_DOCK_SELECTOR}:is(:has(> :not([data-dsh-tauri-worktree-mode-anchor]):hover), :focus-within) ${child}::after`, {
        content: '""',
        position: 'absolute',
        top: '100%',
        left: '0',
        right: '0',
        height: '8px',
      }),
    ]
  }),
  c('@media (prefers-reduced-motion: reduce)', [
    c(`${INPUT_DOCK_SELECTOR} > :not([data-dsh-tauri-worktree-mode-anchor])`, {
      transition: 'none !important',
    }),
  ]),
  c('[data-slot="sidebar.right.tab.guide"]', [
    c('[class$="guide"]', {
      gap: '8px',
    }),
    c('[class$="entry"]', {
      border: 'none',
      padding: '8px 16px',
      gap: '12px',
      minHeight: 'auto',
      alignItems: 'start',
    }),
    c('[class$="entry"]>button', {
      border: 'none',
      padding: '8px 16px',
      gap: '12px',
      minHeight: 'auto',
      alignItems: 'start',
    }),
    c('[class$="entryIcon"], [class$="icon"]', {
      marginTop: '2px',
      width: '18px',
      height: '18px',
    }),
    c('[class$="entryTitle"], [class$="title"]', {
      fontSize: '14px',
    }),
    c('[class$="entryDescription"], [class$="description"]', {
      fontSize: '12px',
    }),
  ]),
  c('[data-dsh-dock-fallback]', {
    display: 'none !important',
  }),
  c('[data-dsh-toggle-cluster], .nArs4W_toggleCluster', {
    top: '6px !important',
    right: '6px !important',
    gap: '2px !important',
  }),
  c('[data-dsh-toggle-cluster] button[aria-label], .nArs4W_toggleCluster button[aria-label]', {
    display: 'flex !important',
    borderRadius: '8px !important',
    flexShrink: 0,
  }),
  c('[class$="_panelRow"], [class*="_panelRow "]', {
    color: 'var(--dsw-alias-label-primary) !important',
  }),
  c('[class$="logoRow"]', {
    color: 'var(--dsw-alias-label-primary) !important',
    justifyContent: 'center !important',
  }, [
    c('[class$="brand"], [class*="brand "]', {
      justifyContent: 'center !important',
    }),
  ]),
  c('[class*="collapsed"] [class$="logoRow"]', {
    justifyContent: 'flex-start !important',
  }),
  c('[data-slot-sidebar="dsh-tauri-ui"]', [
    c('[data-slot="settings.section"] > :is(div, section)', {
      maxWidth: 'none !important',
      paddingBottom: '24px',
    }),
    c('[data-slot="settings.section"] [data-slot="settings.plugins.tab"] > :is(div, section)', {
      maxWidth: 'none !important',
    }),
  ]),
  c('[data-slot="conversation.chat.turnTail"]', [
    c('[class$="card"]', {
      borderRadius: '14px !important',
    }),
    c('[class$="toggle"]', {
      borderTop: '.5px solid var(--dsw-alias-border-l2)',
    }),
    c('[class$="statCounts"]', {
      fontSize: '12px',
    }),
    c('[class$="title"]', {
      fontWeight: '550',
    }),
    c('[class$="tile"]', {
      border: 'none',
      background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))',
    }),
    c('[class$="tileMark"]', {
      background: 'var(--dsw-alias-label-primary)',
    }),
  ]),
  c('[data-chat-flow] > [data-chat-anchor-key]:not([hidden])', {
    contentVisibility: 'auto',
    containIntrinsicSize: 'auto 320px',
    paddingLeft: '24px',
    marginLeft: '-24px',
  }),
  c('[data-chat-flow-key]:has(> [data-slot="conversation.chat.node"] > [data-dsh-tauri-ui-continue-notice])', {
    display: 'none !important',
  }),

  c('[class$="sidebarCol"]', {
    borderRight: 'none !important',
  }),
  c('[class$="centerCol"]', {
    background: 'var(--dsw-alias-bg-base)',
    borderRadius: '16px 0 0 0',
    cornerShape: 'round',
  }),
  c('[data-slot="root"] > div', {
    background: 'var(--dsw-specific-sidebar-fill)',
  }),
])
