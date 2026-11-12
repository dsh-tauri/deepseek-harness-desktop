import type { HarnessCore } from '@/types'
import { ArrowRotateRight, ChevronRight, CircleArrowDown as DownloadIcon, FolderOpen } from '@gravity-ui/icons'
import { Button, Checkbox, Chip, Description, Label, Spinner, Switch } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useToggle } from '@reause/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { Empty } from '@/components/empty'
import { Item } from '@/components/item'
import { Modal } from '@/components/modal'
import { Panel } from '@/components/panel'
import { queryKeys } from '@/config/query-keys'
import { useInvalidateOnSettingUpdated } from '@/hooks/use-invalidate-on-setting-updated'
import { store } from '@/store'
import { DownloadCoreDialog } from '@/ui/dialog/update-core'
import { compareVersions, isCoreUnsupported, MIN_SUPPORTED_CORE_VERSION } from '@/utils/core-version'
import { silence } from '@/utils/silence'
import { toast } from '@/utils/toast'

export function ConfigCore() {
  const openDialog = useOverlay(Modal)
  const openDownloadDialog = useOverlay(DownloadCoreDialog)

  const { t } = useTranslation()

  // —— 核心列表数据层 ——
  // 写操作（切换/下载/卸载/更新）落盘后后端会触发 `setting_updated`，这里监听该事件
  // 一并失效重拉，保证「核心被外部 CLI 更新后重开面板即最新」。
  const queryClient = useQueryClient()
  const { data: coreList, isLoading, error: coreError, refetch } = useQuery({
    queryKey: queryKeys.cores,
    queryFn: () => invoke<HarnessCore[]>('get_cores'),
  })
  const { data: coreAsar, isPending: asarLoading } = useQuery({
    queryKey: queryKeys.coreAsar,
    queryFn: () => invoke<boolean>('get_core_asar'),
  })
  useInvalidateOnSettingUpdated(queryKeys.cores)
  useInvalidateOnSettingUpdated(queryKeys.coreAsar)

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.cores })
  }

  const activate = useMutation({
    mutationFn: (id: string) => invoke<HarnessCore>('set_active_core', { id }),
    onSuccess: invalidate,
  })
  const download = useMutation({
    mutationFn: (tag: string) => invoke<HarnessCore>('download_core', { tag }),
    onSuccess: invalidate,
  })
  const uninstall = useMutation({
    mutationFn: (id: string) => invoke<void>('remove_core', { id }),
    onSuccess: invalidate,
  })
  const updateLocal = useMutation({
    mutationFn: () => invoke<string>('update_local_core'),
    onSuccess: invalidate,
  })
  const setCoreAsar = useMutation({
    mutationFn: (enabled: boolean) => invoke<void>('set_core_asar', { enabled }),
    onSuccess: (_data, enabled) => {
      queryClient.setQueryData(queryKeys.coreAsar, enabled)
      invalidate()
    },
    onError: () => {
      // 失败时后端会回滚设置：重拉一次让开关回到真实值
      void queryClient.invalidateQueries({ queryKey: queryKeys.coreAsar })
    },
  })

  const cores = coreList ?? []
  const loading = isLoading
  const error = coreError ? String(coreError) : ''
  /** 操作进行中标记（任一写操作 pending） */
  const busy = activate.isPending || download.isPending || uninstall.isPending || updateLocal.isPending || setCoreAsar.isPending

  /** 行内操作进行中的核心 id（该行的下载/卸载按钮显示 Spinner 并禁用重复点击） */
  const [busyId, setBusyId] = useState<string | null>(null)
  /** 「不兼容版本」分组是否展开：默认折叠，旧版本不参与首选 */
  const [showIncompatible, setShowIncompatible] = useState(false)
  const [refreshing, toggleRefreshing] = useToggle()
  const [advanced, toggleAdvanced] = useToggle()

  // 本地核心未检测到时不渲染 local 行（保留 local_missing_hint 提示）
  // 后端列表在部分缓存/旧版本返回路径中可能仍保持远程顺序，前端统一按版本从高到低排序。
  // 随包内核（离线包）固定置顶并标记「本地」，其后是本地核心与预打包核心。
  const rows = cores
    .filter(core => !(core.source === 'local' && !core.present))
    .sort((a, b) => {
      if (a.bundled !== b.bundled)
        return a.bundled ? -1 : 1
      if (a.source !== b.source)
        return a.source === 'local' ? -1 : 1
      if (a.source === 'local')
        return 0
      // 后端可能从历史 package.json 得到带 src-/dsh-src- 前缀的版本，
      // 排序时使用 tag 作为兜底，避免当前激活版本被排到末尾。
      return -compareVersions(a.version || a.tag, b.version || b.tag)
    })
  const localCore = cores.find(c => c.source === 'local')
  /** 随包内核随安装包分发、无法重下：这类构建不允许切换核心格式 */
  const bundledBuild = cores.some(core => core.bundled)
  const localCoreActive = cores.some(core => core.active && core.source === 'local')
  const currentRows = rows.filter(core => !core.orphaned)
  const orphanRows = rows.filter(core => core.orphaned)
  const orderedRows = [...currentRows, ...orphanRows]
  const incompatibleRows = orderedRows.filter(core => isUnsupportedCore(core))
  const displayRows = [...orderedRows.filter(core => !isUnsupportedCore(core)), ...incompatibleRows]
  /** 「已废弃」分组头锚点：取重排后的首个已废弃行，避免分组头落进折叠区里 */
  const firstOrphanRow = displayRows.find(core => core.orphaned)

  // 本地核心是否有新版可更新：仅当存在更新的预打包发布时才显示「更新本地核心」。
  // 版本行按 releases 最新在前，取第一个**非预览版** app 版本作为"当前最新可用
  // 版本"（预览版不参与更新判定；本地版本已是最新时不再展示更新入口，避免
  // "已最新仍提示更新"）。
  const localVersion = localCore?.version ?? ''
  // 随包内核永远是最新候选的首行，但它是安装包自带的那份，不代表远程已有更新。
  const latestVersion = cores.find(c => c.source === 'app' && !c.bundled && !c.preview)?.version ?? ''
  const hasLocalUpdate = !!(localCore?.present && localVersion && latestVersion && compareVersions(localVersion, latestVersion) < 0)

  /** 包裹行内操作：全局单例守卫 + 该行 busy 标记 */
  async function runBusy(id: string, action: () => Promise<unknown>) {
    if (busy)
      return
    setBusyId(id)
    try {
      await action()
    }
    finally {
      setBusyId(null)
    }
  }

  async function onActivate(core: HarnessCore) {
    if (core.active || busy || !core.present || isUnavailableApp(core))
      return
    if (isUnsupportedLocal(core)) {
      toast(t('core.local_unsupported_toast'), {
        variant: 'warning',
        description: t('core.local_unsupported_hint', { version: MIN_SUPPORTED_CORE_VERSION }),
        timeout: 10_000,
      })
      return
    }
    try {
      await openDialog({
        status: 'warning',
        title: t('core.switch_confirm_title'),
        description: (
          <p>
            {t('core.switch_confirm_desc', { version: displayVersion(core) })}
          </p>
        ),
      })
    }
    catch (e) {
      silence(e, 'core switch: dialog cancelled')
      return
    }
    try {
      // 激活后由 restart 完成时统一失效核心查询；这里不等待联网列表重拉，
      // 避免 setting 已切换但旧服务仍运行期间人为扩大竞态窗口。
      await runBusy(core.id, () => activate.mutateAsync(core.id))
      const key = toast(t('core.activate_toast', { version: displayVersion(core) }), {
        variant: 'accent',
        description: t('core.switch_restart_hint'),
        timeout: 10_000,
      })
      // 需求 5：切换核心后自动重启服务；等待重启完成后再收起提示 toast，
      // 避免切换请求返回后旧 webview 与新核心启动流程并发运行。
      try {
        await store.harness.restart()
        toast.close(key)
      }
      catch (e) {
        silence(e, 'core switch: restart failure already shown by app error state')
      }
    }
    catch (err) {
      console.error('[ConfigCore] switch failed:', err)
      toast(t('core.switch_failed'), {})
    }
  }

  async function onDownload(core: HarnessCore) {
    if (busy)
      return
    // 下载过程在对话框内展示进度 + 日志（复用 install-progress 事件流）；
    // 对话框 confirm（下载成功）或 cancel（失败后点关闭）都会结束本次等待。
    try {
      await openDownloadDialog({
        tag: core.tag,
        version: displayVersion(core),
        runDownload: async (tag) => {
          const downloaded = await download.mutateAsync(tag)
          await refetch()
          return downloaded
        },
      })
      toast(t('core.downloaded_toast', { version: displayVersion(core) }), {})
    }
    catch (err) {
      console.error('[ConfigCore] download failed:', err)
      // 失败详情已在下载对话框内展示（含日志），此处不再重复 toast
    }
  }

  /** 打开核心所在目录（文件夹图标） */
  async function openCoreDir(core: HarnessCore) {
    if (!core.dir || busy)
      return
    try {
      await invoke('open_dir', { path: core.dir })
    }
    catch (err) {
      console.error('[ConfigCore] open dir failed:', err)
      toast(t('core.open_dir_failed'), {})
    }
  }

  async function onRemove(core: HarnessCore) {
    if (busy)
      return
    try {
      await openDialog({
        status: 'danger',
        title: t('core.remove_confirm_title'),
        description: (
          <p>
            {t('core.remove_confirm_desc', { version: displayVersion(core) })}
          </p>
        ),
        confirmText: t('core.uninstall'),
      })
    }
    catch (e) {
      silence(e, 'core switch: dialog cancelled')
      return
    }
    try {
      await runBusy(core.id, async () => {
        await uninstall.mutateAsync(core.id)
        await refetch()
      })
      toast(t('core.uninstalled_toast', { version: displayVersion(core) }), {})
    }
    catch (err) {
      console.error('[ConfigCore] remove failed:', err)
      toast(t('core.remove_failed'), {})
    }
  }

  async function onRefresh() {
    if (busy || refreshing)
      return
    toggleRefreshing(true)
    try {
      await refetch()
      toast(t('core.refreshed_toast'), {})
    }
    catch (err) {
      console.error('[ConfigCore] refresh failed:', err)
      toast(t('core.refresh_failed'), {})
    }
    finally {
      toggleRefreshing(false)
    }
  }

  /** 切换核心格式：成功下载并切换后重启服务。 */
  async function onCoreAsarChange(enabled: boolean) {
    if (busy)
      return
    if (!enabled) {
      try {
        await openDialog({
          status: 'warning',
          title: t('core.asar_confirm_title'),
          description: <p>{t('core.asar_confirm_desc')}</p>,
        })
      }
      catch (e) {
        silence(e, 'core asar: dialog cancelled')
        return
      }
    }
    try {
      await setCoreAsar.mutateAsync(enabled)
      const key = toast(t(enabled ? 'core.asar_enabled_toast' : 'core.asar_disabled_toast'), {
        variant: 'accent',
        description: t('core.switch_restart_hint'),
        timeout: 10_000,
      })
      try {
        await store.harness.restart()
        toast.close(key)
      }
      catch (e) {
        silence(e, 'core asar: restart failure already shown by app error state')
      }
    }
    catch (err) {
      console.error('[ConfigCore] switch core format failed:', err)
      toast(t('core.asar_switch_failed'), { variant: 'danger', description: String(err) })
    }
  }

  function showLocalUpdateWarning() {
    toast(t('core.update_local_requires_app'), {
      variant: 'warning',
      description: t('core.update_local_requires_app_hint'),
      timeout: 10_000,
    })
  }

  async function onUpdateLocal() {
    if (busy)
      return
    if (localCore?.active) {
      showLocalUpdateWarning()
      return
    }
    setBusyId('local')
    try {
      const version = await updateLocal.mutateAsync()
      await refetch()
      toast(t('core.updated_toast', { version: version || '—' }), {
        variant: 'success',
        description: t('core.updated_switch_back_hint'),
        timeout: 10_000,
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === 'CORE_LOCAL_UPDATE_REQUIRES_APP' || message.startsWith('CORE_LOCAL_UPDATE_REQUIRES_APP:')) {
        showLocalUpdateWarning()
        return
      }
      if (message.startsWith('CORE_UPDATE_TARGET_OLDER:')) {
        toast(t('core.update_local_downgrade'), { variant: 'warning', timeout: 10_000 })
        return
      }
      console.error('[ConfigCore] update local core failed:', err)
      toast(t('core.update_failed'), {})
    }
    finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-3">
      <Panel.Header
        title={t('core.title')}
        description={t('core.tooltip')}
        testId="dsh-config-panel-title"
        action={(
          <div className="flex shrink-0 items-center gap-3">
            <Switch
              size="sm"
              isSelected={advanced}
              onChange={() => toggleAdvanced()}
              aria-label={t('core.advanced_options')}
            >
              <Switch.Content className="gap-2">
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <span className="text-xs font-medium text-muted">{t('core.advanced_options')}</span>
              </Switch.Content>
            </Switch>
            <Button
              size="sm"
              variant="tertiary"
              isDisabled={busy || refreshing}
              aria-label={t('core.refresh')}
              onPress={onRefresh}
            >
              <If cond={refreshing} then={<Spinner size="sm" color="current" />} else={<ArrowRotateRight className="size-3.5" />} />
              {t('core.refresh')}
            </Button>
          </div>
        )}
      />

      {/* 加载 / 失败 / 列表 */}
      <Panel.Loadable loading={loading} error={error}>
        <div className="flex flex-col gap-4">
          {/* 高级选项：核心引擎的发行格式。关闭 asar 会重下目录版核心并重启 */}
          <If cond={advanced}>
            <div className="flex flex-col gap-1 px-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-ink">{t('core.asar')}</span>
                <Switch
                  size="sm"
                  isSelected={coreAsar ?? true}
                  isDisabled={asarLoading || busy || bundledBuild || localCoreActive}
                  onChange={enabled => void onCoreAsarChange(enabled)}
                  aria-label={t('core.asar')}
                >
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch.Content>
                </Switch>
              </div>
              <Description className="text-[10px] text-muted/70">{t('core.asar_hint')}</Description>
            </div>
          </If>
          {/* 本地核心提示：未检测到时说明如何安装。放在列表首位，先解释「为什么没有本地行」 */}
          <If cond={!localCore?.present}>
            <Empty>{t('core.local_missing_hint')}</Empty>
          </If>
          {displayRows.map(core => (
            <Fragment key={core.id}>
              {/* 「不兼容版本」分组头：默认折叠，点标题展开/收起 */}
              <If cond={core === incompatibleRows[0]}>
                <button
                  type="button"
                  className="flex items-center gap-1 px-1 pt-2 text-left text-xs font-medium text-muted"
                  aria-expanded={showIncompatible}
                  onClick={() => setShowIncompatible(value => !value)}
                >
                  <ChevronRight className={showIncompatible ? 'size-3.5 rotate-90' : 'size-3.5'} />
                  {t('core.incompatible_title', { count: incompatibleRows.length })}
                </button>
              </If>
              <If cond={core.orphaned && (core === firstOrphanRow)}>
                <div className="px-1 pt-2 text-xs font-medium text-muted">
                  {t('core.orphaned_title')}
                </div>
              </If>
              <Item
                className={!showIncompatible && isUnsupportedCore(core) ? 'hidden' : undefined}
                onClick={core.present && !core.active && !isUnavailableApp(core) ? () => onActivate(core) : undefined}
                footer={(
                  <If cond={core.source === 'app' && !!core.error}>
                    <Description className="text-xs text-danger">
                      {t(core.error === 'CORE_VERSION_LEGACY_DIRECTORY' || core.error?.startsWith('CORE_VERSION_LEGACY_DIRECTORY:') ? 'core.legacy_directory_hint' : 'core.unavailable_hint')}
                    </Description>
                  </If>
                )}
                left={(
                  <>
                    <Label className="min-w-0 truncate font-mono text-sm font-medium text-ink">
                      {displayVersion(core)}
                    </Label>
                    {/* 随包内核（离线包）与用户 CLI 安装的本地核心都标记「本地」 */}
                    <If cond={core.source === 'local' || core.bundled}>
                      <Chip size="sm" variant="soft" color="accent" className="shrink-0 font-medium">
                        {t('core.local')}
                      </Chip>
                    </If>
                    <If cond={core.orphaned}>
                      <Chip size="sm" variant="soft" color="warning" className="shrink-0 font-medium">
                        {t('core.orphaned')}
                      </Chip>
                    </If>
                    {/* 预览版标记：Pre-release label 或 tag 命名判定的预览版，可下载安装但不参与更新提示 */}
                    <If cond={core.preview}>
                      <Chip size="sm" variant="soft" color="warning" className="shrink-0 font-medium">
                        {t('core.preview')}
                      </Chip>
                    </If>
                    <If cond={isUnsupportedLocal(core)}>
                      <Chip size="sm" variant="soft" color="danger" className="shrink-0 font-medium">
                        {t('core.local_unsupported')}
                      </Chip>
                    </If>
                    {/* 已下载：Chip 右侧的文件夹图标，点击打开所在目录 */}
                    <If cond={core.present}>
                      <Button
                        size="sm"
                        variant="tertiary"
                        className="h-6 w-6 shrink-0 p-0"
                        isDisabled={busy}
                        aria-label={t('core.open_dir')}
                        onClick={(event) => {
                          event.stopPropagation()
                          openCoreDir(core)
                        }}
                      >
                        <FolderOpen className="size-3.5" />
                      </Button>
                    </If>
                    <If cond={!core.present}>
                      <Description className="min-w-0 text-xs text-muted">
                        {t('core.not_downloaded')}
                      </Description>
                    </If>
                  </>
                )}
                right={(
                  <>
                    {/* 已下载：切换（选中当前使用版本） */}
                    <If cond={core.present}>
                      <Checkbox
                        isSelected={core.active}
                        isDisabled={busy || isUnavailableApp(core)}
                        onChange={() => onActivate(core)}
                        aria-label={core.version || core.id}
                        className="shrink-0"
                      >
                        <Checkbox.Content>
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                        </Checkbox.Content>
                      </Checkbox>
                    </If>
                    {/* 未下载（app 版本）：下载入口（进度与日志在下载对话框内展示） */}
                    <If cond={!core.present && core.source === 'app'}>
                      <Button
                        size="sm"
                        variant="tertiary"
                        className="h-7 text-xs"
                        isDisabled={busy}
                        onClick={(event) => {
                          event.stopPropagation()
                          onDownload(core)
                        }}
                      >
                        <DownloadIcon className="size-3.5" />
                        {t('core.download')}
                      </Button>
                    </If>
                    {/* 已下载且非激活（app 版本）：卸载入口。随包内核随应用分发，就地安装的副本没有槽位目录，都不可卸载 */}
                    <If cond={core.present && !core.active && core.removable}>
                      <Button
                        size="sm"
                        variant="tertiary"
                        className="h-7 text-xs"
                        isDisabled={busy}
                        onClick={(event) => {
                          event.stopPropagation()
                          onRemove(core)
                        }}
                      >
                        <If cond={busyId === core.id && busy} then={<Spinner size="sm" color="current" />} />
                        {t('core.uninstall')}
                      </Button>
                    </If>
                    {/* 本地核心：已是最新时不显示；有新版时提供更新入口（与预打包行同栏，统一布局） */}
                    <If cond={core.source === 'local' && core.present && hasLocalUpdate}>
                      <Button
                        size="sm"
                        variant="tertiary"
                        className="h-7 text-xs"
                        isDisabled={busy}
                        onClick={(event) => {
                          event.stopPropagation()
                          onUpdateLocal()
                        }}
                      >
                        <If cond={busyId === core.id && busy} then={<Spinner size="sm" color="current" />} else={<ArrowRotateRight className="size-3.5" />} />
                        {t('core.update_local')}
                      </Button>
                    </If>
                  </>
                )}
              />
            </Fragment>
          ))}
        </div>
      </Panel.Loadable>

    </div>
  )
}

/** 版本展示：优先版本号，缺失回落来源 id */
function displayVersion(version: HarnessCore): string {
  return version.version || (version.source === 'local' ? 'local' : 'app')
}

function isUnavailableApp(core: HarnessCore): boolean {
  return core.source === 'app' && (!!core.error || isUnsupportedCore(core))
}

function isUnsupportedLocal(core: HarnessCore): boolean {
  return core.source === 'local' && core.present && isUnsupportedCore(core)
}

function isUnsupportedCore(core: HarnessCore): boolean {
  return isCoreUnsupported(core.version || core.tag)
}
