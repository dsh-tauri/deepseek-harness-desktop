import type { SshMachineRow } from '@/store/modules/remote'
import { ArrowUpRightFromSquare, ArrowUpToLine, Gear, House, Power, Server } from '@gravity-ui/icons'
import { Button, Description, Dropdown, Label } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { cn } from 'tailwind-variants'
import { useStore } from 'valtio-define'
import { useRemoteMachines } from '@/hooks/use-remote-machines'
import { store } from '@/store'
import { dotClassOf, dotStyleOf } from '@/store/modules/remote'
import { toast } from '@/utils/toast'

/** 机器行的状态描述：pending 立即「连接中」；重连带倒计时；已知凭据类型缀后。 */
function stateTextOf(
  machine: { state: string, nextRetryAt?: number, authMethod?: 'agent' | 'key' | 'password' },
  pending: boolean,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (pending)
    return t('remote.state.connecting')
  let text = t(`remote.state.${machine.state}`)
  if (machine.state === 'reconnecting' && machine.nextRetryAt !== undefined) {
    const seconds = Math.max(0, Math.ceil((machine.nextRetryAt - Date.now()) / 1000))
    text += t('remote.retry_in', { seconds })
  }
  if (machine.authMethod !== undefined)
    text += ` · ${t(`remote.auth.${machine.authMethod}`)}`
  return text
}

/** 行内副标题：`user@host:port`（信息不全时退化为已有字段）。 */
function subtitleOf(machine: SshMachineRow): string | undefined {
  if (machine.host === undefined)
    return undefined
  const target = `${machine.user !== undefined ? `${machine.user}@` : ''}${machine.host}${machine.port !== undefined ? `:${machine.port}` : ''}`
  return target
}

/**
 * 新窗口打开远端（复用壳层 remote_open_window 命令；聚焦已有窗口）。
 * 未连接机器也可开窗（url 置空）：新窗口内壳层启动即发起标准连接流程。
 */
function openInNewWindow(machine: SshMachineRow, onError: (err: unknown) => void): void {
  invoke('remote_open_window', { machineId: machine.id, url: machine.tunnelBaseUrl ?? '' })
    .catch(onError)
}

/**
 * 导航栏远端机器切换器：本地实例 ↔ 各远端机器。
 *
 * 数据面全部来自本地实例 `/api-ssh`（`useRemoteMachines` 启动秒级轮询 +
 * 聚焦刷新）；点击机器行=当前窗口切换（未连接则发起连接，进度弹窗实时
 * 呈现），行尾图标=新窗口打开（已连接机器可用）。操作区两项同级：底部
 * 「管理机器…」与「同步到远端…」，各自直达 SSH 设置浮层的对应标签页。
 *
 * SSH 未启用（插件开关关闭，或本地实例没有该 API）时不渲染任何控件——「本地」
 * 这一项本身就是 SSH 功能的一部分；轮询照常进行，启用后下一轮即出现。
 *
 * 色点语义（S3 词汇表）：机器标识色优先 → 已连接绿 → 重连/进行中琥珀 →
 * 放弃红 → 其余中性灰；未连接行整体降不透明度。本地实例不可达时进入降级
 * 态：远端项禁用 + 顶部提示，恢复后自动复原（轮询静默重试，不弹错误）。
 */
export function RemoteSwitcher({ onManage, onSync }: { onManage?: () => void, onSync?: () => void }) {
  const { t } = useTranslation()
  useRemoteMachines()
  const { machines, activeId, available, enabled, pendingId } = useStore(store.remote)

  const activeMachine = machines.find(machine => machine.id === activeId)
  const activeColor = activeMachine?.color

  function handleOpenWindowError(err: unknown) {
    toast(t('remote.open_window_failed'), {})
    console.warn('[remote] open window failed:', err)
  }

  if (!enabled)
    return null

  return (
    <Dropdown>
      <Button
        className="rounded-lg h-7 text-[12.5px] px-1.5 ml-1 gap-1.5"
        size="sm"
        variant="ghost"
        aria-label={t('remote.switcher')}
      >
        <Server className={cn(!available && 'text-warning')} />
        <span className="max-w-28 truncate">{activeMachine ? activeMachine.name : t('remote.local')}</span>
        <If cond={activeColor !== undefined}>
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full"
            style={activeColor !== undefined ? { backgroundColor: activeColor } : undefined}
          />
        </If>
      </Button>
      <Dropdown.Popover className="rounded-lg w-72!">
        <Dropdown.Menu>
          <If cond={!available}>
            <Dropdown.Item className="rounded-md" id="remote-degraded" isDisabled textValue={t('remote.degraded')}>
              <Description className="text-warning">{t('remote.degraded')}</Description>
            </Dropdown.Item>
          </If>
          <Dropdown.Section aria-label={t('remote.section_local')}>
            <Dropdown.Item
              className="rounded-md"
              id="remote-local"
              textValue={t('remote.local')}
              onAction={() => { store.remote.backToLocal() }}
            >
              <span className="flex w-full items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn('size-1.5 rounded-full', activeMachine === undefined ? 'bg-success' : 'bg-line-strong')}
                />
                <House className="size-3.5 text-muted" />
                <Label>{t('remote.local')}</Label>
                <If cond={activeId === null}>
                  <Description className="ml-auto">{t('remote.current')}</Description>
                </If>
              </span>
            </Dropdown.Item>
          </Dropdown.Section>
          <Dropdown.Section aria-label={t('remote.section_machines')}>
            <If cond={machines.length === 0}>
              <Dropdown.Item className="rounded-md" id="remote-empty" isDisabled textValue={t('remote.empty')}>
                <Description>{t('remote.empty')}</Description>
              </Dropdown.Item>
            </If>
            {machines.map((machine) => {
              const pending = pendingId === machine.id
              const connected = machine.state === 'connected' && machine.tunnelBaseUrl !== undefined
              return (
                <Dropdown.Item
                  key={machine.id}
                  className="rounded-md"
                  id={`remote-${machine.id}`}
                  textValue={machine.name}
                  isDisabled={!available || pendingId !== null}
                  onAction={() => { store.remote.switchTo(machine.id) }}
                >
                  <span
                    title={machine.lastError}
                    className={cn(
                      'flex w-full items-center gap-2',
                      connected ? '' : 'opacity-60',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn('size-1.5 shrink-0 rounded-full', machine.id === activeId ? 'bg-success' : dotClassOf(machine))}
                      style={machine.id === activeId ? undefined : dotStyleOf(machine)}
                    />
                    <span className="flex min-w-0 flex-col">
                      <Label className="truncate">{machine.name}</Label>
                      <If cond={subtitleOf(machine) !== undefined}>
                        <Description className="truncate text-[11px] leading-4">{subtitleOf(machine)}</Description>
                      </If>
                    </span>
                    <Description className={cn('ml-auto shrink-0', pending && 'text-warning')}>
                      {stateTextOf(machine, pending, t)}
                    </Description>
                    {/* 行尾双动作：行本体=当前窗口切换；图标=新窗口打开（常驻——
                        未连接机器开窗后由新窗口内壳层发起连接）。RAC 菜单项的
                        press 由原生事件冒泡驱动（其 PressEvent 无
                        stopPropagation），故图标用原生 span + 事件阻断：
                        点击只发 remote_open_window，本窗口不跟着切换 */}
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={t('remote.open_new_window')}
                      className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-panel2 hover:text-ink"
                      onPointerDown={e => e.stopPropagation()}
                      onPointerUp={e => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        openInNewWindow(machine, handleOpenWindowError)
                      }}
                    >
                      <ArrowUpRightFromSquare className="size-3.5" />
                    </span>
                  </span>
                </Dropdown.Item>
              )
            })}
          </Dropdown.Section>
          <Dropdown.Section aria-label={t('remote.section_actions')}>
            {/* 活动远端连接的一键断开（视图先回本地，再向引擎发断开） */}
            <If cond={activeId !== null}>
              <Dropdown.Item
                className="rounded-md"
                id="remote-disconnect-active"
                textValue={t('remote.disconnect_active')}
                onAction={() => {
                  if (activeId !== null)
                    void store.remote.disconnect(activeId)
                }}
              >
                <span className="flex w-full items-center gap-2 text-warning">
                  <Power className="size-3.5" />
                  <Label className="text-warning">{t('remote.disconnect_active')}</Label>
                </span>
              </Dropdown.Item>
            </If>
            <Dropdown.Item
              className="rounded-md"
              id="remote-manage"
              isDisabled={onManage == null}
              textValue={t('remote.manage')}
              onAction={onManage}
            >
              <span className="flex w-full items-center gap-2">
                <Gear className="size-3.5 text-muted" />
                <Label>{t('remote.manage')}</Label>
              </span>
            </Dropdown.Item>
            <Dropdown.Item
              className="rounded-md"
              id="remote-sync"
              isDisabled={onSync == null}
              textValue={t('remote.sync')}
              onAction={onSync}
            >
              <span className="flex w-full items-center gap-2">
                <ArrowUpToLine className="size-3.5 text-muted" />
                <Label>{t('remote.sync')}</Label>
              </span>
            </Dropdown.Item>
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}
