import { ArrowUpRightFromSquare, ArrowUpToLine, Gear, House, Power, Server } from '@gravity-ui/icons'
import { Button, Description, Dropdown, Label } from '@heroui/react'
import { useWatch } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { cn } from 'tailwind-variants'
import { dotClassOf, useRemote } from '@/hooks/use-remote'
import { toast } from '@/utils/toast'
import { ConnectDialog } from './connect-dialog'

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

export function RemoteSwitcher({ onChange, visible = true, onManage, onSync }: {
  onChange: (url: string, tint: string | null) => void
  visible?: boolean
  onManage?: () => void
  onSync?: () => void
}) {
  const { t } = useTranslation()
  const remote = useRemote()
  const { machines, activeId, activeTunnelUrl, available, enabled, pendingId } = remote

  const activeMachine = machines.find(machine => machine.id === activeId)
  const activeColor = activeMachine?.color
  const tint = activeTunnelUrl !== '' && activeMachine?.tintBorder ? activeColor ?? null : null
  useWatch([activeTunnelUrl, tint], () => onChange(activeTunnelUrl, tint), { immediate: true })

  function handleOpenWindowError(err: unknown) {
    toast(t('remote.open_window_failed'), {})
    console.warn('[remote] open window failed:', err)
  }

  if (!visible || !enabled)
    return null

  return (
    <>
      <ConnectDialog remote={remote} />
      <Dropdown>
        <Button
          className="h-7 text-[12.5px] px-1.5 ml-1 gap-1.5"
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
        <Dropdown.Popover className="w-72!">
          <Dropdown.Menu>
            <If cond={!available}>
              <Dropdown.Item id="remote-degraded" isDisabled textValue={t('remote.degraded')}>
                <Description className="text-warning">{t('remote.degraded')}</Description>
              </Dropdown.Item>
            </If>
            <Dropdown.Section aria-label={t('remote.section_local')}>
              <Dropdown.Item
                id="remote-local"
                textValue={t('remote.local')}
                onAction={() => { remote.backToLocal() }}
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
                <Dropdown.Item id="remote-empty" isDisabled textValue={t('remote.empty')}>
                  <Description>{t('remote.empty')}</Description>
                </Dropdown.Item>
              </If>
              {machines.map((machine) => {
                const pending = pendingId === machine.id
                const connected = machine.state === 'connected' && machine.tunnelBaseUrl !== undefined
                const subtitle = machine.host === undefined ? undefined : `${machine.user !== undefined ? `${machine.user}@` : ''}${machine.host}${machine.port !== undefined ? `:${machine.port}` : ''}`
                return (
                  <Dropdown.Item
                    key={machine.id}
                    id={`remote-${machine.id}`}
                    textValue={machine.name}
                    isDisabled={!available || pendingId !== null}
                    onAction={() => { remote.switchTo(machine.id) }}
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
                        style={machine.id !== activeId && machine.color !== undefined ? { backgroundColor: machine.color } : undefined}
                      />
                      <span className="flex min-w-0 flex-col">
                        <Label className="truncate">{machine.name}</Label>
                        <If cond={subtitle !== undefined}>
                          <Description className="truncate text-[11px] leading-4">{subtitle}</Description>
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
                          invoke('remote_open_window', { machineId: machine.id, url: machine.tunnelBaseUrl ?? '' }).catch(handleOpenWindowError)
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
                  id="remote-disconnect-active"
                  textValue={t('remote.disconnect_active')}
                  onAction={() => {
                    if (activeId !== null)
                      void remote.disconnect(activeId)
                  }}
                >
                  <span className="flex w-full items-center gap-2 text-warning">
                    <Power className="size-3.5" />
                    <Label className="text-warning">{t('remote.disconnect_active')}</Label>
                  </span>
                </Dropdown.Item>
              </If>
              <Dropdown.Item
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
    </>
  )
}
