import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactElement } from 'react'
import type { SelectorHook } from '../types/selector'
import type {
  HeroWorkspaceProps,
  SessionListStateLike,
  WorkspaceListStateLike,
} from './hero-workspace.types'
import {
  Button,
  Menu,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { SlotOutlet } from '@deepseek-ai/dsh-client-ui-renderer'
import { useCallback, useRef, useState } from 'react'
import { Chip } from '../components/chip'
import { ChevronDown, Folder as FolderClose, FolderOpen, Plus } from '../components/icons'
import { Text } from '../components/text'
import {
  HERO_WORKSPACE_FLOW_SLOT,
} from '../constants'
import { locale } from '../locales'

const ADD_WORKSPACE_ID = '::add-workspace'

const UNGROUPED_ID = '::ungrouped'

const EMPTY_WORKSPACES: WorkspaceListStateLike = { items: [], phase: 'ready' }

const absentWorkspaces: SelectorHook<WorkspaceListStateLike> = select => select(EMPTY_WORKSPACES)
const absentSessions: SelectorHook<SessionListStateLike> = select => select({})
const absentFlow: SelectorHook<boolean> = select => select(false)

export function HeroWorkspace(props: HeroWorkspaceProps): ReactElement {
  const { open, selectedId, onPick, onClose, createWorkspace, startUngrouped } = props
  locale.useLocale()
  const [expanded, setExpanded] = useState(false)
  const [flowOpen, setFlowOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [folderError, setFolderError] = useState<string | null>(null)
  const chipRef = useRef<HTMLButtonElement>(null)

  const selectWorkspaces = props.useWorkspaces ?? absentWorkspaces
  const selectSessions = props.useSessions ?? absentSessions
  const selectFlow = props.useDirectoryFlow ?? absentFlow
  const workspaces = selectWorkspaces(state => state.items)
  const phase = selectWorkspaces(state => state.phase)
  const current = selectSessions(state => state.current)
  const flowAvailable = selectFlow(occupied => occupied)

  const busy = flowOpen || picking
  const visible = expanded || open

  const close = useCallback(() => {
    setExpanded(false)
    onClose()
  }, [onClose])

  const openFlow = useCallback(() => {
    close()
    setFolderError(null)
    setFlowOpen(true)
  }, [close])

  const adopt = useCallback((path: string) => {
    if (createWorkspace === undefined)
      return
    setPicking(true)
    createWorkspace({ path })
      .then(
        (workspace) => {
          setFlowOpen(false)
          onPick(workspace.workspaceId)
        },
        (reason: unknown) => {
          setFlowOpen(false)
          setFolderError(reason instanceof Error ? reason.message : String(reason))
        },
      )
      .finally(() => setPicking(false))
  }, [createWorkspace, onPick])

  const selected = workspaces.find(workspace => workspace.workspaceId === selectedId)
  const activeId = selectedId ?? (current === undefined ? undefined : UNGROUPED_ID)
  const label = selectedId === undefined
    ? (current === undefined ? undefined : locale.text('ungrouped'))
    : selected?.title

  const addEntries: MenuEntry[] = flowAvailable && createWorkspace !== undefined
    ? [{ id: ADD_WORKSPACE_ID, label: locale.text('addWorkspace'), icon: <Plus width={16} height={16} />, disabled: busy }]
    : []
  const pinned = workspaces.length > 0
  const items: MenuEntry[] = [
    { id: UNGROUPED_ID, label: locale.text('ungrouped'), icon: <FolderClose width={16} height={16} />, disabled: busy },
    ...workspaces.map(workspace => ({
      id: workspace.workspaceId,
      label: workspace.title,
      icon: <FolderOpen width={16} height={16} />,
      disabled: busy,
    })),
    ...pinned ? [] : addEntries,
  ]

  const handleSelect = (id: string): void => {
    if (id === UNGROUPED_ID) {
      close()
      startUngrouped()
      return
    }
    if (id === ADD_WORKSPACE_ID) {
      openFlow()
      return
    }
    close()
    onPick(id)
  }

  const onChipClick = (): void => {
    if (visible)
      close()
    else
      setExpanded(true)
  }

  return (
    <>
      <Chip
        ref={chipRef}
        variant="seat"
        data-hero-workspace="1"
        className="max-w-[min(100%,360px)]"
        aria-label={locale.text('chooseWorkspace')}
        aria-haspopup="menu"
        aria-expanded={visible}
        icon={label === undefined
          ? <FolderClose width={16} height={16} />
          : <FolderOpen width={16} height={16} />}
        chevron={<ChevronDown width={12} height={12} />}
        onClick={onChipClick}
      >
        {label ?? locale.text('chooseWorkspace')}
      </Chip>
      <Menu
        open={visible}
        anchor={null}
        items={items}
        {...pinned ? { footer: addEntries } : {}}
        selectedId={activeId}
        onSelect={handleSelect}
        onClose={close}
        side="bottom"
        portal
        getAnchorRect={() => chipRef.current?.getBoundingClientRect() ?? null}
      />
      {visible && phase === 'pending' && (
        <div className="text-tertiary text-[12px] leading-[20px]" role="status">
          {locale.text('loading')}
        </div>
      )}
      <SlotOutlet
        slotKey={HERO_WORKSPACE_FLOW_SLOT}
        ownerProps={{
          open: flowOpen,
          busy: picking,
          onPicked: adopt,
          onCancel: () => setFlowOpen(false),
          onError: (message: string) => {
            setFlowOpen(false)
            setFolderError(message)
          },
        }}
      />
      <Modal
        open={folderError !== null}
        onClose={() => setFolderError(null)}
        closeLabel={locale.text('close')}
        title={locale.text('folderErrorTitle')}
        footer={(
          <>
            <Button
              variant="outline"
              className="min-w-[72px]"
              onClick={() => setFolderError(null)}
            >
              {locale.text('cancel')}
            </Button>
            <Button
              variant="primary"
              className="min-w-[72px]"
              disabled={!flowAvailable}
              onClick={openFlow}
            >
              {locale.text('folderErrorRetry')}
            </Button>
          </>
        )}
      >
        <Text tone="error" role="alert">{folderError}</Text>
      </Modal>
    </>
  )
}
