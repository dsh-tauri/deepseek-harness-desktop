/**
 * The single `SSH` settings section: a feature switch in front of two tabs.
 * While the SSH feature is off (the default on a fresh install) the section
 * renders only the enable hero — no machine list, no sync surface, and no
 * connection work on the host. Switching it on reveals the `SSH machines` and
 * `Sync to remote` tabs; the desktop shell deep link picks the tab.
 * @module dsh-tauri-ssh-ui/client/components/ssh-section
 */

import type { ReactNode } from 'react'
import type { SshKey } from '../locales/index'
import type { MachinesStore } from '../store/index'
import type { RemoteBridge } from '../types/index'
import { Button, Globe, Icon, SegmentedControl } from 'dsh-tauri-ui/client'
import { listenParent } from 'dsh-tauri/client'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { SETTINGS_OPEN_MESSAGE, SETTINGS_SECTION_ID, SSH_TAB_MACHINES, SSH_TAB_SYNC, SSH_TABS_ID } from '../constants'
import { cls } from '../styles'
import { errorTextOf } from '../utils/error'
import { MachinesSection } from './machines-section'
import { SyncPanel } from './sync-panel'

/** The two tabs of the merged SSH section. */
type SshTab = typeof SSH_TAB_MACHINES | typeof SSH_TAB_SYNC

export interface SshSectionProps {
  store: MachinesStore
  /** Desktop bridge; absent (or unanswered probe) means pure web. */
  bridge?: RemoteBridge
  t: (key: SshKey) => string
}

/** The tabs of the section, in display order. */
const TAB_KEYS: Record<SshTab, SshKey> = {
  [SSH_TAB_MACHINES]: 'tabs.machines',
  [SSH_TAB_SYNC]: 'tabs.sync',
}

/**
 * Render the merged SSH settings section.
 * @returns the enable hero while the feature is off, the tab surface once on.
 */
export function SshSection({ t, store, bridge }: SshSectionProps): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [tab, setTab] = useState<SshTab>(SSH_TAB_MACHINES)
  const [visited, setVisited] = useState<ReadonlySet<SshTab>>(() => new Set<SshTab>([SSH_TAB_MACHINES]))

  // 已访问的标签页保持挂载（切回来不丢选择态），与扩展面板的同款做法一致；
  // 切换入口只有下面两个，visited 随选中一起推进，不必再挂一个同步 effect。
  function openTab(next: SshTab): void {
    setTab(next)
    setVisited(previous => previous.has(next) ? previous : new Set<SshTab>([...previous, next]))
  }

  useEffect(() => {
    if (store.getSnapshot().enabled === null)
      void store.loadSettings()
  }, [store])

  // 壳层「管理机器…／同步到远端…」把分区与目标标签页一起发过来；本分区只认自己
  // 的 section，其余交回 dsh-tauri-ui 的通用 deep-link 处理。
  useEffect(() => {
    return listenParent((message) => {
      if (message.section !== SETTINGS_SECTION_ID)
        return
      if (message.tab === SSH_TAB_MACHINES || message.tab === SSH_TAB_SYNC)
        openTab(message.tab)
    }, SETTINGS_OPEN_MESSAGE)
  }, [])

  if (state.enabled === null) {
    return (
      <div className={cls.section} data-testid="ssh-section">
        <p className={cls.hint}>{t('loading')}</p>
      </div>
    )
  }

  if (state.enabled === false) {
    return (
      <div className={cls.section} data-testid="ssh-section">
        <div className={cls.hero} data-testid="ssh-hero">
          <span className={cls.heroIcon} aria-hidden="true">
            <Icon as={Globe} size={22} />
          </span>
          <h2 className={cls.heroTitle}>{t('hero.title')}</h2>
          <p className={cls.heroHint}>{t('hero.desc')}</p>
          {state.error !== null
            ? <p className={cls.error} role="alert" data-testid="ssh-hero-error">{errorTextOf(state.error, t)}</p>
            : null}
          <Button
            variant="primary"
            size="sm"
            disabled={state.enabling}
            data-testid="ssh-enable"
            onClick={() => void store.enable()}
          >
            {state.enabling ? t('hero.enabling') : t('hero.enable')}
          </Button>
        </div>
      </div>
    )
  }

  const tabs: SshTab[] = [SSH_TAB_MACHINES, SSH_TAB_SYNC]

  return (
    <div className={cls.section} data-testid="ssh-section">
      <div className={cls.tabs} data-testid="ssh-tabs">
        <SegmentedControl
          id={SSH_TABS_ID}
          label={t('nav')}
          value={tab}
          options={tabs.map(value => ({ value, label: t(TAB_KEYS[value]) }))}
          onChange={(next) => {
            if (next === SSH_TAB_MACHINES || next === SSH_TAB_SYNC)
              openTab(next)
          }}
        />
      </div>
      {tabs.filter(value => value === tab || visited.has(value)).map((value) => {
        const selected = value === tab
        return (
          <div
            key={value}
            id={`${SSH_TABS_ID}-${value}-panel`}
            className={cls.tabPanel}
            role="tabpanel"
            aria-labelledby={`${SSH_TABS_ID}-${value}`}
            hidden={!selected}
          >
            {value === SSH_TAB_MACHINES
              ? <MachinesSection t={t} store={store} bridge={bridge} />
              : <SyncPanel t={t} store={store} />}
          </div>
        )
      })}
    </div>
  )
}
