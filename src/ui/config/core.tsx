import type { HarnessCore } from '@/types'
import { ArrowRotateRight, CircleArrowDown as DownloadIcon, FolderOpen } from '@gravity-ui/icons'
import { Button, Checkbox, Chip, Description, Label, Spinner } from '@heroui/react'
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
import { useCoreBreakingConfirm } from '@/ui/config/hooks/use-core-breaking-confirm'
import { DownloadCoreDialog } from '@/ui/dialog/update-core'
import { compareVersions, isCoreBelowBaseline } from '@/utils/core-version'
import { silence } from '@/utils/silence'
import { toast } from '@/utils/toast'

/**
 * 「核心」面板：管理 Harness 引擎来源与多版本。
 *
 * - 列表来自 `get_cores` 查询（`setting_updated` 事件一并失效刷新）：
 *   `local` = 用户通过 CLI 全局安装的本地核心（存在且不低于内置插件基线时优先使用，
 *   需求 3；低于基线时后端改用预打包核心，行内标注「不兼容」并给出更新提示）；
 *   `app-<tag>` = deepseek-harness-pkg 各发布版本（GitHub releases 拉取失败时
 *   降级为 git tags / 磁盘扫描，仅显示已下载版本）。预览版（Pre-release label
 *   或 tag 命名）照常列出、可下载安装，但带「预览版」标签、不参与更新提示。
 *   离线安装包随包分发的内置核心（`bundled`，版本来自 `resources/bundle.json`）
 *   固定置顶、标注「内置核心」且不提供卸载入口。
 * - 切换核心：持久化后**自动重启**服务（需求 5），重启走 harness store 的
 *   restart 流程（停止 → 重新启动 → 健康检查）。
 * - 下载版本：拉指定 tag 的发布资产到历史槽位（不激活），随后可切换；
 *   卸载仅允许非激活的已下载版本。
 * - 本地核心更新：通过用户包管理器 CLI（npm install -g @latest / pnpm add -g @latest）。
 * - 每行展示核心入口（cli path，超长省略号 + 限制宽度）。
 */

export function ConfigCore() {
  const [dialogHolder, openDialog] = useOverlay(Modal, { type: 'holder' })
  const [downloadDialogHolder, openDownloadDialog] = useOverlay(DownloadCoreDialog, { type: 'holder' })
  const { holder: coreBreakingHolder, confirmCoreBreaking } = useCoreBreakingConfirm()

  const { t } = useTranslation()

  // —— 核心列表数据层 ——
  // 写操作（切换/下载/卸载/更新）落盘后后端会触发 `setting_updated`，这里监听该事件
  // 一并失效重拉，保证「核心被外部 CLI 更新后重开面板即最新」。
  const queryClient = useQueryClient()
  const { data: coreList, isLoading, error: coreError, refetch } = useQuery({
    queryKey: queryKeys.cores,
    queryFn: () => invoke<HarnessCore[]>('get_cores'),
  })
  useInvalidateOnSettingUpdated(queryKeys.cores)

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

  const cores = coreList ?? []
  const loading = isLoading
  const error = coreError ? String(coreError) : ''
  /** 操作进行中标记（任一写操作 pending） */
  const busy = activate.isPending || download.isPending || uninstall.isPending || updateLocal.isPending

  /** 行内操作进行中的核心 id（该行的下载/卸载按钮显示 Spinner 并禁用重复点击） */
  const [busyId, setBusyId] = useState<string | null>(null)
  const [refreshing, toggleRefreshing] = useToggle()

  // 本地核心未检测到时不渲染 local 行（保留 local_missing_hint 提示）
  // 后端列表在部分缓存/旧版本返回路径中可能仍保持远程顺序，前端统一按版本从高到低排序。
  // 离线安装包的内置核心固定在最顶部（`bundled`），随后是本地核心，最后是预打包版本。
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
  // 内置核心即使不在远程发布列表里也保持在主列表（不被归入「已废弃」分区）。
  const currentRows = rows.filter(core => !core.orphaned || core.bundled)
  const orphanRows = rows.filter(core => core.orphaned && !core.bundled)
  const displayRows = [...currentRows, ...orphanRows]

  // 本地核心是否有新版可更新：仅当存在更新的预打包发布时才显示「更新本地核心」。
  // 版本行按 releases 最新在前，取第一个**非预览版** app 版本作为"当前最新可用
  // 版本"（预览版不参与更新判定；本地版本已是最新时不再展示更新入口，避免
  // "已最新仍提示更新"）。
  const localVersion = localCore?.version ?? ''
  const latestVersion = cores.find(c => c.source === 'app' && !c.preview && !c.aboveRecommended)?.version ?? ''
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
    if (core.active || busy || !core.present)
      return
    // 低于内置插件基线的本地核心无法加载随包插件（issue #596）：桌面端此时使用
    // 预打包核心，激活入口改为给出可操作提示，而不是切过去再撞一次启动失败。
    if (isUnsupportedLocal(core)) {
      toast(t('core.local_unsupported_toast'), {
        variant: 'warning',
        description: t('core.local_unsupported_hint', { version: core.recommendedVersion ?? '' }),
        timeout: 10_000,
      })
      return
    }
    try {
      const isRiskyVersion = core.recommendedVersion !== null
        && (core.aboveRecommended || compareVersions(core.version, core.recommendedVersion) > 0)
      await openDialog({
        status: isRiskyVersion ? 'danger' : 'warning',
        title: isRiskyVersion ? t('core.recommended_warning_title') : t('core.switch_confirm_title'),
        description: (
          <p>
            <If
              cond={isRiskyVersion}
              then={t('core.recommended_warning_desc', { version: core.recommendedVersion ?? '' })}
              else={t('core.switch_confirm_desc', { version: displayVersion(core) })}
            />
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
      // 避免切换请求返回后旧 iframe 与新核心启动流程并发运行。
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
    // rc.2 以上版本引入破坏性更改，可能影响第三方插件 → 下载前先弹出确认。
    // 取消则中止，确认后继续；该提示与推荐版本逻辑无关，仅告知用户可随时切回 rc.2。
    if (!(await confirmCoreBreaking(core.version)))
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

  async function onUpdateLocal() {
    if (busy)
      return
    setBusyId('local')
    try {
      const version = await updateLocal.mutateAsync()
      await refetch()
      toast(t('core.updated_toast', { version: version || '—' }), {})
    }
    catch (err) {
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
        action={(
          <Button
            size="sm"
            variant="tertiary"
            className="h-7 shrink-0 rounded-md text-xs"
            isDisabled={busy || refreshing}
            aria-label={t('core.refresh')}
            onPress={onRefresh}
          >
            <If cond={refreshing} then={<Spinner size="sm" color="current" />} else={<ArrowRotateRight className="size-3.5" />} />
            {t('core.refresh')}
          </Button>
        )}
      />

      {/* 加载 / 失败 / 列表 */}
      <Panel.Loadable loading={loading} error={error}>
        <div className="flex flex-col gap-4">
          {displayRows.map(core => (
            <Fragment key={core.id}>
              <If cond={core.orphaned && (core === orphanRows[0])}>
                <div className="px-1 pt-2 text-xs font-medium text-muted">
                  {t('core.orphaned_title')}
                </div>
              </If>
              <Item
                onClick={core.present && !core.active ? () => onActivate(core) : undefined}
                left={(
                  <>
                    <Label className="min-w-0 truncate font-mono text-sm font-medium text-ink">
                      {displayVersion(core)}
                    </Label>
                    <If cond={core.source === 'local'}>
                      <Chip size="sm" variant="soft" color="accent" className="shrink-0 font-medium">
                        {t('core.local')}
                      </Chip>
                    </If>
                    {/* 离线安装包的内置核心：随包分发、固定置顶、不可卸载 */}
                    <If cond={core.bundled}>
                      <Chip size="sm" variant="soft" color="success" className="shrink-0 font-medium">
                        {t('core.bundled')}
                      </Chip>
                    </If>
                    <If cond={core.source === 'app' && !core.bundled}>
                      <Chip size="sm" variant="soft" color="default" className="shrink-0 font-medium">
                        {t('core.app')}
                      </Chip>
                    </If>
                    <If cond={core.orphaned && !core.bundled}>
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
                    {/* 低于内置插件基线的本地核心：桌面端改用预打包核心，激活会被拒绝并给出更新提示 */}
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
                        className="h-6 w-6 shrink-0 rounded-md p-0"
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
                        isDisabled={busy}
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
                        className="h-7 rounded-md text-xs"
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
                    {/* 已下载且非激活（app 版本）：卸载入口。内置核心随包分发、
                        删掉后离线环境将再无可用核心，因此不提供卸载。 */}
                    <If cond={core.present && !core.active && core.source === 'app' && !core.bundled}>
                      <Button
                        size="sm"
                        variant="tertiary"
                        className="h-7 rounded-md text-xs"
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
                        className="h-7 rounded-md text-xs"
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
          {/* 本地核心提示：未检测到时说明如何安装 */}
          <If cond={!localCore?.present}>
            <Empty>{t('core.local_missing_hint')}</Empty>
          </If>
        </div>
      </Panel.Loadable>

      {dialogHolder}
      {downloadDialogHolder}
      {coreBreakingHolder}
    </div>
  )
}

/** 版本展示：优先版本号，缺失回落来源 id */
function displayVersion(version: HarnessCore): string {
  return version.version || (version.source === 'local' ? 'local' : 'app')
}

/**
 * 本地核心是否低于内置插件基线（推荐核心版本）。低于基线时随包内置插件无法加载
 * （见 `isCoreBelowBaseline`），桌面端自动改用预打包核心。
 */
function isUnsupportedLocal(core: HarnessCore): boolean {
  return core.source === 'local' && core.present && isCoreBelowBaseline(core.version, core.recommendedVersion)
}
