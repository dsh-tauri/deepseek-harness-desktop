import type { RuntimeInfo } from '@/types'
import { ArrowRotateRight, ArrowUpRightFromSquare, ChevronRight, Copy, Power } from '@gravity-ui/icons'
import { Button, Chip, Description, Input, Link, ListBox, Select, Spinner, Switch } from '@heroui/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { Info } from '@/components/info'
import { Panel } from '@/components/panel'
import { queryKeys } from '@/config/query-keys'
import { useListen } from '@/hooks/use-listen'
import { store } from '@/store'
import { HARNESS_HEAP_MAX_MB, HARNESS_HEAP_MIN_MB } from '@/store/modules/setting'
import { ConfigCloseAction } from '@/ui/config/components/close-action'
import { ConfigLaunchOnLogin } from '@/ui/config/components/launch-on-login'
import { useCoreBreakingConfirm } from '@/ui/config/hooks/use-core-breaking-confirm'
import { useCoreProfileSwitch } from '@/ui/config/hooks/use-core-profile-switch'
import { toast } from '@/utils/toast'

const ZOOM_OPTIONS = Array.from({ length: 16 }, (_, index) => Number((0.5 + index * 0.1).toFixed(1)))

export interface CliLinkStatus {
  enabled: boolean
  shim_exists: boolean
  path_registered: boolean
  user_dsh_preserved: boolean
  bin_dir: string
  shim_path: string
}

export function ConfigDebug() {
  const { t, i18n } = useTranslation()
  const { serviceRunning, busyAction } = useStore(store.harness)
  const { updateInfo } = useStore(store.harnessUpdater)
  const { holder: coreBreakingHolder, confirmCoreBreaking } = useCoreBreakingConfirm()
  const { holder: coreProfileSwitchHolder, guardCoreUpgrade } = useCoreProfileSwitch()

  // 端口编辑态：用户尚未输入时为 undefined，展示值始终以 store 中已保存的端口为准。
  // 初值不写入 state（避免渲染期副作用），用户一旦输入即以输入值为准。
  const [portInput, setPortInput] = useState<number>()
  const [heapInput, setHeapInput] = useState<string>()

  const { data: info, refetch: refreshInfo } = useQuery({
    queryKey: queryKeys.info,
    queryFn: () => invoke<RuntimeInfo>('get_runtime_info'),
  })

  // 设置变更（如端口避让后服务地址变化）会让运行时信息过期，重拉一次
  useListen('setting_updated', () => {
    void refreshInfo()
  })

  const { port: savedPort, zoom_factor: zoomFactor, harness_max_heap_mb: savedHeapMb } = useStore(store.setting)
  const port = portInput ?? savedPort
  const heapValue = heapInput ?? String(savedHeapMb ?? '')
  /** 空输入代表自动值（null），其余按数字解析，非法值交给保存前的整数校验拦下 */
  const parsedHeap = heapValue.trim() === '' ? null : Number(heapValue)

  const { data: cliStatus, refetch: refreshCliStatus } = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => invoke<CliLinkStatus>('get_cli_link_status'),
  })

  /** 「存在新版本」：直接展示更新提示；破坏性更改确认推迟到点击「立即更新」时 */
  function handleShowNewVersion() {
    store.harnessUpdater.showToast(() => handleUpdate())
  }

  /**
   * 点击「立即更新」：目标版本高于 rc.2 时先弹破坏性更改确认，取消则中止更新；
   * 目标版本是升级时先落到配套版本档案，更新失败再把档案切回去。
   */
  async function handleUpdate() {
    const info = store.harnessUpdater.updateInfo
    if (!info || !(await confirmCoreBreaking(info.tag)))
      return
    const guard = await guardCoreUpgrade(info.tag)
    if (!guard)
      return
    if (!(await store.harnessUpdater.handleUpdate()))
      await guard.rollback?.()
  }

  const { mutate: onToggleCliLink } = useMutation({
    mutationFn: async (enabled: boolean) => {
      // 命令会先建/删 shim 与 PATH 再落盘，前端只改 store 不会产生这些副作用
      await store.setting.update({ cliLinkEnabled: enabled })
      await refreshCliStatus()
    },
    onError: (err: unknown) => {
      console.error('[ConfigDebug] toggle cli link failed:', err)
      toast(t('messages.cli_link_failed'), { variant: 'danger' })
    },
  })

  const { mutate: onSetZoom } = useMutation({
    mutationFn: (zoomFactor: number) => store.setting.update({ zoomFactor }),
    onError: () => toast(t('messages.zoom_save_failed'), { variant: 'danger' }),
  })

  const { mutate: onCopyServiceUrl } = useMutation({
    mutationFn: async () => {
      await invoke('copy_service_url')
      toast(t('messages.copy_success'))
    },
    onError: (err: unknown) => {
      console.error('[ConfigDebug] copy url failed:', err)
      toast(t('messages.copy_failed'), { variant: 'danger' })
    },
  })

  const { mutate: onSavePort } = useMutation({
    mutationFn: async (port: number) => {
      // 保存前校验：必须是 1–65535 的整数（输入框可能被清空成 0 / 浮点 / NaN）
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('PORT_INVALID')
      }
      // 后端会同时记录 manual_port（端口避让后回落到用户选择，issue #91）
      await store.setting.update({ port })
      const key = toast(t('messages.port_changed'), {
        variant: 'accent',
        description: t('messages.port_restart_hint'),
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
    onError: (err: unknown) => {
      console.error('[ConfigDebug] save port failed:', err)
      if (String(err).includes('PORT_INVALID')) {
        toast(t('messages.port_invalid'), { variant: 'danger' })
      }
      else {
        toast(t('messages.port_save_failed'), { variant: 'danger' })
      }
    },
  })

  const { mutate: onSaveHeap } = useMutation({
    mutationFn: async (mb: number | null) => {
      // 空输入 = 交回自动值；Rust 侧把 0 归一化为 None（物理内存一半，见 workflow/heap.rs）
      if (mb !== null && (!Number.isInteger(mb) || mb < HARNESS_HEAP_MIN_MB || mb > HARNESS_HEAP_MAX_MB)) {
        throw new Error('HEAP_INVALID')
      }
      await store.setting.update({ harnessMaxHeapMb: mb ?? 0 })
      const key = toast(t('messages.heap_changed'), {
        variant: 'accent',
        description: t('messages.heap_restart_hint'),
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
    onError: (err: unknown) => {
      console.error('[ConfigDebug] save heap limit failed:', err)
      if (String(err).includes('HEAP_INVALID')) {
        toast(t('messages.heap_invalid'), { variant: 'danger' })
      }
      else {
        toast(t('messages.heap_save_failed'), { variant: 'danger' })
      }
    },
  })

  return (
    <div className="space-y-3">
      <Panel.Header title={t('config.application')} testId="dsh-config-panel-title" />
      {coreBreakingHolder}
      {coreProfileSwitchHolder}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">
            {t('ui.connection_status')}
          </span>
          <Chip
            size="sm"
            variant="soft"
            color={serviceRunning ? 'success' : 'danger'}
            className="font-medium"
          >
            {serviceRunning ? t('ui.running') : t('ui.stopped')}
          </Chip>
        </div>
        <div className="space-y-1.5">
          <div className="flex gap-1.5">
            <Input
              readOnly
              variant="secondary"
              value={info?.service_url ?? '-'}
              aria-label={t('ui.service_url')}
              className="font-mono text-xs flex-1"
            />
            <Button
              size="sm"
              variant="ghost"
              isIconOnly
              onPress={() => onCopyServiceUrl()}
              aria-label={t('buttons.copy')}
            >
              <Copy className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              isIconOnly
              onPress={store.harness.openBrowser}
              isDisabled={busyAction !== null}
              aria-label={t('app.open_browser')}
            >
              <If cond={busyAction === 'openBrowser'} then={<Spinner size="sm" color="current" />} else={<ArrowUpRightFromSquare className="size-3.5" />} />
            </Button>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <If cond={serviceRunning}>
          <Button
            size="sm"
            variant="tertiary"
            className="flex-1"
            onPress={store.harness.restart}
            isDisabled={busyAction !== null}
          >
            <If cond={busyAction === 'restart'} then={<Spinner size="sm" color="current" />} else={<ArrowRotateRight className="size-3.5" />} />
            {t('app.restart')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            className="flex-1"
            onPress={store.harness.shutdown}
            isDisabled={busyAction !== null}
          >
            <If cond={busyAction === 'shutdown'} then={<Spinner size="sm" color="current" />} else={<Power className="size-3.5" />} />
            {t('app.shutdown')}
          </Button>
        </If>
      </div>
      <div className="border-t border-line/30" />
      <div>
        <div className="space-y-1">
          <Info term={t('ui.current_version')}>{info?.app_version ?? '-'}</Info>
          <Info term={t('ui.dsh_version')}>
            <span>{info?.dsh_version ?? '-'}</span>
            <If cond={updateInfo}>
              <Link className="ml-2 text-[10px] text-info" onClick={handleShowNewVersion}>
                {t('menu.new_version')}
                <ChevronRight className="scale-75" />
              </Link>
            </If>

          </Info>
          <Info term={t('ui.node_version')}>{info?.node_version ? `v${info.node_version}` : '-'}</Info>
          <Info term={t('ui.platform')}>
            {info ? `${info.platform} / ${info.arch}` : '-'}
          </Info>
        </div>
      </div>
      <div className="border-t border-line/30" />
      <div className="space-y-1.5">
        <ConfigLaunchOnLogin />
        <ConfigCloseAction />
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink">{t('ui.cli_link_enabled')}</span>
            <Switch
              isSelected={cliStatus?.enabled ?? false}
              onChange={onToggleCliLink}
              aria-label={t('ui.cli_link_enabled')}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </div>
          <If cond={cliStatus != null}>
            <div className="flex flex-col">
              <If
                cond={!cliStatus?.user_dsh_preserved}
                else={(
                  <Description className="text-[10px] text-muted/70">
                    {t('ui.cli_link_user_dsh_preserved')}
                  </Description>
                )}
              >
                <Description className="text-[10px] text-muted/70">{cliStatus?.bin_dir}</Description>
                <Description className="text-[10px] text-muted/70">
                  {t('ui.cli_link_hint')}
                </Description>
              </If>
            </div>
          </If>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-ink">{t('ui.port')}</span>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              variant="secondary"
              value={String(port)}
              onChange={e => setPortInput(Number(e.target.value))}
              className="w-24 h-8 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              aria-label={t('ui.port')}
            />
            <Button
              size="sm"
              variant="primary"
              className="h-8"
              onPress={() => onSavePort(port)}
            >
              {t('buttons.save')}
            </Button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-ink">{t('ui.heap_limit')}</span>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              variant="secondary"
              value={heapValue}
              placeholder={t('ui.heap_limit_auto')}
              onChange={e => setHeapInput(e.target.value)}
              className="w-24 h-8 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              aria-label={t('ui.heap_limit')}
            />
            <Button
              size="sm"
              variant="primary"
              className="h-8"
              onPress={() => onSaveHeap(parsedHeap)}
            >
              {t('buttons.save')}
            </Button>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-ink">{t('ui.language')}</span>
          <Select
            variant="secondary"
            selectedKey={i18n.language}
            onSelectionChange={key => i18n.changeLanguage(String(key))}
            className="w-[80px]"
            aria-label={t('ui.language')}
          >
            <Select.Trigger data-testid="dsh-config-language-select" className="min-h-8! h-8 py-0 items-center">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item data-testid="dsh-config-language-option-zh" className="min-h-8!" id="zh-CN" textValue={t('ui.languages.zh')}>{t('ui.languages.zh')}</ListBox.Item>
                <ListBox.Item data-testid="dsh-config-language-option-en" className="min-h-8!" id="en-US" textValue={t('ui.languages.en')}>{t('ui.languages.en')}</ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-ink">{t('ui.zoom')}</span>
          <Select
            variant="secondary"
            selectedKey={String(zoomFactor)}
            onSelectionChange={key => onSetZoom(Number(key))}
            className="w-[80px]"
            aria-label={t('ui.zoom')}
          >
            <Select.Trigger className="min-h-8! h-8 py-0 items-center">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {ZOOM_OPTIONS.map(zoomFactor => (
                  <ListBox.Item
                    className="min-h-8!"
                    id={String(zoomFactor)}
                    key={zoomFactor}
                    textValue={`${Math.round(zoomFactor * 100)}%`}
                  >
                    {`${Math.round(zoomFactor * 100)}%`}
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
      </div>

    </div>
  )
}
