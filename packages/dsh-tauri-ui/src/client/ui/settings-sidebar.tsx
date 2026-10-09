import type { SessionListState } from 'dsh-tauri/client'
import type { CSSProperties, ReactElement, PointerEvent as ReactPointerEvent, RefObject } from 'react'
import type { IconComponent } from '../components/icon'
import type { SelectorHook } from '../types/selector'
import { useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import { SlotOutlet } from '@deepseek-ai/dsh-client-ui-renderer'
import { clamp, cn, isEmpty, useEventListener, useStore } from 'dsh-tauri/client'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/icon'
import { ArrowLeft, Cubes3Overlap, Database, Gear, Ghost, LayoutSplitSideContentRight, PersonPencil, Puzzle, Server, Smartphone, Tray } from '../components/icons'
import { Input } from '../components/official'
import {
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
  SETTINGS_SECTION_SLOT,
} from '../constants'

import { locale } from '../locales'
import { store } from '../store'

export interface SettingsSidebarProps {
  useSessions: SelectorHook<SessionListState>
  useWorkspaces?: unknown
}

const Icons: Record<string, IconComponent | undefined> = {
  'account': PersonPencil,
  'general': Gear,
  'models': Database,
  'dsh-bridge': Smartphone,
  'agent-presets': Cubes3Overlap,
  'dsh-tauri-archive': Tray,
  'plugins': Puzzle,
  'dsh-tauri-remote': Server,
  'dsh-tauri-pet-settings': Ghost,
  'better-sidebar': LayoutSplitSideContentRight,
}

export function SettingsSidebar(_props: SettingsSidebarProps): ReactElement | null {
  const ui = useStore(store.settings, { sync: true })
  const { rows } = useStore(store.sections)
  locale.useLocale()
  const searchRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  // 官方 `Input` 的 props 类型没声明 ref（实现里 `...rest` 会落到 <input>），官方类型补全后可直接写 ref。
  const searchInputRefProps = { ref: searchRef }
  const [dragging, setDragging] = useState(false)
  const draggingRef = useRef(false)
  const originRef = useRef({ width: RAIL_WIDTH_DEFAULT, x: 0 })
  const documentRef = useRef<Document | null | undefined>(
    typeof document === 'undefined' ? undefined : document,
  )

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    originRef.current = {
      width: store.settings.railWidth ?? RAIL_WIDTH_DEFAULT,
      x: event.clientX,
    }
    draggingRef.current = true
    setDragging(true)
  }

  useEventListener('pointermove', (event) => {
    if (!draggingRef.current)
      return
    store.settings.setRailWidth(
      clamp(originRef.current.width + event.clientX - originRef.current.x, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX),
    )
  })

  useEventListener('pointerup', () => {
    if (!draggingRef.current)
      return
    draggingRef.current = false
    setDragging(false)
  })

  useEventListener(documentRef, 'keydown', (event: KeyboardEvent) => {
    if (typeof useModalLayer !== 'function' && ui.open && event.key === 'Escape')
      store.settings.close()
  })

  useEffect(() => {
    if (!ui.open)
      return
    const el = document.querySelector('[data-slot="sidebar"]')
    const width = el?.getBoundingClientRect().width
    if (typeof width === 'number' && width >= RAIL_WIDTH_MIN)
      store.settings.setRailWidth(clamp(width, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX))
    searchRef.current?.focus()
  }, [ui.open])

  if (!ui.open)
    return null

  const railWidth = ui.railWidth ?? RAIL_WIDTH_DEFAULT
  const query = ui.query.trim().toLowerCase()
  const visible = query
    ? rows.filter(
        row =>
          row.label.toLowerCase().includes(query) || row.id.toLowerCase().includes(query),
      )
    : rows
  const activeId = visible.some(row => row.id === ui.activeId)
    ? ui.activeId
    : visible[0]?.id

  return (
    <>
      <div
        ref={dialogRef}
        className="fixed inset-0 z-[1000] flex bg-[var(--dsw-specific-sidebar-fill)] text-primary [--dsh-chat-content-width:748px] [--dsh-composer-card-max-width:calc(var(--dsh-chat-content-width)_+_32px)] [--dsh-composer-side-clearance:16px]"
        data-slot-sidebar="dsh-tauri-ui"
        data-shortcut-modal="settings"
        role="dialog"
        aria-modal="true"
        aria-label={locale.text('settings')}
      >
        <div
          className="flex-none box-border flex flex-col gap-[14px] w-[var(--dsh-settings-rail-width)] px-[12px] py-[6px] bg-[var(--dsw-specific-sidebar-fill)] overflow-hidden"
          style={{ '--dsh-settings-rail-width': `${railWidth}px` } as CSSProperties}
        >
          <button
            type="button"
            className="flex items-center gap-[8px] self-start w-full px-[10px] py-[6px] border-none rounded-[10px] bg-transparent cursor-pointer [font-family:inherit] text-[14px] leading-[22px] text-primary hover:bg-hover"
            onClick={() => store.settings.close()}
          >
            <Icon as={ArrowLeft} />
            {locale.text('back')}
          </button>
          <Input
            {...searchInputRefProps}
            value={ui.query}
            placeholder={locale.text('search')}
            aria-label={locale.text('search')}
            onChange={event => store.settings.setQuery(event.target.value)}
          />
          <nav className="flex flex-col gap-[4px] flex-1 overflow-y-auto min-h-0" aria-label={locale.text('settings')}>
            {visible.map(row => (
              <button
                key={row.id}
                type="button"
                className={cn(
                  'box-border h-[40px] px-[12px] py-[9px] border-none rounded-[12px] bg-transparent text-left cursor-pointer [font-family:inherit] text-[14px] leading-[22px] font-normal text-primary flex items-center gap-[8px]',
                  row.id === activeId && 'bg-[var(--dsw-specific-sidebar-nav-item-active)] font-medium',
                )}
                aria-current={row.id === activeId ? 'true' : undefined}
                onClick={() => store.settings.select(row.id)}
              >
                <Icon as={Icons[row.id] ?? Gear} size={16} className="flex-none" />
                <span className="flex-1 min-w-0 truncate">{row.label}</span>
              </button>
            ))}
            {isEmpty(visible) && <div className="px-[10px] py-[12px] text-[13px] leading-[20px] text-[var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))]">{locale.text('noResults')}</div>}
          </nav>
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={locale.text('settings')}
          className={cn(
            'flex-none self-stretch w-[8px] -ml-1 z-[2] cursor-col-resize touch-none bg-transparent rounded-[4px]',
            dragging && 'bg-border-l2',
          )}
          onPointerDown={onHandlePointerDown}
        />
        <div
          data-slot="settings.content"
          className="flex-1 min-w-0 h-full box-border overflow-y-auto flex bg-[var(--dsw-alias-bg-base)] rounded-tl-[16px] [corner-shape:round]"
        >
          <div className="w-[min(calc(var(--dsh-composer-card-max-width)_+_2_*_var(--dsh-composer-side-clearance)),100%)] mx-auto box-border px-[36px] py-[28px]">
            {activeId !== undefined && (
              <SlotOutlet
                slotKey={SETTINGS_SECTION_SLOT}
                ownerProps={{ close: () => store.settings.close() }}
                opts={{ only: activeId }}
              />
            )}
          </div>
        </div>
      </div>
      {typeof useModalLayer === 'function' && <SettingsModalLayer dialog={dialogRef} />}
    </>
  )
}

function SettingsModalLayer({ dialog }: { dialog: RefObject<HTMLElement | null> }): null {
  useModalLayer(dialog, true, () => store.settings.close())
  return null
}
