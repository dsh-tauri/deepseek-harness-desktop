import { ArrowLeft, Delete } from '@gravity-ui/icons'
import { Button, Checkbox, Chip, Description, Label, Spinner } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useToggle } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { Item } from '@/components/item'
import { Modal } from '@/components/modal'
import { Panel } from '@/components/panel'
import { useBackups } from '@/hooks/use-backup'
import { store } from '@/store'
import { silence } from '@/utils/silence'
import { toast } from '@/utils/toast'

export interface ConfigBackupProps {
  profileId: string
  active: boolean
  onBack: () => void
}

/** 把字节转为 MB 展示（保留 1 位小数）。 */
function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}`
}

export function ConfigBackup({ profileId, active, onBack }: ConfigBackupProps) {
  const { t } = useTranslation()
  const { backups, loading, error, createBackup, restoreBackup, deleteBackup, busy, creating, restoring, deleting, exporting, recoveryBackup, exportRecoveryBackup } = useBackups(profileId)
  const [dialogHolder, openDialog] = useOverlay(Modal, { type: 'holder' })

  const [includeCredentials, toggleIncludeCredentials] = useToggle()

  async function handleCreate() {
    try {
      await createBackup(includeCredentials)
      toast(t('backup.created_toast'), { variant: 'accent', timeout: 5000 })
    }
    catch (err) {
      console.error('[ConfigBackup] create failed:', err)
      toast(`${t('backup.failed_toast')}: ${String(err)}`, { variant: 'danger' })
    }
  }

  async function handleExportRecovery() {
    try {
      await openDialog({
        status: 'warning',
        title: t('backup.recovery_confirm_title'),
        description: <p>{t('backup.recovery_confirm_desc')}</p>,
        confirmText: t('backup.export_recovery'),
      })
    }
    catch (e) {
      silence(e, 'backup: recovery export cancelled')
      return
    }
    try {
      await exportRecoveryBackup(includeCredentials)
      toast(t('backup.recovery_created'), { variant: 'accent', timeout: 10000 })
    }
    catch (err) {
      toast(`${t('backup.failed_toast')}: ${String(err)}`, { variant: 'danger' })
    }
  }

  async function handleRevealRecovery() {
    if (!recoveryBackup)
      return
    try {
      await invoke('reveal_in_folder', { path: recoveryBackup.path })
    }
    catch (err) {
      toast(String(err), { variant: 'danger' })
    }
  }

  async function handleRestore(timestamp: string) {
    try {
      await openDialog({
        status: 'danger',
        title: t('backup.restore_confirm_title'),
        description: (
          <p>
            {t('backup.restore_confirm_desc', { timestamp })}
          </p>
        ),
      })
    }
    catch (e) {
      silence(e, 'backup: dialog cancelled')
      return
    }
    try {
      await restoreBackup(timestamp, false)
      if (!active) {
        toast(t('backup.restored_toast'), { variant: 'accent', timeout: 5000 })
        return
      }
      // 还原后自动启动 DSH 服务（后台异步，不阻塞 UI）
      invoke('launch_harness').catch((e) => {
        console.warn('[ConfigBackup] launch_harness failed:', e)
      })
      const key = toast(t('backup.restored_toast'), {
        variant: 'accent',
        timeout: 10_000,
        actionProps: {
          children: t('app.restart'),
          onPress: () => {
            store.harness.restart()
            toast.close(key)
          },
        },
      })
    }
    catch (err) {
      console.error('[ConfigBackup] restore failed:', err)
      toast(`${t('backup.restore_failed')}: ${String(err)}`, { variant: 'danger' })
    }
  }

  async function handleRestoreAsNew(timestamp: string) {
    try {
      await openDialog({
        status: 'warning',
        title: t('backup.restore_new_confirm_title'),
        description: (
          <p>
            {t('backup.restore_new_confirm_desc', { timestamp })}
          </p>
        ),
      })
    }
    catch (e) {
      silence(e, 'backup: dialog cancelled')
      return
    }
    try {
      await restoreBackup(timestamp, true)
      toast(t('backup.restored_toast'), { variant: 'accent', timeout: 5000 })
    }
    catch (err) {
      console.error('[ConfigBackup] restore as new failed:', err)
      toast(`${t('backup.restore_failed')}: ${String(err)}`, { variant: 'danger' })
    }
  }

  async function handleDelete(timestamp: string) {
    try {
      await openDialog({
        status: 'danger',
        title: t('backup.delete_confirm_title'),
        description: (
          <p>
            {t('backup.delete_confirm_desc', { timestamp })}
          </p>
        ),
        confirmText: t('backup.delete'),
      })
    }
    catch (e) {
      silence(e, 'backup: dialog cancelled')
      return
    }
    try {
      await deleteBackup(timestamp)
      toast(t('backup.deleted_toast'), { variant: 'accent', timeout: 5000 })
    }
    catch (err) {
      console.error('[ConfigBackup] delete failed:', err)
      toast(t('backup.delete_failed'), { variant: 'danger' })
    }
  }

  return (
    <div className="space-y-3 pl-4">
      <Button variant="tertiary" className="h-8" onPress={onBack}>
        <ArrowLeft className="size-3.5" />
        <span>{t('backup.back_to_profiles')}</span>
      </Button>

      {/* 手动备份 */}
      <Panel.Header title={t('backup.manual_section')} description={t('backup.profile_scope', { profile: profileId })} />
      <div className="flex flex-col gap-3">
        <Button
          variant="primary"
          isDisabled={busy}
          onPress={handleCreate}
        >
          <If cond={creating}>
            <Spinner size="sm" color="current" />
            <span>{t('backup.in_progress')}</span>
          </If>
          <If cond={!creating}>
            <span>{t('backup.now')}</span>
          </If>
        </Button>
        <label className="flex items-center gap-2 cursor-pointer">
          <Checkbox
            isSelected={includeCredentials}
            onChange={(value: boolean) => toggleIncludeCredentials(value)}
            aria-label={t('backup.include_credentials')}
            className="shrink-0"
          >
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
            </Checkbox.Content>
          </Checkbox>
          <span className="text-xs text-ink">{t('backup.include_credentials')}</span>
        </label>
        <If cond={includeCredentials}>
          <Description className="text-[10px] text-danger">
            {t('backup.credentials_warning')}
          </Description>
        </If>
      </div>

      <Panel.Header title={t('backup.recovery_section')} description={t('backup.recovery_desc')} />
      <Button variant="secondary" isDisabled={busy} onPress={handleExportRecovery}>
        <If cond={exporting}>
          <Spinner size="sm" color="current" />
          <span>{t('backup.exporting_recovery')}</span>
        </If>
        <If cond={!exporting}>
          <span>{t('backup.export_recovery')}</span>
        </If>
      </Button>
      <If cond={Boolean(recoveryBackup)}>
        <div className="space-y-2">
          <p className="break-all text-xs text-muted">{recoveryBackup?.path}</p>
          <Button variant="tertiary" onPress={handleRevealRecovery}>{t('backup.reveal_recovery')}</Button>
        </div>
      </If>

      {/* 备份列表 */}
      <Panel.Header title={t('backup.list_section')} description="" />
      <Panel.Loadable loading={loading} error={error}>
        <If
          cond={backups.length === 0}
          else={(
            <div className="flex flex-col gap-4">
              {backups.map(backup => (
                <Item
                  key={backup.timestamp}
                  left={(
                    <>
                      <Label className="text-xs font-mono text-muted">
                        {backup.timestamp}
                      </Label>
                      <Description className="text-xs font-mono text-muted">
                        {formatSize(backup.size)}
                        {' '}
                        {t('backup.size_unit')}
                      </Description>
                    </>
                  )}
                  right={(
                    <>
                      <Button
                        size="sm"
                        variant="tertiary"
                        className="h-7"
                        isDisabled={busy}
                        onPress={() => handleRestore(backup.timestamp)}
                      >
                        <If cond={restoring}>
                          <Spinner size="sm" color="current" />
                        </If>
                        {restoring ? t('backup.restoring') : t('backup.restore')}
                      </Button>
                      <Button
                        size="sm"
                        variant="tertiary"
                        className="h-7"
                        isDisabled={busy}
                        onPress={() => handleRestoreAsNew(backup.timestamp)}
                      >
                        {restoring ? t('backup.restoring') : t('backup.restore_as_new')}
                      </Button>
                      <Chip
                        className={deleting ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}
                        variant="primary"
                        color="danger"
                        size="sm"
                        onClick={() => {
                          if (!busy)
                            handleDelete(backup.timestamp)
                        }}
                      >
                        <Delete className="size-3" />
                      </Chip>
                    </>
                  )}
                />
              ))}
            </div>
          )}
        >
          <div className="space-y-1 rounded-md border border-line bg-panel2/40 p-3">
            <Label className="text-xs font-medium text-ink">{t('backup.empty_title')}</Label>
            <Description className="text-xs text-muted">{t('backup.empty_desc')}</Description>
          </div>
        </If>
      </Panel.Loadable>

      {dialogHolder}
    </div>
  )
}
