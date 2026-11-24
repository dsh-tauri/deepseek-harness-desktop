import type { RemoteCoreTarget } from './remote-core.rows'
import { ArrowsRotateRight, ArrowUpRightFromSquare, Copy, Power } from '@gravity-ui/icons'
import { Button, Chip, Description, Input } from '@heroui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { getCoreCurrent, postMachinesDisconnect } from '@/apis/remote'
import { Info } from '@/components/info'
import { Panel } from '@/components/panel'
import { queryKeys } from '@/config/query-keys'
import { loadRemoteMachines } from '@/hooks/use-remote'
import { writeClipboardText } from '@/utils/clipboard'
import { toast } from '@/utils/toast'
import { ApplicationPreferences } from './application-preferences'

/** 远端连接状态 → Chip 颜色 */
const STATE_COLOR: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  'connected': 'success',
  'connecting': 'warning',
  'reconnecting': 'warning',
  'testing': 'warning',
  'given-up': 'danger',
  'disconnected': 'default',
}

/**
 * 远端窗口的「应用」面板。
 *
 * 这个窗口的文档本身就是经隧道加载的那台远端实例，所以这里描述的是远端机器上的
 * 实例：地址取该机器的隧道入口，版本取远端核心的当前槽位。本机核心的生命周期
 * （端口、内存上限、代理、CLI 链接、重启/停止）不在这里出现——远端窗口里按下去
 * 只会动到发起端，正是 issue #1630 报的那个问题。
 */
export function RemoteApplication({ machineId }: { machineId: string }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  // 1. 数据查询 (Queries)
  const machinesQuery = useQuery({ queryKey: queryKeys.remoteMachines, queryFn: loadRemoteMachines })
  const targetQuery = useQuery({
    queryKey: queryKeys.remoteCoreTarget(machineId),
    queryFn: async (): Promise<RemoteCoreTarget> => {
      const response = await getCoreCurrent({ machineId })
      if (response.item === undefined)
        throw new Error(response.error ?? t('core.remote_unavailable'))
      return response.item
    },
  })

  // 4. 派生数据提取
  const machine = machinesQuery.data?.machines.find(item => item.id === machineId)
  const target = targetQuery.data
  const address = machine?.tunnelBaseUrl ?? ''
  const state = machine?.state ?? 'disconnected'
  const activeSlot = target?.availability === 'present'
    ? target.slots.find(slot => slot.kind === 'installed' && slot.active)
    : undefined
  const version = activeSlot?.kind === 'installed' ? activeSlot.version : undefined

  // 5. 使用 useMutation 封装动作流程
  const copyAddress = useMutation({
    mutationFn: () => writeClipboardText(address, t('messages.copy_success')),
    onError: (err: unknown) => {
      console.error('[RemoteApplication] copy address failed:', err)
    },
  })

  const openInBrowser = useMutation({
    mutationFn: () => invoke('open_external_url', { url: address }),
    onError: (err: unknown) => {
      console.error('[RemoteApplication] open in browser failed:', err)
      toast(t('remote.application_open_failed'), { variant: 'danger' })
    },
  })

  const disconnect = useMutation({
    mutationFn: async () => {
      // 本窗口的文档正是经这条隧道加载的：先切回本机文档，再断开这台机器。
      // 反过来做会把窗口留在一个再也收不到消息的页面上。
      void invoke('navigate_remote_harness', { machineId: null })
        .catch(error => console.error('[RemoteApplication] navigate local failed:', error))
      await postMachinesDisconnect({ machineId })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.remoteMachines })
    },
    onError: (err: unknown) => {
      console.error('[RemoteApplication] disconnect failed:', err)
      toast(t('remote.application_disconnect_failed'), { variant: 'danger' })
    },
  })

  return (
    <div className="space-y-3" data-testid="dsh-config-remote-application">
      <Panel.Header title={t('config.application')} testId="dsh-config-panel-title" />
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">
            {t('ui.connection_status')}
          </span>
          <Chip size="sm" variant="soft" color={STATE_COLOR[state] ?? 'default'} className="font-medium">
            {t(`remote.state.${state}`)}
          </Chip>
        </div>
        <div className="flex gap-1.5">
          <Input
            readOnly
            variant="secondary"
            value={address === '' ? '-' : address}
            aria-label={t('ui.service_url')}
            className="font-mono text-xs flex-1"
            data-testid="dsh-config-remote-address"
          />
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            isDisabled={address === '' || copyAddress.isPending}
            onPress={() => copyAddress.mutate()}
            aria-label={t('buttons.copy')}
            data-testid="dsh-config-remote-copy"
          >
            <Copy className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            isDisabled={address === '' || openInBrowser.isPending}
            onPress={() => openInBrowser.mutate()}
            aria-label={t('app.open_browser')}
            data-testid="dsh-config-remote-open-browser"
          >
            <ArrowUpRightFromSquare className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            onPress={() => globalThis.location.reload()}
            aria-label={t('app.reload_page')}
            data-testid="dsh-config-remote-reload"
          >
            <ArrowsRotateRight className="size-3.5" />
          </Button>
        </div>
        <p className="text-[10px] leading-4 text-muted/70">{t('remote.application_hint')}</p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="danger"
          className="flex-1"
          isDisabled={disconnect.isPending}
          onPress={() => disconnect.mutate()}
          data-testid="dsh-config-remote-disconnect"
        >
          <Power className="size-3.5" />
          {t('remote.disconnect_active')}
        </Button>
      </div>
      <div className="border-t border-line/30" />
      <div className="space-y-1">
        <Info term={t('ui.dsh_version')}>
          <span data-testid="dsh-config-remote-version">{version ?? '-'}</span>
        </Info>
        <If cond={target?.remoteProfile !== undefined}>
          <Info term={t('core.remote_profiles')}>
            <span data-testid="dsh-config-remote-profile">{target?.remoteProfile}</span>
          </Info>
        </If>
      </div>
      <If cond={targetQuery.error != null}>
        <Description className="break-all text-[10px] text-danger">{String(targetQuery.error)}</Description>
      </If>
      <If cond={machine?.lastError !== undefined}>
        <Description className="break-all text-[10px] text-warning">{machine?.lastError}</Description>
      </If>
      <div className="border-t border-line/30" />
      <ApplicationPreferences />
    </div>
  )
}
