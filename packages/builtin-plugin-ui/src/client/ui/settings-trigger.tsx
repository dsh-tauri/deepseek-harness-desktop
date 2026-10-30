import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId, SessionListState } from 'dsh-tauri/client'
import type { ReactElement } from 'react'
import type { SelectorHook } from '../types/selector'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { SlotOutlet } from '@deepseek-ai/dsh-client-ui-renderer'
import { cn, uniq, useStore } from 'dsh-tauri/client'
import { useCallback, useState } from 'react'
import { Gear } from '../components/icons'
import {
  SETTINGS_LAUNCHER_SLOT,
  SETTINGS_ONBOARDING_SLOT,
  SETTINGS_TRIGGER_SLOT,
} from '../constants'
import { locale } from '../locales'
import { store } from '../store'

interface RetainedSessionLike {
  retainedBy?: Readonly<Record<string, number | undefined>>
}

export type SessionListStateLike = Omit<SessionListState, 'byId'> & {
  current?: string
  byId: Record<string, SessionListState['byId'][SessionId]>
}

export interface SettingsTriggerProps {
  wide: boolean
  useSessions: SelectorHook<SessionListStateLike>
  useWorkspaces?: unknown
}

function isMainViewRetained(session: RetainedSessionLike): boolean {
  return (session.retainedBy?.mainView ?? 0) > 0
}

export function SettingsTrigger({ wide, useSessions }: SettingsTriggerProps): ReactElement {
  const { open, launcherAvailable, launcherShortcut } = useStore(store.settings)
  const { onboarding } = useStore(store.sections)
  const [completed, setCompleted] = useState<string[]>([])

  const onboardingActive = useSessions((state) => {
    if (state.phase !== 'ready')
      return false
    if (state.current !== undefined)
      return state.byId[state.current]?.blank === true
    const main = Object.values(state.byId).find(session => isMainViewRetained(session))
    return main === undefined || main.blank === true
  })

  if (!onboardingActive && completed.length > 0)
    setCompleted([])

  const step = onboardingActive ? onboarding.find(s => !completed.includes(s.id)) : undefined

  const completeStep = useCallback((id: string) => {
    setCompleted(previous => uniq([...previous, id]))
  }, [])

  const openSection = useCallback((id: string) => {
    store.settings.openAt(id)
  }, [])

  const [menuOpen, setMenuOpen] = useState(false)
  locale.useLocale()
  const menuItems: MenuEntry[] = [
    { id: 'settings', label: locale.text('settings'), icon: <Gear width={16} height={16} /> },
  ]

  const trigger = (
    <button
      type="button"
      aria-haspopup={launcherAvailable ? 'dialog' : 'menu'}
      aria-expanded={open || menuOpen}
      onClick={() => {
        if (launcherAvailable) {
          store.settings.openAt()
          return
        }
        setMenuOpen(value => !value)
      }}
      data-settings-trigger="dsh-tauri-ui"
      className={cn(
        'box-border flex flex-none items-center gap-[8px] w-[calc(100%+4px)] h-[42px] my-[4px] -mx-[2px] pr-[10px] pl-[8px] border-none rounded-[12px] bg-transparent [font-family:inherit] text-[14px] leading-[22px] text-primary overflow-hidden cursor-pointer hover:bg-hover',
        !wide && 'justify-center gap-0 w-[36px] h-[36px] mt-[8px] mb-[10px] mx-0 p-0 rounded-full',
      )}
    >
      <SlotOutlet slotKey={SETTINGS_TRIGGER_SLOT} ownerProps={{ wide }} />
    </button>
  )

  return (
    <>
      {launcherAvailable
        ? (
            <SlotOutlet
              slotKey={SETTINGS_LAUNCHER_SLOT}
              ownerProps={{
                wide,
                settingsOpen: open,
                ...launcherShortcut === undefined ? {} : { settingsShortcut: launcherShortcut },
                openSettings: () => store.settings.openAt(),
                openOnboarding: (id: string) => store.settings.openAt(id),
              }}
              opts={{ fallback: trigger }}
            />
          )
        : (
            <Menu
              open={menuOpen}
              side="top"
              align="start"
              portal
              autoFocus
              className="block! w-full!"
              items={menuItems}
              anchor={trigger}
              onSelect={(id: string) => {
                setMenuOpen(false)
                if (id === 'settings')
                  store.settings.openAt()
              }}
              onClose={() => setMenuOpen(false)}
            />
          )}
      {step !== undefined && (
        <SlotOutlet
          slotKey={SETTINGS_ONBOARDING_SLOT}
          ownerProps={{
            stepId: step.id,
            complete: () => completeStep(step.id),
            openSection,
          }}
          opts={{ only: step.id }}
        />
      )}
    </>
  )
}
