import type { ReactNode } from 'react'
import type { RemoteKey } from '../locales/index'
import { Button, Globe, Icon, SegmentedControl } from 'dsh-tauri-ui/client'
import { cn, useListenParent, useStore } from 'dsh-tauri/client'
import { useEffect, useState } from 'react'
import { REMOTE_TAB_ACCESS, REMOTE_TAB_MACHINES, REMOTE_TAB_SYNC, REMOTE_TABS_ID, SETTINGS_OPEN_MESSAGE, SETTINGS_SECTION_ID } from '../constants/index'
import * as service from '../service/machines'
import { store } from '../store/index'
import { errorTextOf } from '../utils/error'
import { AccessSection } from './access-section'
import { MachinesSection } from './machines-section'
import { SyncPanel } from './sync-panel'

type RemoteTab = typeof REMOTE_TAB_MACHINES | typeof REMOTE_TAB_SYNC | typeof REMOTE_TAB_ACCESS

interface RemoteSectionProps {
  t: (key: RemoteKey) => string
}

const TAB_KEYS: Record<RemoteTab, RemoteKey> = {
  [REMOTE_TAB_MACHINES]: 'tabs.machines',
  [REMOTE_TAB_SYNC]: 'tabs.sync',
  [REMOTE_TAB_ACCESS]: 'tabs.access',
}

function MigrationWarning({ warning, t }: { warning: string, t: (key: RemoteKey) => string }): ReactNode {
  return (
    <p className="m-0 rounded-[8px] border border-dashed border-border-l3 px-[12px] py-[8px] text-[12px] leading-[19px] text-tertiary" role="alert" data-testid="remote-migration-warning">
      {t('migration.warning')}
      {warning}
    </p>
  )
}

export function RemoteSection({ t }: RemoteSectionProps): ReactNode {
  const state = useStore(store.machines)
  const [tab, setTab] = useState<RemoteTab>(REMOTE_TAB_MACHINES)
  const [visited, setVisited] = useState<ReadonlySet<RemoteTab>>(() => new Set<RemoteTab>([REMOTE_TAB_MACHINES]))

  function openTab(next: RemoteTab): void {
    setTab(next)
    setVisited(previous => previous.has(next) ? previous : new Set<RemoteTab>([...previous, next]))
  }

  useEffect(() => {
    if (store.machines.enabled === null)
      void service.loadSettings()
  }, [])

  useListenParent(SETTINGS_OPEN_MESSAGE, (message) => {
    if (message.section !== SETTINGS_SECTION_ID)
      return
    if (message.tab === REMOTE_TAB_MACHINES || message.tab === REMOTE_TAB_SYNC || message.tab === REMOTE_TAB_ACCESS)
      openTab(message.tab)
  })

  if (state.enabled === null) {
    return (
      <div className="flex flex-col gap-[12px] max-w-[960px] text-primary" data-testid="remote-section">
        <p className="m-0 text-[12px] leading-[18px] text-tertiary">{t('loading')}</p>
      </div>
    )
  }

  if (state.enabled === false) {
    return (
      <div className="flex flex-col gap-[12px] max-w-[960px] text-primary" data-testid="remote-section">
        <div className="mt-[4px] flex flex-col items-center gap-[12px] rounded-[12px] border-[0.5px] border-border-l2 bg-layer-1 px-[24px] py-[40px] text-center" data-testid="remote-hero">
          <span className="inline-flex h-[44px] w-[44px] items-center justify-center rounded-full bg-[var(--dsw-alias-surface-tinted)] text-brand" aria-hidden="true">
            <Icon as={Globe} size={22} />
          </span>
          <h2 className="m-0 text-[22px] leading-[32px] font-semibold text-primary">{t('hero.title')}</h2>
          <p className="m-0 max-w-[460px] text-[13px] leading-[21px] text-secondary">{t('hero.desc')}</p>
          {state.error !== null
            ? <p className="m-0 text-[12px] leading-[18px] text-error" role="alert" data-testid="remote-hero-error">{errorTextOf(state.error, t)}</p>
            : null}
          <Button
            variant="primary"
            size="sm"
            disabled={state.enabling}
            data-testid="remote-enable"
            onClick={() => void service.setEnabled(true)}
          >
            {state.enabling ? t('hero.enabling') : t('hero.enable')}
          </Button>
          {state.migrationWarning === null ? null : <MigrationWarning warning={state.migrationWarning} t={t} />}
        </div>
      </div>
    )
  }

  const tabs: RemoteTab[] = [REMOTE_TAB_MACHINES, REMOTE_TAB_SYNC, REMOTE_TAB_ACCESS]

  return (
    <div className="flex flex-col gap-[12px] max-w-[960px] text-primary" data-testid="remote-section">
      <div className="flex flex-wrap justify-between items-center gap-[8px]" data-testid="remote-tabs">
        <SegmentedControl
          id={REMOTE_TABS_ID}
          label={t('nav')}
          value={tab}
          options={tabs.map(value => ({ value, label: t(TAB_KEYS[value]) }))}
          onChange={(next) => {
            if (next === REMOTE_TAB_MACHINES || next === REMOTE_TAB_SYNC || next === REMOTE_TAB_ACCESS)
              openTab(next)
          }}
        />
        <Button variant="ghost" size="sm" disabled={state.enabling} onClick={() => void service.setEnabled(false)}>
          {t('disable')}
        </Button>
      </div>
      {state.migrationWarning === null ? null : <MigrationWarning warning={state.migrationWarning} t={t} />}
      {tabs.filter(value => value === tab || visited.has(value)).map((value) => {
        const selected = value === tab
        return (
          <div
            key={value}
            id={`${REMOTE_TABS_ID}-${value}-panel`}
            className={cn('min-w-0 flex-col gap-[12px]', selected ? 'flex' : 'hidden')}
            role="tabpanel"
            aria-labelledby={`${REMOTE_TABS_ID}-${value}`}
            hidden={!selected}
          >
            {value === REMOTE_TAB_MACHINES
              ? <MachinesSection t={t} />
              : value === REMOTE_TAB_SYNC ? <SyncPanel t={t} /> : <AccessSection t={t} />}
          </div>
        )
      })}
    </div>
  )
}
