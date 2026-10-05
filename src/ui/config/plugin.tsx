import type { Plugin, PluginProcess, PluginSearchProblem, PluginSearchResult } from '@/store/modules/plugins'
import { ChevronRight, CircleExclamation, FolderOpen } from '@gravity-ui/icons'
import { Button, Chip, Description, Input, Label, Spinner, Switch, Tooltip } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { useToggle } from '@reause/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { tv } from 'tailwind-variants'
import { Ellipsis as TextEllipsis } from '@/components/ellipsis'
import { Empty } from '@/components/empty'
import { Item } from '@/components/item'
import { Modal } from '@/components/modal'
import { Panel } from '@/components/panel'
import { queryKeys } from '@/config/query-keys'
import { useDshPluginsManager } from '@/hooks/use-plugins-manager'
import { store } from '@/store'
import { silence } from '@/utils/silence'
import { toast } from '@/utils/toast'

/** 操作 chip 的样式变体：busy 时禁止点击并降低透明度，否则可点击。 */
const actionChip = tv({
  variants: {
    busy: {
      true: 'cursor-not-allowed opacity-50',
      false: 'cursor-pointer',
    },
  },
  defaultVariants: {
    busy: false,
  },
})

/** 队列里的进程类型 → 面板行内动作名（队列叫 upgrade/uninstall，按钮叫 update/remove） */
const QUEUED_ACTIONS: Record<PluginProcess['type'], string> = {
  install: 'install',
  upgrade: 'update',
  uninstall: 'remove',
  disable: 'disable',
  enable: 'enable',
}

/** 兼容性检查的问题码 → i18n key：管理器把宿主返回的 problem 原样透传给调用方 */
const searchProblemKeys: Record<PluginSearchProblem, string> = {
  'invalid-spec': 'plugins.search_invalid_spec',
  'local-missing': 'plugins.search_local_missing',
  'not-found': 'plugins.search_not_found',
  'network': 'plugins.search_network',
  'unsupported': 'plugins.search_unsupported',
  'unknown': 'plugins.search_unknown',
}

/** 宿主 `get_local_plugin_hmr` 的返回：开关值、补丁层路径与当前真正被监听的源码目录。 */
interface LocalHmrStatus {
  enabled: boolean
  watching: boolean
  patchPath: string | null
  roots: string[]
}

/**
 * 「插件」面板：已安装插件的安装/升级/卸载/禁用/启用全部经 `useDshPluginsManager` 收口
 * （队列、授权、Toast、组结算重启由管理器统一负责），面板只保留确认对话框与行内 busy。
 *
 * 快照（创建/还原/删除）不在管理器范围内
 * 仍由面板直接调用宿主命令；这些操作同样会改写插件状态，因此成功后失效插件列表查询。
 */
export function ConfigPlugin() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const manager = useDshPluginsManager()

  const plugins = manager.installed
  const internalPlugins = plugins.filter(plugin => plugin.internal)
  const managedPlugins = plugins.filter(plugin => !plugin.internal)

  const [showInternal, toggleShowInternal] = useToggle()
  /** 高级选项：默认关闭，快照（创建/还原/删除）属于低频维护操作，不常驻每行 */
  const [advanced, toggleAdvanced] = useToggle()
  /** 行内动作标记 `<id>:<action>`：按行独立，某行的动作不阻塞其他行继续入队 */
  const [busy, setBusy] = useState<string[]>([])
  /** 安装输入的原始文本：支持逗号/空白分隔的多个 spec */
  const [installRef, setInstallRef] = useState('')
  const [installing, setInstalling] = useState(false)
  /** 兼容性预检结果：安装前先经 manager.search 展示解析到的版本与兼容性 */
  const [searchResults, setSearchResults] = useState<PluginSearchResult[] | null>(null)

  const [dialogHolder, openDialog] = useOverlay(Modal, { type: 'holder' })

  const snapshot = useMutation({
    mutationFn: (id: string) => invoke<void>('snapshot_plugin', { id }),
    onSuccess: (_data, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins })
      toast(t('plugins.snapshot_toast', { name }), {})
    },
    onError: (err, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
      console.error('[ConfigPlugin] snapshot failed:', err)
      toast(t('plugins.snapshot_failed', { name }), {})
    },
  })
  const restore = useMutation({
    mutationFn: (id: string) => invoke<void>('restore_plugin', { id }),
    onSuccess: (_data, _id) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins })
    },
    onError: (err, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
      console.error('[ConfigPlugin] restore failed:', err)
      toast(t('plugins.restore_failed', { name }), {})
    },
  })
  const deleteSnapshot = useMutation({
    mutationFn: (id: string) => invoke<void>('delete_plugin_backup', { id }),
    onSuccess: (_data, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins })
      toast(t('plugins.snapshot_deleted_toast', { name }), {})
    },
    onError: (err, id) => {
      const name = plugins.find(p => p.id === id)?.name ?? id
      console.error('[ConfigPlugin] delete snapshot failed:', err)
      toast(t('plugins.snapshot_delete_failed', { name }), {})
    },
  })

  /** 热重载状态只读展示：补丁层与被监听的源码目录都由后端按已挂载的本地插件算出来。 */
  const hmr = useQuery({
    queryKey: queryKeys.localPluginHmr,
    queryFn: () => invoke<LocalHmrStatus>('get_local_plugin_hmr'),
  })
  const setHmr = useMutation({
    mutationFn: (nextEnabled: boolean) => invoke<LocalHmrStatus>('set_local_plugin_hmr', { enabled: nextEnabled }),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.localPluginHmr, status)
      const key = toast(t('plugins.hmr_restart_hint'), {
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
    },
    onError: (error: unknown) => {
      console.error('[ConfigPlugin] local plugin hot reload update failed:', error)
      toast(t('plugins.hmr_save_failed'), { variant: 'danger' })
    },
  })

  /**
   * 目录选择器只把选中的目录回填进安装框（`link:` spec），安装仍走与手打完全相同的链路：
   * 用户可以先核对路径再点安装，也能就地改掉。
   */
  async function onPickLocalDir() {
    if (installing)
      return
    setInstalling(true)
    try {
      const spec = await invoke<string | null>('pick_local_plugin_dir')
      if (spec == null)
        return
      setInstallRef(spec)
      setSearchResults(null)
    }
    catch (e) {
      console.error('[ConfigPlugin] pick local plugin dir failed:', e)
      toast(t('plugins.local_dir_failed'), { variant: 'danger' })
    }
    finally {
      setInstalling(false)
    }
  }

  /** 该插件在管理器队列里的进程类型（不在队列里为 null）。 */
  function queuedType(id: string): PluginProcess['type'] | null {
    return manager.processes.find(process => process.name === id)?.type ?? null
  }

  /**
   * 管理器动作只等待组结算：授权等待期间的横幅与结果 Toast 都由管理器弹出，
   * 面板仅负责行内 busy 与「同一行不重复派发」。不同行的动作互不禁用，
   * 后续点击会作为新组进入管理器队列。
   *
   * 队列里已有该插件的同义动作时也算忙（升级 = 更新、卸载 = 移除）：Spinner 跟着队列走，
   * 不必等宿主返回；整行禁点由 [`rowBusy`](self) 负责。
   */
  function busyWith(id: string, action: string): boolean {
    if (busy.includes(`${id}:${action}`))
      return true
    const queued = queuedType(id)
    return queued !== null && QUEUED_ACTIONS[queued] === action
  }

  /** 队列里已有该插件的进程时整行禁点：再点只会把它作为新组塞进同一个队列。 */
  function rowBusy(id: string): boolean {
    return queuedType(id) !== null || busy.some(item => item.startsWith(`${id}:`))
  }

  function markBusy(id: string, action: string): void {
    setBusy(current => [...current, `${id}:${action}`])
  }

  function clearBusy(id: string, action: string): void {
    setBusy(current => current.filter(item => item !== `${id}:${action}`))
  }

  async function runAction(id: string, action: 'update' | 'remove' | 'disable' | 'enable', run: () => Promise<unknown>) {
    if (rowBusy(id))
      return
    markBusy(id, action)
    try {
      await run()
    }
    catch (e) {
      silence(e, 'plugin action: error already reported by the manager')
    }
    finally {
      clearBusy(id, action)
    }
  }

  async function onUpgrade(id: string, latest: string | null) {
    // 面板此刻显示着目标版本，把它一起交给管理器：宿主据此核验「装的到底是不是这个版本」，
    // 并在来源被钉死时用显式安装兜底（见 `update_dsh_plugins`）。
    const ref = latest === null ? id : { spec: id, version: latest }
    await runAction(id, 'update', () => manager.upgrade(ref))
  }

  async function onRemove(id: string, name: string) {
    if (rowBusy(id))
      return
    try {
      await openDialog({
        status: 'danger',
        title: t('plugins.remove_confirm_title'),
        description: (
          <p>
            {t('plugins.remove_confirm_desc', { name })}
          </p>
        ),
        confirmText: t('plugins.uninstall'),
      })
    }
    catch (e) {
      silence(e, 'plugin remove: dialog cancelled')
      return
    }
    await runAction(id, 'remove', () => manager.uninstall(id))
  }

  /**
   * 新增安装入口：先 `manager.search` 预检兼容性（只读，不改 Profile），
   * 命中明确不兼容的 spec 时中止并提示，其余交给 `manager.install` 走统一队列。
   */
  async function onInstall() {
    const refs = installRef.trim().split(/[\s,]+/).filter(Boolean)
    if (refs.length === 0 || installing)
      return
    setInstalling(true)
    try {
      const results = await manager.search(refs)
      setSearchResults(results)
      const incompatibles = results.filter(item => item.compatible === false)
      if (incompatibles.length > 0) {
        const names = incompatibles.map(item => item.name ?? item.spec).join(', ')
        toast(t('plugins.search_incompatible', { names }), { variant: 'danger' })
        return
      }
      setInstallRef('')
      await manager.install(refs)
    }
    catch (e) {
      silence(e, 'plugin install: error already reported by the manager')
    }
    finally {
      setInstalling(false)
    }
  }

  async function onDisable(id: string) {
    if (rowBusy(id))
      return
    const plugin = plugins.find(p => p.id === id)
    if (plugin?.internal) {
      try {
        await openDialog({
          status: 'warning',
          title: t('plugins.disable_builtin_confirm_title'),
          description: <p>{t('plugins.disable_builtin_confirm_desc', { name: plugin.name })}</p>,
          confirmText: t('plugins.disable'),
        })
      }
      catch (e) {
        silence(e, 'plugin disable: dialog cancelled')
        return
      }
    }
    await runAction(id, 'disable', () => manager.disable(id))
  }

  async function onEnable(id: string, clearConfigOverride = false) {
    if (rowBusy(id))
      return
    if (clearConfigOverride) {
      const name = plugins.find(p => p.id === id)?.name ?? id
      try {
        await openDialog({
          status: 'warning',
          title: t('plugins.enable_override_confirm_title'),
          description: (
            <p>
              {t('plugins.enable_override_confirm_desc', { name })}
            </p>
          ),
          confirmText: t('plugins.enable_override_confirm'),
        })
      }
      catch (e) {
        silence(e, 'plugin enable: config override dialog cancelled')
        return
      }
    }
    await runAction(id, 'enable', () => manager.enable(id, { clearConfigOverride }))
  }

  async function onSnapshot(id: string, name: string, hasSnapshot: boolean) {
    if (rowBusy(id))
      return
    if (hasSnapshot) {
      try {
        await openDialog({
          status: 'warning',
          title: t('plugins.snapshot_overwrite_title'),
          description: (
            <p>
              {t('plugins.snapshot_overwrite_desc', { name })}
            </p>
          ),
          confirmText: t('plugins.snapshot_overwrite_confirm'),
        })
      }
      catch (e) {
        silence(e, 'plugin snapshot: dialog cancelled')
        return
      }
    }
    markBusy(id, 'snapshot')
    try {
      await snapshot.mutateAsync(id)
    }
    catch (e) {
      silence(e, 'plugin snapshot: error already shown by mutation onError')
    }
    finally {
      clearBusy(id, 'snapshot')
    }
  }

  async function onRestore(id: string, name: string) {
    if (rowBusy(id))
      return
    try {
      await openDialog({
        status: 'warning',
        title: t('plugins.restore_confirm_title'),
        description: (
          <p>
            {t('plugins.restore_confirm_desc', { name })}
          </p>
        ),
        confirmText: t('plugins.restore'),
      })
    }
    catch (e) {
      silence(e, 'plugin restore: dialog cancelled')
      return
    }
    markBusy(id, 'restore')
    try {
      await restore.mutateAsync(id)
      // 还原期间后端已停止服务：复用 ui/config/backup 的「重启服务」toast 交互
      const key = toast(t('plugins.restore_restart_hint', { name }), {
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
    catch (e) {
      silence(e, 'plugin restore: error already shown by mutation onError')
    }
    finally {
      clearBusy(id, 'restore')
    }
  }

  async function onDeleteSnapshot(id: string, name: string) {
    if (rowBusy(id))
      return
    try {
      await openDialog({
        status: 'danger',
        title: t('plugins.snapshot_delete_title'),
        description: (
          <p>
            {t('plugins.snapshot_delete_desc', { name })}
          </p>
        ),
        confirmText: t('plugins.snapshot_delete_confirm'),
      })
    }
    catch (e) {
      silence(e, 'plugin delete-snapshot: dialog cancelled')
      return
    }
    markBusy(id, 'delete-snapshot')
    try {
      await deleteSnapshot.mutateAsync(id)
    }
    catch (e) {
      silence(e, 'plugin delete-snapshot: error already shown by mutation onError')
    }
    finally {
      clearBusy(id, 'delete-snapshot')
    }
  }

  /** 插件行：可管理插件列表与「内置插件」折叠分组共用同一行结构 */
  function renderPluginRow(plugin: Plugin) {
    return (
      <Item
        key={plugin.id}
        left={(
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1">
              <If cond={plugin.error != null}>
                <Tooltip delay={0}>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    className="size-6 shrink-0 text-danger"
                    aria-label={t('plugins.abnormal_tooltip')}
                  >
                    <CircleExclamation />
                  </Button>
                  <Tooltip.Content className="max-w-[320px]">
                    <div className="space-y-1">
                      <p className="text-xs font-medium">
                        {t('plugins.abnormal_desc', { name: plugin.name })}
                      </p>
                      <p className="whitespace-pre-wrap break-all font-mono text-[11px] opacity-80">
                        {plugin.error?.message}
                      </p>
                    </div>
                  </Tooltip.Content>
                </Tooltip>
              </If>
              <Label className="min-w-0 truncate text-sm font-medium text-ink">
                {plugin.name}
              </Label>
              <If cond={plugin.version !== ''}>
                <code className="shrink-0 rounded bg-default px-1.5 py-0.5 font-mono text-[10px] text-muted">
                  {plugin.version}
                </code>
              </If>
              <If cond={!plugin.internal && plugin.recommended}>
                <Chip size="sm" variant="soft" color="success" className="shrink-0 font-medium">
                  {t('plugins.preset')}
                </Chip>
              </If>
              <If cond={plugin.disabled}>
                <Chip size="sm" variant="soft" color="default">
                  {t('plugins.disabled_badge')}
                </Chip>
              </If>
              {/* 配置覆盖禁用：展示在 cordis.patch.yml 中被显式禁用的真实状态
                  （内置插件同样标注，issue #399：Scheduler/Pet 行此前只有「内置」） */}
              <If cond={plugin.patchDisabled}>
                <Chip size="sm" variant="soft" color="warning">
                  {t('plugins.patch_disabled_badge')}
                </Chip>
              </If>
              <If cond={plugin.internal}>
                <code className="shrink-0 rounded bg-default px-1.5 py-0.5 font-mono text-[10px] text-muted">
                  {t('plugins.builtin')}
                </code>
              </If>
            </div>
            <If cond={plugin.description !== ''}>
              <TextEllipsis lineClamp={2} className="text-xs text-muted">
                {plugin.description}
              </TextEllipsis>
            </If>
          </div>
        )}
        right={(
          <>
            {/* 升级入口仅在确有更新（updateAvailable）或插件异常（error，修复入口）时显示 */}
            <If cond={plugin.updateAvailable || plugin.error != null}>
              <Chip
                className={actionChip({ busy: rowBusy(plugin.id) })}
                variant="primary"
                color="accent"
                size="sm"
                onClick={() => onUpgrade(plugin.id, plugin.latest)}
              >
                <span className="flex items-center gap-1">
                  <If cond={busyWith(plugin.id, 'update')} then={<Spinner size="sm" color="current" />} />
                  {t('plugins.upgrade')}
                  <If cond={plugin.latest != null && plugin.error == null}>
                    <span className="font-mono text-[10px] opacity-80 max-w-[80px] truncate">
                      {plugin.latest && plugin.latest.length >= 40 ? `${plugin.latest.slice(0, 8)}…` : plugin.latest}
                    </span>
                  </If>
                </span>
              </Chip>
            </If>
            <If cond={plugin.patchDisabled || plugin.disabled}>
              <Chip
                className={actionChip({ busy: rowBusy(plugin.id) })}
                variant="primary"
                color="accent"
                size="sm"
                onClick={() => onEnable(plugin.id, plugin.patchDisabled)}
              >
                <span className="flex items-center gap-1">
                  <If cond={busyWith(plugin.id, 'enable')} then={<Spinner size="sm" color="current" />} />
                  {t('plugins.enable')}
                </span>
              </Chip>
            </If>
            <If cond={!plugin.patchDisabled && !plugin.disabled}>
              <Chip
                className={actionChip({ busy: rowBusy(plugin.id) })}
                size="sm"
                onClick={() => onDisable(plugin.id)}
              >
                <span className="flex items-center gap-1">
                  <If cond={busyWith(plugin.id, 'disable')} then={<Spinner size="sm" color="current" />} />
                  {t('plugins.disable')}
                </span>
              </Chip>
            </If>
            <If cond={!plugin.internal}>
              <If cond={advanced}>
                {/* 单插件快照：快照始终可用（已存在时覆盖确认）；还原/删除快照仅在
                    存在快照时显示。还原会停服务，还原后 toast 提示重启（issue #303） */}
                <Chip
                  className={actionChip({ busy: rowBusy(plugin.id) })}
                  variant="primary"
                  color="accent"
                  size="sm"
                  onClick={() => onSnapshot(plugin.id, plugin.name, plugin.hasSnapshot)}
                >
                  <span className="flex items-center gap-1">
                    <If cond={busyWith(plugin.id, 'snapshot')} then={<Spinner size="sm" color="current" />} />
                    {t('plugins.snapshot')}
                  </span>
                </Chip>
                <If cond={plugin.hasSnapshot}>
                  <Chip
                    className={actionChip({ busy: rowBusy(plugin.id) })}
                    variant="primary"
                    color="accent"
                    size="sm"
                    onClick={() => onRestore(plugin.id, plugin.name)}
                  >
                    <span className="flex items-center gap-1">
                      <If cond={busyWith(plugin.id, 'restore')} then={<Spinner size="sm" color="current" />} />
                      {t('plugins.restore')}
                    </span>
                  </Chip>
                  <Chip
                    className={actionChip({ busy: rowBusy(plugin.id) })}
                    size="sm"
                    onClick={() => onDeleteSnapshot(plugin.id, plugin.name)}
                  >
                    <span className="flex items-center gap-1">
                      <If cond={busyWith(plugin.id, 'delete-snapshot')} then={<Spinner size="sm" color="current" />} />
                      {t('plugins.delete_snapshot')}
                    </span>
                  </Chip>
                </If>
              </If>
              <Chip
                className={actionChip({ busy: rowBusy(plugin.id) })}
                variant="primary"
                color="danger"
                size="sm"
                onClick={() => onRemove(plugin.id, plugin.name)}
              >
                <span className="flex items-center gap-1">
                  <If cond={busyWith(plugin.id, 'remove')} then={<Spinner size="sm" color="current" />} />
                  {t('plugins.uninstall')}
                </span>
              </Chip>
            </If>
          </>
        )}
      />
    )
  }

  return (
    <div>
      <Panel.Header
        className="pb-3"
        title={t('plugins.title')}
        testId="dsh-config-panel-title"
        action={(
          <div className="flex shrink-0 items-center gap-3">
            <Switch
              size="sm"
              isSelected={advanced}
              onChange={() => toggleAdvanced()}
              aria-label={t('plugins.advanced_options')}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
            <span className="text-xs font-medium text-muted">{t('plugins.advanced_options')}</span>
            <Tooltip delay={0}>
              <Button
                size="sm"
                variant="primary"
                onPress={store.preinstall.open}
                isDisabled={store.preinstall.installing}
              >
                {t('preinstall.open_preset')}
              </Button>
              <Tooltip.Content>
                <p>{t('preinstall.settings_hint')}</p>
              </Tooltip.Content>
            </Tooltip>
          </div>
        )}
        description={t('plugins.panel_tooltip')}
      />

      <Panel.Loadable loading={manager.loading} error={manager.error}>
        <div className="flex flex-col gap-4">
          {/* 安装入口：接受 npm spec（可逗号/空白分隔多个），先经管理器只读预检再入队 */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Input
                variant="secondary"
                className="h-8 flex-1 font-mono text-xs"
                placeholder={t('plugins.install_placeholder')}
                aria-label={t('plugins.install_placeholder')}
                value={installRef}
                onChange={e => setInstallRef(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter')
                    void onInstall()
                }}
              />
              <Button
                size="sm"
                variant="tertiary"
                className="h-8 shrink-0"
                isDisabled={installRef.trim() === ''}
                onPress={() => void onInstall()}
              >
                <span className="flex items-center gap-1">
                  <If cond={installing} then={<Spinner size="sm" color="current" />} />
                  {t('plugins.install')}
                </span>
              </Button>
              <Tooltip delay={0}>
                <Button
                  isIconOnly
                  size="sm"
                  variant="tertiary"
                  className="size-8 shrink-0"
                  isDisabled={installing}
                  aria-label={t('plugins.local_dir')}
                  onPress={() => void onPickLocalDir()}
                >
                  <FolderOpen />
                </Button>
                <Tooltip.Content className="max-w-[320px]">
                  <p>{t('plugins.local_dir')}</p>
                </Tooltip.Content>
              </Tooltip>
            </div>
            <If cond={searchResults != null}>
              <div className="flex flex-col gap-1 px-1">
                {(searchResults ?? []).map(result => (
                  <div key={result.spec} className="flex items-center gap-2 text-[11px] text-muted">
                    <span className="min-w-0 truncate font-mono">{result.spec}</span>
                    <If cond={result.version != null}>
                      <code className="shrink-0 rounded bg-default px-1.5 py-0.5 font-mono text-[10px]">
                        {result.version}
                      </code>
                    </If>
                    <If cond={result.compatible === false}>
                      <Chip size="sm" variant="soft" color="danger" className="shrink-0">
                        {t('plugins.search_incompatible_badge')}
                      </Chip>
                    </If>
                    <If cond={result.problem != null}>
                      <span className="shrink-0 text-danger">
                        {t(searchProblemKeys[result.problem ?? 'unknown'])}
                      </span>
                    </If>
                  </div>
                ))}
              </div>
            </If>
          </div>

          <div className="flex flex-col gap-1 px-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-ink">{t('plugins.hmr')}</span>
              <Switch
                size="sm"
                isSelected={hmr.data?.enabled ?? false}
                isDisabled={hmr.isFetching || setHmr.isPending}
                onChange={enabled => setHmr.mutate(enabled)}
                aria-label={t('plugins.hmr')}
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </Switch>
            </div>
            <Description className="text-[10px] text-muted/70">{t('plugins.hmr_hint')}</Description>
            <If cond={hmr.data != null && !hmr.data.watching}>
              <Description className="text-[10px] text-warning">{t('plugins.hmr_idle')}</Description>
            </If>
          </div>

          <If cond={managedPlugins.length > 0} else={<Empty>{t('plugins.empty')}</Empty>}>
            {managedPlugins.map(plugin => renderPluginRow(plugin))}
          </If>
          <If cond={internalPlugins.length > 0}>
            {/* 「内置插件」分组头：默认折叠，点标题展开/收起。内置插件由启动自愈维护，
                与可升级/可卸载的插件并列只会让用户误当作普通插件 */}
            <button
              type="button"
              className="flex items-center gap-1 px-1 pt-2 text-left text-xs font-medium text-muted"
              aria-expanded={showInternal}
              onClick={() => toggleShowInternal()}
            >
              <ChevronRight className={showInternal ? 'size-3.5 rotate-90' : 'size-3.5'} />
              {t('plugins.builtin_title', { count: internalPlugins.length })}
            </button>
            <If cond={showInternal}>
              {internalPlugins.map(plugin => renderPluginRow(plugin))}
            </If>
          </If>
        </div>
      </Panel.Loadable>

      {dialogHolder}
    </div>
  )
}
