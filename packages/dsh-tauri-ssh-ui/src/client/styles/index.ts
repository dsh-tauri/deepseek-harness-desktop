/**
 * Style barrel of the SSH-machines settings page: the css-render tree (in
 * `index.cssr.ts`), its mount id, and the `cls` map the components consume.
 * Class names keep the plugin prefix (`dshp-ssh-*`); components never
 * hand-write the prefixed strings.
 * @module dsh-tauri-ssh-ui/client/styles
 */

import sshStyle from './index.cssr'

/** The mounted stylesheet id (style tag identity, plugin-prefixed). */
export const SSH_STYLE_ID = 'dsh-tauri-ssh-ui-styles'

/** The css-render tree, mounted once by the client apply via ctx.effect. */
export { sshStyle }

/**
 * Logical class map (the former CSS-Modules keys) → prefixed class names.
 * Keys mirror the old `css.*` references one-to-one so the components read
 * unchanged in shape.
 */
export const cls = {
  section: 'dshp-ssh-section',
  title: 'dshp-ssh-title',
  intro: 'dshp-ssh-intro',
  tabs: 'dshp-ssh-tabs',
  tabPanel: 'dshp-ssh-tab-panel',
  hero: 'dshp-ssh-hero',
  heroIcon: 'dshp-ssh-hero-icon',
  heroTitle: 'dshp-ssh-hero-title',
  heroHint: 'dshp-ssh-hero-hint',
  chrome: 'dshp-ssh-chrome',
  dangerAction: 'dshp-ssh-danger-action',
  sectionHead: 'dshp-ssh-section-head',
  editorActions: 'dshp-ssh-editor-actions',
  stepRail: 'dshp-ssh-step-rail',
  stepDone: 'dshp-ssh-step-done',
  stepCurrent: 'dshp-ssh-step-current',
  rows: 'dshp-ssh-rows',
  group: 'dshp-ssh-group',
  groupTitle: 'dshp-ssh-group-title',
  groupHint: 'dshp-ssh-group-hint',
  rowCard: 'dshp-ssh-row-card',
  rowHead: 'dshp-ssh-row-head',
  rowIdentity: 'dshp-ssh-row-identity',
  rowName: 'dshp-ssh-row-name',
  rowTag: 'dshp-ssh-row-tag',
  status: 'dshp-ssh-status',
  stateDot: 'dshp-ssh-state-dot',
  colorPip: 'dshp-ssh-color-pip',
  appearance: 'dshp-ssh-appearance',
  swatches: 'dshp-ssh-swatches',
  swatch: 'dshp-ssh-swatch',
  swatchNone: 'dshp-ssh-swatch-none',
  switchRow: 'dshp-ssh-switch-row',
  switch: 'dshp-ssh-switch',
  rowActions: 'dshp-ssh-row-actions',
  editor: 'dshp-ssh-editor',
  grid: 'dshp-ssh-grid',
  span3: 'dshp-ssh-span-3',
  span4: 'dshp-ssh-span-4',
  span5: 'dshp-ssh-span-5',
  span6: 'dshp-ssh-span-6',
  span8: 'dshp-ssh-span-8',
  span12: 'dshp-ssh-span-12',
  field: 'dshp-ssh-field',
  fieldLabel: 'dshp-ssh-field-label',
  fieldInput: 'dshp-ssh-field-input',
  statusError: 'dshp-ssh-status-error',
  link: 'dshp-ssh-link',
  logStream: 'dshp-ssh-log-stream',
  installBox: 'dshp-ssh-install-box',
  installHint: 'dshp-ssh-install-hint',
  installNote: 'dshp-ssh-install-note',
  notice: 'dshp-ssh-notice',
  error: 'dshp-ssh-error',
  hint: 'dshp-ssh-hint',
  empty: 'dshp-ssh-empty',
  emptyBlock: 'dshp-ssh-empty-block',
  remoteCard: 'dshp-ssh-remote-card',
  remoteIcon: 'dshp-ssh-remote-icon',
  remoteTitle: 'dshp-ssh-remote-title',
  remoteHint: 'dshp-ssh-remote-hint',
  remoteNote: 'dshp-ssh-remote-note',
  syncTargets: 'dshp-ssh-sync-targets',
  syncChip: 'dshp-ssh-sync-chip',
  syncToolbar: 'dshp-ssh-sync-toolbar',
  syncCount: 'dshp-ssh-sync-count',
  syncGroup: 'dshp-ssh-sync-group',
  syncGroupHead: 'dshp-ssh-sync-group-head',
  syncItems: 'dshp-ssh-sync-items',
  syncItem: 'dshp-ssh-sync-item',
  syncRow: 'dshp-ssh-sync-row',
  syncBox: 'dshp-ssh-sync-box',
  syncText: 'dshp-ssh-sync-text',
  syncName: 'dshp-ssh-sync-name',
  syncMeta: 'dshp-ssh-sync-meta',
  syncReason: 'dshp-ssh-sync-reason',
  syncActions: 'dshp-ssh-sync-actions',
  syncProgress: 'dshp-ssh-sync-progress',
  syncBar: 'dshp-ssh-sync-bar',
  syncBarFill: 'dshp-ssh-sync-bar-fill',
  syncProgressText: 'dshp-ssh-sync-progress-text',
  syncResults: 'dshp-ssh-sync-results',
  syncSummary: 'dshp-ssh-sync-summary',
  syncResult: 'dshp-ssh-sync-result',
  syncResultName: 'dshp-ssh-sync-result-name',
  syncOk: 'dshp-ssh-sync-ok',
  syncLogToggle: 'dshp-ssh-sync-log-toggle',
} as const
