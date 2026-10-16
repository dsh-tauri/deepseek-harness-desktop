import type { Profile } from '@/types'
import { CopyArrowRight, Plus } from '@gravity-ui/icons'
import { AlertDialog, Button, Checkbox, Chip, Description, Input, Label } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useToggle } from '@reause/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'

import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { Ellipsis } from '@/components/ellipsis'
import { Item } from '@/components/item'
import { Modal } from '@/components/modal'
import { Panel } from '@/components/panel'
import { queryKeys } from '@/config/query-keys'
import { useInvalidateOnSettingUpdated } from '@/hooks/use-invalidate-on-setting-updated'
import { store } from '@/store'
import { waitForHarnessStopped } from '@/store/modules/harness'
import { ConfigBackup } from '@/ui/config/backup'
import { ProfileMigrateDialog } from '@/ui/dialog/profile-migrate'
import { normalizeProfileId } from '@/utils/profile-id'
import { silence } from '@/utils/silence'
import { toast } from '@/utils/toast'

type ProfileView = 'list' | { profile: string }

/** 宿主档案错误的 `CODE` → 提示 key（错误串是 `CODE: 详情`，详见 `service::profile`） */
const PROFILE_ERROR_KEYS: Record<string, string> = {
  PROFILE_EMPTY_NAME: 'profiles.error_empty_name',
  PROFILE_NAME_TOO_LONG: 'profiles.error_name_too_long',
  PROFILE_RESERVED: 'profiles.error_reserved',
  PROFILE_NOT_FOUND: 'profiles.error_not_found',
}

export function ConfigProfile() {
  const queryClient = useQueryClient()
  const { data: profileList, isLoading, error: profileError, refetch } = useQuery({
    queryKey: queryKeys.profiles,
    queryFn: () => invoke<Profile[]>('get_profiles'),
  })
  // 切换档案会写桌面端 store（触发 `setting_updated`），监听该事件一并失效重拉，
  // 保证面板列表与后端设置始终一致。
  useInvalidateOnSettingUpdated(queryKeys.profiles)

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.profiles })
  }

  const create = useMutation({
    mutationFn: (name: string) => invoke<Profile>('create_profile', { name }),
    onSuccess: invalidate,
  })
  const activate = useMutation({
    mutationFn: (id: string) => store.harness.switchProfile(id),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => invoke<void>('remove_profile', { id }),
    onSuccess: invalidate,
  })
  const reset = useMutation({
    mutationFn: (id: string) => invoke<void>('reset_profile', { id }),
    onSuccess: invalidate,
  })
  const clone = useMutation({
    mutationFn: (params: { sourceId: string, name: string }) => invoke<Profile>('clone_profile', params),
    onSuccess: invalidate,
  })

  /** 写操作封装：等待列表重拉完成再返回，调用方拿到的列表与后端一致 */
  async function createProfile(name: string): Promise<Profile> {
    const created = await create.mutateAsync(name)
    await refetch()
    return created
  }

  async function activateProfile(id: string): Promise<void> {
    await activate.mutateAsync(id)
    await refetch()
  }

  async function removeProfile(id: string) {
    await remove.mutateAsync(id)
    await refetch()
  }

  async function resetProfile(id: string) {
    await reset.mutateAsync(id)
    await refetch()
  }

  async function cloneProfile(sourceId: string, name: string): Promise<Profile> {
    const created = await clone.mutateAsync({ sourceId, name })
    await refetch()
    return created
  }

  const profiles = profileList ?? []
  const loading = isLoading
  const error = profileError ? String(profileError) : ''
  /** 当前使用中的档案，即迁移的目标（不可更改） */
  const activeProfile = profiles.find(profile => profile.active)
  /** 操作进行中标记（新建/切换/删除/重置/克隆任一） */
  const busy = create.isPending || activate.isPending || remove.isPending || reset.isPending || clone.isPending

  /** 迁移入口的禁用条件：操作进行中、没有当前档案、或没有第二个档案可作来源 */
  const migrateBlocked = busy || !activeProfile || profiles.length < 2

  const [dialogHolder, openDialog] = useOverlay(Modal, { type: 'holder' })

  const { t } = useTranslation()
  const [creating, toggleCreating] = useToggle()
  const [name, setName] = useState('')
  const [activeView, setActiveView] = useState<ProfileView>('list')

  // 克隆档案：命名对话框状态
  const [cloning, setCloning] = useState<{ sourceId: string, sourceName: string } | null>(null)
  const [cloneName, setCloneName] = useState('')

  // 迁移档案数据：来源档案在对话框内选择，目标恒为当前使用中的档案
  const [migrateDialogHolder, openMigrateDialog] = useOverlay(ProfileMigrateDialog, { type: 'holder' })

  /**
   * 档案名会直接当磁盘目录名与 CLI `--profile` 参数，只能用 ASCII 字母数字（`-`/`_`/空格
   * 分隔，其余字符被丢弃，与后端 `normalize_profile_id` 同一套规则）。归一化后为空说明
   * 整个名字都不可用（例如纯中文）：在输入框下面就讲清楚，按钮同时置灰，不让用户提交后
   * 才撞上一个机器错误码。
   */
  function profileNameHint(value: string): string | null {
    if (value.trim() === '' || normalizeProfileId(value) !== '')
      return null
    return t('profiles.name_invalid_hint')
  }

  /**
   * 宿主错误串换成用户能看懂的一句话；未知错误码照原样显示，免得把真实原因吞掉。
   *
   * 「名字不可用」直接用输入框那条提示文案，「已存在」复用已有的 `clone_exists`（带名字），
   * 其余按码查表——同一件事在两个地方各写一份文案就是新的漂移源。
   */
  function profileErrorText(error: unknown, name: string): string {
    const code = String(error).split(':')[0]?.trim() ?? ''
    if (code === 'PROFILE_INVALID_NAME')
      return t('profiles.name_invalid_hint')
    if (code === 'PROFILE_EXISTS')
      return t('profiles.clone_exists', { name })
    const key = PROFILE_ERROR_KEYS[code]
    return key ? t(key) : String(error)
  }

  const createNameHint = profileNameHint(name)
  const cloneNameHint = profileNameHint(cloneName)

  /** 推导下一个未占用的自动递增名称（仅作为建议，后端才是权威） */
  function suggestCloneName(base: string): string {
    const taken = new Set(profiles.map(p => p.id))
    for (let n = 1; n <= 1000; n++) {
      const candidate = `${base}-${n}`
      if (!taken.has(candidate))
        return candidate
    }
    return `${base}-1`
  }

  function openCloneDialog(profile: { id: string, name: string }) {
    setCloning({ sourceId: profile.id, sourceName: profile.name })
    setCloneName(suggestCloneName(profile.id))
  }

  async function commitClone() {
    if (!cloning)
      return
    const trimmed = cloneName.trim()
    if (!trimmed) {
      toast(t('profiles.clone_empty'), {})
      return
    }
    if (cloneNameHint !== null)
      return
    try {
      await cloneProfile(cloning.sourceId, trimmed)
      setCloning(null)
      setCloneName('')
      toast(t('profiles.clone_success', { name: trimmed }), {
        variant: 'accent',
        description: t('profiles.clone_success_hint'),
        timeout: 10_000,
      })
    }
    catch (err) {
      console.error('[ConfigProfile] clone failed:', err)
      toast(t('profiles.clone_failed'), { description: profileErrorText(err, trimmed) })
    }
  }

  async function onActivate(id: string) {
    const target = profiles.find(p => p.id === id)
    if (!target || target.active || busy)
      return
    try {
      await openDialog({
        status: 'warning',
        title: t('profiles.activate_confirm_title'),
        description: (
          <p>
            {t('profiles.activate_confirm_desc', { name: target.name })}
          </p>
        ),
      })
    }
    catch (e) {
      silence(e, 'profile activate: dialog cancelled')
      return
    }
    try {
      await activateProfile(id)
    }
    catch (err) {
      console.error('[ConfigProfile] activate failed:', err)
      toast(t('profiles.activate_failed', { name: target.name }), {})
    }
  }

  function startCreate() {
    toggleCreating(true)
    setName('')
  }

  function cancelCreate() {
    toggleCreating(false)
    setName('')
  }

  async function commitCreate() {
    const trimmed = name.trim()
    if (!trimmed)
      return
    if (createNameHint !== null)
      return
    try {
      // 创建成功后列表已刷新出新档案，UI 本身就有变化，不再弹成功 toast
      await createProfile(trimmed)
      toggleCreating(false)
      setName('')
    }
    catch (err) {
      console.error('[ConfigProfile] create failed:', err)
      toast(t('profiles.create_failed'), { description: profileErrorText(err, trimmed) })
    }
  }

  async function onRemove(id: string) {
    const target = profiles.find(p => p.id === id)
    if (!target || busy)
      return
    try {
      await openDialog({
        title: t('profiles.remove_confirm_title'),
        status: 'danger',
        description: (
          <p>
            {t('profiles.remove_confirm_desc', { name: target.name })}
          </p>
        ),
        confirmText: t('profiles.remove_confirm'),
      })
    }
    catch (e) {
      silence(e, 'profile remove: dialog cancelled')
      return
    }
    try {
      // 删除成功后列表已移除该档案，UI 本身就有变化，不再弹成功 toast
      await removeProfile(id)
    }
    catch (err) {
      console.error('[ConfigProfile] remove failed:', err)
      toast(t('profiles.remove_failed'), {})
    }
  }

  /**
   * 重置档案：清空档案数据（插件/补丁/设置）后按模板重新初始化。
   *
   * 会话存放在 `$DSH_HOME/sessions`（档案目录之外），重置不受影响。
   * 只有当前使用中的档案会被运行中的服务锁住目录，因此仅此时沿用备份还原的编排
   * （先停服务并确认已停止，再重置，最后重新拉起）；重置其余档案不打扰在跑的服务。
   */
  async function onReset(id: string) {
    const target = profiles.find(p => p.id === id)
    if (!target || busy)
      return
    try {
      await openDialog({
        status: 'danger',
        title: t('profiles.reset_confirm_title'),
        description: (
          <p>
            {t('profiles.reset_confirm_desc', { name: target.name })}
          </p>
        ),
        confirmText: t('profiles.reset_confirm'),
      })
    }
    catch (e) {
      silence(e, 'profile reset: dialog cancelled')
      return
    }
    if (target.active) {
      toast(t('profiles.reset_stopped_toast'), { variant: 'accent' })
      try {
        await invoke('shutdown_harness')
      }
      catch (e) {
        console.warn('[ConfigProfile] shutdown_harness failed (may already be stopped):', e)
      }
      await waitForHarnessStopped()
    }
    try {
      await resetProfile(id)
      if (target.active) {
        invoke('launch_harness').catch((e) => {
          console.warn('[ConfigProfile] launch_harness failed:', e)
        })
      }
      const key = toast(t('profiles.reset_success', { name: target.name }), {
        variant: 'accent',
        description: t('profiles.reset_success_hint'),
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
      console.error('[ConfigProfile] reset failed:', err)
      toast(t('profiles.reset_failed'), {})
    }
  }

  // 备份子视图：点击档案的「备份」芯片后进入
  if (activeView !== 'list') {
    return (
      <ConfigBackup onBack={() => setActiveView('list')} />
    )
  }

  return (
    <div className="space-y-3">
      <Panel.Header
        title={t('profiles.title')}
        description={t('profiles.tooltip')}
        testId="dsh-config-panel-title"
        action={(
          <Button
            size="sm"
            variant="primary"
            isDisabled={migrateBlocked}
            onPress={() => void openMigrateDialog()}
          >
            <CopyArrowRight className="size-3.5" />
            {t('profiles.migrate')}
          </Button>
        )}
      />

      {/* 加载 / 失败 / 列表 */}
      <Panel.Loadable loading={loading} error={error}>
        <div className="flex flex-col gap-4">
          {profiles.map(profile => (
            <Item
              key={profile.id}
              onClick={() => onActivate(profile.id)}
              left={(
                <>
                  <Label className="min-w-0 truncate text-sm font-medium text-ink">
                    {profile.name}
                  </Label>
                  <If cond={profile.default}>
                    <Description className="min-w-0 text-xs text-muted">
                      <Ellipsis>{t('profiles.default_desc')}</Ellipsis>
                    </Description>
                  </If>
                </>
              )}
              right={(
                <>
                  <Checkbox
                    isSelected={profile.active}
                    isDisabled={busy}
                    onChange={() => onActivate(profile.id)}
                    aria-label={profile.name}
                    className="shrink-0"
                  >
                    <Checkbox.Content>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                    </Checkbox.Content>
                  </Checkbox>
                  <Chip
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation()
                      setActiveView({ profile: profile.id })
                    }}
                  >
                    {t('backup.manage')}
                  </Chip>
                  <Chip
                    className={busy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}
                    color="accent"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation()
                      if (!busy)
                        openCloneDialog(profile)
                    }}
                  >
                    {t('profiles.clone')}
                  </Chip>
                  <Chip
                    className={busy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}
                    variant="primary"
                    color="danger"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation()
                      if (busy)
                        return
                      if (profile.default) {
                        onReset(profile.id)
                        return
                      }
                      onRemove(profile.id)
                    }}
                  >
                    {profile.default ? t('profiles.reset') : t('profiles.remove')}
                  </Chip>
                </>
              )}
            />
          ))}
          {/* 新建档案：内联输入 or 触发入口 */}
          <If
            cond={!creating}
            else={(
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2 px-1">
                  <Input
                    autoFocus
                    variant="secondary"
                    className="h-8 flex-1"
                    placeholder={t('profiles.name_placeholder')}
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter')
                        commitCreate()
                    }}
                  />
                  <Button size="sm" variant="tertiary" className="h-8" onPress={cancelCreate}>
                    {t('profiles.create_cancel')}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    className="h-8"
                    isDisabled={!name.trim() || createNameHint !== null || busy}
                    onPress={commitCreate}
                  >
                    {t('profiles.create_confirm')}
                  </Button>
                </div>
                <If
                  cond={createNameHint !== null}
                  then={(
                    <p className="px-1 text-xs text-muted">{createNameHint}</p>
                  )}
                />
              </div>
            )}
          >
            <Button
              onClick={startCreate}
              variant="tertiary"
              className="flex w-full"
              isDisabled={busy}
            >
              <Plus className="size-3.5" />
              <span>{t('profiles.new_profile')}</span>
            </Button>
          </If>
        </div>
      </Panel.Loadable>
      {dialogHolder}
      {migrateDialogHolder}

      {/* 克隆档案：命名对话框（创建型，accent；可编辑建议名称） */}
      <AlertDialog
        isOpen={cloning !== null}
        onOpenChange={(open) => {
          if (!open)
            setCloning(null)
        }}
      >
        <AlertDialog.Backdrop>
          <AlertDialog.Container>
            <AlertDialog.Dialog className="sm:max-w-[400px]">
              <AlertDialog.CloseTrigger />
              <AlertDialog.Header>
                <AlertDialog.Icon status="accent" />
                <AlertDialog.Heading>{t('profiles.clone_dialog_title')}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p className="text-xs text-muted">
                  {cloning && t('profiles.clone_dialog_desc', { name: cloning.sourceName })}
                </p>
                <Input
                  autoFocus
                  variant="secondary"
                  className="h-8 w-full my-2"
                  placeholder={t('profiles.clone_name_placeholder')}
                  value={cloneName}
                  onChange={e => setCloneName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')
                      commitClone()
                  }}
                />
                <If
                  cond={cloneNameHint !== null}
                  then={(
                    <p className="mb-1 text-xs text-muted">{cloneNameHint}</p>
                  )}
                />
                {cloning && (
                  <p className="text-xs text-muted">
                    {t('profiles.clone_default_hint', { name: suggestCloneName(cloning.sourceId) })}
                  </p>
                )}
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="tertiary" onPress={() => setCloning(null)}>
                  {t('profiles.clone_cancel')}
                </Button>
                <Button
                  variant="primary"
                  isDisabled={!cloneName.trim() || cloneNameHint !== null || busy}
                  onPress={commitClone}
                >
                  {busy ? t('profiles.clone_cloning') : t('profiles.clone_confirm')}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </div>
  )
}
