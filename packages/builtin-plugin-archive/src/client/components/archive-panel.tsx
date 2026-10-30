import type { MenuEntry } from 'dsh-tauri-ui/client'
import type { ReactElement } from 'react'
import type { ArchiveSort } from '../store/modules/archive.types'
import type { ArchivePanelProps, DeleteConfirm } from './archive-panel.types'
import { Action, Button, Ellipsis, FolderOpen, Icon, Input, Magnifier, Menu, Modal, Select, Text, Toast, TrashBin } from 'dsh-tauri-ui/client'
import { isEmpty, useWatchImmediate } from 'dsh-tauri/client'
import { useCallback, useState } from 'react'
import { useArchiveView } from '../hooks/use-archive-view'
import { locale } from '../locales'
import {
  clearArchive,
  deleteSession,
  deleteWorkspaceSessions,
  fetchArchive,
  openSessionDir,
  unarchiveSession,
} from '../service/archive'
import { store } from '../store'
import { formatTime, projectOptions } from './archive-panel.utils'

export function ArchivePanel(props: ArchivePanelProps): ReactElement | null {
  const { ui, rows, visible, groups, busy } = useArchiveView(props)
  locale.useLocale()
  const [confirm, setConfirm] = useState<DeleteConfirm>(null)
  const [openGroupMenu, setOpenGroupMenu] = useState<string | null>(null)
  const [openPathError, setOpenPathError] = useState<string | null>(null)

  useWatchImmediate((props.workspacesRuntime.list.getSnapshot().archivedSessionIds ?? []).length, () => {
    void fetchArchive()
  })

  const resync = useCallback(async () => {
    await props.workspacesRuntime.manager?.refresh?.()
    await props.sessionsRuntime.refresh?.()
  }, [props.workspacesRuntime, props.sessionsRuntime])

  function handleConfirmDelete(): void {
    const active = confirm
    setConfirm(null)
    if (active?.kind === 'single')
      void deleteSession({ sessionId: active.sessionId, resync })
    else if (active?.kind === 'all')
      void clearArchive({ resync })
    else if (active?.kind === 'workspace')
      void deleteWorkspaceSessions({ sessionIds: active.sessionIds, resync })
  }

  async function handleOpenSessionDirectory(sessionId: string): Promise<void> {
    const result = await openSessionDir({ sessionId })
    setOpenPathError(result.ok ? null : result.error ?? '')
  }

  const sortOptions = [
    { value: 'updatedAt', label: locale.text('sortUpdatedAt') },
    { value: 'createdAt', label: locale.text('sortCreatedAt') },
    { value: 'title', label: locale.text('sortTitle') },
  ]
  const projectFilterOptions = [
    { value: 'all', label: locale.text('allProjects') },
    ...projectOptions(rows),
    ...(rows.some(row => !row.workspaceId) ? [{ value: 'ungrouped', label: locale.text('ungrouped') }] : []),
  ]

  const footer = (
    <>
      <Button variant="ghost" onClick={() => setConfirm(null)}>{locale.text('cancel')}</Button>
      <Button
        variant="danger"
        disabled={ui.pending}
        onClick={handleConfirmDelete}
      >
        {locale.text('deleteConfirm')}
      </Button>
    </>
  )

  return (
    <div className="flex flex-col gap-[16px] min-h-full text-primary">
      <div className="flex items-center justify-between gap-[12px]">
        <h1 className="m-0 text-[24px] leading-[32px] font-semibold">{locale.text('archiveTitle')}</h1>
        <Button
          type="button"
          variant="danger"
          icon={<Icon as={TrashBin} />}
          disabled={busy}
          onClick={() => setConfirm({ kind: 'all' })}
        >
          {locale.text('deleteAll')}
        </Button>
      </div>

      <div className="sticky top-0 z-[2] flex items-center gap-[8px] flex-wrap py-[8px] bg-[var(--dsw-alias-bg-base,var(--dsw-alias-bg-module-platform))]">
        <Input
          className="flex-[1_1_220px] min-w-0"
          value={ui.query}
          placeholder={locale.text('searchPlaceholder')}
          aria-label={locale.text('searchPlaceholder')}
          icon={<Icon as={Magnifier} />}
          onChange={event => store.archive.setQuery(event.target.value)}
        />
        <Select
          className="max-w-[220px] min-w-0 truncate"
          label={locale.text('sortLabel')}
          options={sortOptions}
          value={ui.sort}
          onChange={id => store.archive.setSort(id as ArchiveSort)}
        />
        <Select
          className="max-w-[220px] min-w-0 truncate"
          label={locale.text('allProjects')}
          options={projectFilterOptions}
          value={ui.workspaceId}
          onChange={id => store.archive.setWorkspaceFilter(id)}
        />
      </div>

      {ui.error && <Text size="sm" tone="error" className="px-[16px] py-[12px] rounded-[10px] bg-hover">{ui.error}</Text>}

      {!ui.loading && isEmpty(visible) && (
        <Text className="py-[32px] text-center text-[14px] leading-[22px]">{ui.query ? locale.text('noResults') : locale.text('empty')}</Text>
      )}

      <div className="flex flex-col gap-[20px]">
        {groups.map(group => (
          <section key={group.id} className="flex flex-col gap-[8px]">
            <div className="flex items-center gap-[8px] px-[2px] text-secondary">
              <Icon as={FolderOpen} />
              <span className="text-[14px] leading-[22px] font-medium text-primary truncate">{group.title || locale.text('ungrouped')}</span>
              <Text size="sm" tone="secondary" className="ml-auto">
                {group.rows.length}
                {' '}
                {locale.text('chats')}
              </Text>
              <Menu
                open={openGroupMenu === group.id}
                onClose={() => setOpenGroupMenu(null)}
                onSelect={(id) => {
                  setOpenGroupMenu(null)
                  if (id === 'delete') {
                    setConfirm({
                      kind: 'workspace',
                      workspaceTitle: group.title || locale.text('ungrouped'),
                      sessionIds: rows.filter(row => group.id === 'ungrouped' ? !row.workspaceId : row.workspaceId === group.id).map(row => row.sessionId),
                    })
                  }
                }}
                items={[{
                  id: 'delete',
                  label: locale.text('deleteProjectChats'),
                  icon: <Icon as={TrashBin} />,
                  danger: true,
                } satisfies MenuEntry]}
                portal
                align="end"
                anchor={(
                  <Action
                    variant="action"
                    icon={<Icon size={12} as={Ellipsis} />}
                    aria-label={locale.text('groupMenuAria')}
                    aria-haspopup="menu"
                    aria-expanded={openGroupMenu === group.id}
                    onClick={() => setOpenGroupMenu(openGroupMenu === group.id ? null : group.id)}
                  />
                )}
              />
            </div>
            <ul className="flex flex-col m-0 p-0 list-none border border-border-weak rounded-[12px] overflow-hidden">
              {group.rows.map(row => (
                <li key={row.sessionId} className="flex items-center gap-[12px] box-border px-[16px] py-[14px] bg-[var(--dsw-alias-bg-base)] min-h-[64px] [&+&]:border-t [&+&]:border-border-weak">
                  <div className="flex-[1_1_auto] min-w-0 flex flex-col gap-[4px]">
                    <div>
                      <Button
                        variant="link"
                        className="truncate"
                        title={locale.text('openDirectory')}
                        aria-label={`${locale.text('openDirectory')}: ${row.title}`}
                        onClick={() => void handleOpenSessionDirectory(row.sessionId)}
                      >
                        {row.title}
                      </Button>
                    </div>
                    <Text size="sm" tone="secondary" className="truncate">{formatTime(row)}</Text>
                  </div>
                  <div className="flex-none flex items-center gap-[8px]">
                    <Action
                      variant="action"
                      icon={<Icon as={TrashBin} />}
                      aria-label={locale.text('deleteRowAria')}
                      disabled={busy}
                      onClick={() => setConfirm({ kind: 'single', sessionId: row.sessionId })}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void unarchiveSession({ sessionId: row.sessionId, resync })}
                    >
                      {locale.text('unarchive')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={locale.text(confirm?.kind === 'single' ? 'deleteSingleTitle' : confirm?.kind === 'all' ? 'deleteAllTitle' : 'deleteProjectTitle')}
        description={confirm?.kind === 'workspace'
          ? locale.text('deleteProjectBody', { count: confirm.sessionIds.length, workspace: confirm.workspaceTitle })
          : locale.text(confirm?.kind === 'single' ? 'deleteSingleBody' : 'deleteAllBody')}
        footer={footer}
        closeLabel={locale.text('close')}
      />

      {openPathError
        ? (
            <Toast
              key={openPathError}
              text={locale.text('openFailed', { reason: openPathError })}
              onDone={() => setOpenPathError(null)}
            />
          )
        : null}
    </div>
  )
}
