import { ArrowUpRightFromSquare, Copy, Gear, Smartphone, TriangleExclamation } from '@gravity-ui/icons'
import { Button, Description, Label, Popover, ProgressBar, Spinner, Tabs } from '@heroui/react'
import { useIntervalFn, useUnmount, useUnmountedRef, useWatch } from '@reause/core'
import { useMutation } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { deleteAccessTunnel, getAccess, postAccess, postAccessTunnel } from '@/apis/remote'
import { writeClipboardText } from '@/utils/clipboard'

interface AccessPairing {
  code: string
  expiresAt: number
  usedSeq?: number
  link?: string
  qr?: string
  tunnelLink?: string
  tunnelQr?: string
}

interface AccessTunnel {
  enabled?: boolean
  mode?: 'quick' | 'token'
  hostname?: string | null
  state?: 'stopped' | 'starting' | 'running' | 'error'
  url?: string
  port?: number
  link?: string
  qr?: string
  progress?: { stage?: string, url?: string, received?: number, total?: number }
  error?: string
}

interface AccessStatus {
  version?: number
  enabled?: boolean
  state?: 'stopped' | 'listening' | 'error'
  listening?: boolean
  listen?: { address?: string, port?: number }
  port?: number
  addresses?: { address?: string, recommended?: boolean }[]
  link?: string
  maskLink?: string
  qr?: string
  linkSource?: 'loopback' | 'lan'
  error?: string
  warnings?: string[]
  pairing?: AccessPairing
  tunnel?: AccessTunnel
}

const POLL_INTERVAL = 5000

const LOOPBACK_LINK = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0|\[::\])(?::|\/|$)/i

const UNUSABLE_ADDRESS = /^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|::1|::)$/i

function isShareableLink(link: string | undefined): link is string {
  return link !== undefined && link !== '' && !LOOPBACK_LINK.test(link)
}

function isUnusableAddress(address: string | undefined): boolean {
  return address === undefined || address === '' || UNUSABLE_ADDRESS.test(address)
}

function megabytesOf(bytes: number | undefined): string {
  return bytes === undefined ? '0' : (bytes / 1048576).toFixed(1)
}

function clockOf(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function pairingUseSeqOf(status: AccessStatus | null): number | undefined {
  const seq = status?.pairing?.usedSeq
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined
}

export function RemoteShare({ onManage }: { onManage?: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<AccessStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const requestSeqRef = useRef(0)
  const savedSeqRef = useRef(0)
  const busyRef = useRef(false)
  const refreshedExpiryRef = useRef<number | null>(null)
  const openRef = useRef(false)
  const sessionRef = useRef(0)
  const watchSessionRef = useRef<number | null>(null)
  const baselineRef = useRef<number | undefined>(undefined)
  const consumedRef = useRef(false)
  const unmountedRef = useUnmountedRef()

  function changeOpen(next: boolean) {
    if (openRef.current === next)
      return
    openRef.current = next
    sessionRef.current += 1
    requestSeqRef.current += 1
    baselineRef.current = undefined
    consumedRef.current = false
    refreshedExpiryRef.current = null
    if (next) {
      setStatus(null)
      setNow(Date.now())
    }
    setOpen(next)
  }

  function updateStatus(raw: AccessStatus, consumed = false) {
    setStatus(raw)
    setError(raw?.error ?? null)
    const nextSeq = pairingUseSeqOf(raw)
    if (consumed || (baselineRef.current !== undefined && nextSeq !== undefined && nextSeq !== baselineRef.current))
      changeOpen(false)
  }

  async function load(consumed = false) {
    if (!openRef.current || unmountedRef.current)
      return
    const seq = ++requestSeqRef.current
    try {
      const raw = await getAccess() as unknown as AccessStatus
      if (seq !== requestSeqRef.current || unmountedRef.current)
        return
      savedSeqRef.current = seq
      updateStatus(raw, consumed)
    }
    catch (err) {
      if (seq !== requestSeqRef.current || unmountedRef.current)
        return
      savedSeqRef.current = seq
      setError(String(err))
    }
  }

  const { mutate, isPending: busy } = useMutation({
    mutationFn: async ({ action }: { action: () => Promise<unknown>, session: number, seq: number }) => await action() as AccessStatus,
    onSuccess: async (raw, { session, seq }) => {
      if (session !== sessionRef.current || !openRef.current || unmountedRef.current)
        return
      const refreshed = savedSeqRef.current > seq
      requestSeqRef.current += 1
      if (refreshed)
        await load()
      else
        updateStatus(raw)
    },
    onError: (err, { session }) => {
      if (session !== sessionRef.current || !openRef.current || unmountedRef.current)
        return
      requestSeqRef.current += 1
      setError(String(err))
    },
    onSettled: () => {
      busyRef.current = false
    },
  })

  function run(action: () => Promise<unknown>) {
    if (busyRef.current || !openRef.current || unmountedRef.current)
      return
    const seq = ++requestSeqRef.current
    busyRef.current = true
    setError(null)
    mutate({ action, session: sessionRef.current, seq })
  }

  async function watchPairingUse(session: number, baseline: number) {
    watchSessionRef.current = session
    try {
      while (openRef.current && session === sessionRef.current && !unmountedRef.current) {
        const raw = await getAccess({ sincePairingUseSeq: baseline }) as unknown as AccessStatus
        if (!openRef.current || session !== sessionRef.current || unmountedRef.current)
          return
        const nextSeq = pairingUseSeqOf(raw)
        if (nextSeq === undefined)
          return
        if (nextSeq !== baseline) {
          if (busyRef.current) {
            consumedRef.current = true
            return
          }
          updateStatus(raw)
          return
        }
        if (raw?.error !== undefined)
          return
      }
    }
    catch {
      return
    }
    finally {
      if (watchSessionRef.current === session)
        watchSessionRef.current = null
    }
  }

  const poll = useIntervalFn(() => void load(), POLL_INTERVAL, { immediate: false })
  const clock = useIntervalFn(() => setNow(Date.now()), 1000, { immediate: false })
  useWatch(open, () => {
    if (open) {
      poll.resume()
      clock.resume()
      void load()
    }
    else {
      poll.pause()
      clock.pause()
    }
  })
  useWatch(busy, () => {
    if (!busy && open && status === null)
      void load()
  })
  useUnmount(() => {
    openRef.current = false
    sessionRef.current += 1
    requestSeqRef.current += 1
  })

  useWatch([open, status, busy], () => {
    if (!open || busy || status === null)
      return
    if (consumedRef.current) {
      void load(true)
      return
    }
    const baseline = pairingUseSeqOf(status)
    if (baseline === undefined)
      return
    baselineRef.current ??= baseline
    if (watchSessionRef.current !== sessionRef.current)
      void watchPairingUse(sessionRef.current, baselineRef.current)
  })

  const pairing = status?.pairing
  useWatch([open, pairing, now, busy], () => {
    if (!open || busy || pairing === undefined || pairing.expiresAt > now)
      return
    if (refreshedExpiryRef.current === pairing.expiresAt)
      return
    refreshedExpiryRef.current = pairing.expiresAt
    void load()
  })

  function copyLink(link: string) {
    void writeClipboardText(link, t('remote.share.copied')).catch(() => { })
  }

  const listening = status?.state === 'listening' || status?.listening === true
  const shareLink = isShareableLink(pairing?.link) ? pairing.link : null
  const recommendedAddress = status?.addresses?.find(item => item.recommended === true && !isUnusableAddress(item.address))?.address
  const tunnel = status?.tunnel
  const tunnelState = tunnel?.state ?? 'stopped'
  const tunnelLink = isShareableLink(pairing?.tunnelLink) ? pairing.tunnelLink : null
  const stage = tunnel?.progress?.stage
  const received = tunnel?.progress?.received
  const total = tunnel?.progress?.total
  const downloading = stage === 'download'
  const knownTotal = total !== undefined && Number.isFinite(total) && total > 0
  const downloadPercent = knownTotal ? Math.max(0, Math.min(100, ((received ?? 0) / total) * 100)) : undefined
  const downloadLabel = knownTotal
    ? t('remote.share.download_progress', { received: megabytesOf(received), total: megabytesOf(total) })
    : t('remote.share.download_received', { received: megabytesOf(received) })
  const pairingCode = (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line/40 px-2.5 py-2">
      <span className="text-[11px] text-muted">{t('remote.share.pairing')}</span>
      {pairing === undefined
        ? <span className="text-[11px] text-muted">{t('remote.share.pairing_absent')}</span>
        : (
            <>
              <div className="flex items-center gap-2">
                <Description className="shrink-0 text-[11px] text-muted">
                  {t('remote.share.pairing_expires', { time: clockOf(pairing.expiresAt - now) })}
                </Description>
                <span className="ml-auto font-mono text-base tracking-[0.2em] text-ink" data-testid="remote-share-pairing">
                  {pairing.code}
                </span>
              </div>
              <span className="text-[11px] leading-4 text-muted">{t('remote.share.pairing_hint')}</span>
            </>
          )}
    </div>
  )

  return (
    <Popover isOpen={open} onOpenChange={changeOpen}>
      <Button
        className="h-7 text-[12.5px] px-1.5 ml-1 gap-1.5"
        size="sm"
        variant="ghost"
        aria-label={t('remote.share')}
      >
        <Smartphone />
        <span>{t('remote.share')}</span>
      </Button>

      <Popover.Content className="w-88! max-w-[92vw]" data-testid="remote-share-panel">
        <Popover.Dialog className="space-y-3">
          <div className="flex items-center gap-2">
            <Popover.Heading className="text-xs">{t('remote.share')}</Popover.Heading>
            <Button
              className="ml-auto size-7 shrink-0"
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label={t('remote.share.settings')}
              isDisabled={onManage == null}
              onPress={onManage}
            >
              <Gear className="size-3.5" />
            </Button>
          </div>

          <div className="rounded-lg border border-line/40">
            <Button
              className="h-auto w-full justify-between py-2 text-left"
              variant="ghost"
              onPress={() => void invoke('open_external_url', {
                url: 'https://github.com/dsh-tauri/deepseek-harness-desktop/releases',
              }).catch(err => setError(String(err)))}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-xs text-ink">{t('remote.share.mobile')}</span>
                <span className="whitespace-normal text-[11px] leading-4 text-muted">{t('remote.share.mobile_hint')}</span>
              </span>
              <ArrowUpRightFromSquare className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
            </Button>
          </div>

          <If cond={error !== null}>
            <Description className="break-all text-xs text-danger">
              {t('remote.share.action_failed')}
              {' · '}
              {error}
            </Description>
          </If>

          <Tabs defaultSelectedKey="lan" variant="primary">
            <Tabs.ListContainer>
              <Tabs.List aria-label={t('remote.share')}>
                <Tabs.Tab id="lan" className="h-7 px-3 text-xs">
                  {t('remote.share.tab_lan')}
                  <Tabs.Indicator />
                </Tabs.Tab>
                <Tabs.Tab id="tunnel" className="h-7 px-3 text-xs">
                  {t('remote.share.tab_tunnel')}
                  <Tabs.Indicator />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>

            <Tabs.Panel id="lan" className="space-y-3 pt-3">
              <If cond={status === null}>
                <Description className="flex items-center gap-1.5 text-xs">
                  <Spinner className="size-3" />
                  {t('remote.share.loading')}
                </Description>
              </If>

              <If cond={status !== null && !listening}>
                <Description className="flex items-center gap-1.5 text-xs">
                  {t('remote.share.lan_off_desc')}
                </Description>
                <Button
                  className="h-8 w-full text-xs"
                  variant="primary"
                  size="sm"
                  isDisabled={busy}
                  onPress={() => void run(() => postAccess(
                    recommendedAddress === undefined
                      ? { enabled: true }
                      : { enabled: true, address: recommendedAddress },
                  ))}
                >
                  {t('remote.share.lan_enable')}
                </Button>
              </If>

              <If cond={status !== null && listening}>
                {shareLink === null && (
                  <div className="flex items-start gap-2 rounded-lg border border-warning/40 px-2.5 py-2">
                    <TriangleExclamation className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    <Description className="text-[11px] leading-4 text-warning">{t('remote.share.lan_local_only')}</Description>
                  </div>
                )}

                {shareLink !== null && (
                  <>
                    <div className="rounded-md bg-panel2 px-2 py-1.5">
                      <Description className="flex items-center justify-between gap-2 font-mono text-[11px]">
                        <div className="min-w-0 flex-1 truncate py-1">{shareLink}</div>
                        <Button
                          className="size-6 gap-1.5 text-xs shrink-0"
                          variant="ghost"
                          size="sm"
                          isIconOnly
                          aria-label={t('remote.share.copy')}
                          onPress={() => copyLink(shareLink)}
                        >
                          <Copy className="size-3.5" />
                        </Button>
                      </Description>
                    </div>
                    {pairing?.qr !== undefined && (
                      <div className="flex items-center justify-center rounded-lg bg-panel2 p-2">
                        <img src={pairing.qr} alt={t('remote.share.qr_alt')} className="size-36 rounded-md bg-white p-1" />
                      </div>
                    )}
                  </>
                )}
                {pairingCode}
              </If>
            </Tabs.Panel>

            <Tabs.Panel id="tunnel" className="space-y-3 pt-3">
              <If cond={status === null}>
                <Description className="flex items-center gap-1.5 text-xs">
                  <Spinner className="size-3" />
                  {t('remote.share.loading')}
                </Description>
              </If>

              <If cond={status !== null && tunnelState === 'stopped'}>
                <Description className="pb-1 text-center text-xs block">{t('remote.share.tunnel_off_desc')}</Description>
                <Button
                  className="h-8 w-full text-xs"
                  variant="primary"
                  size="sm"
                  isDisabled={busy}
                  onPress={() => void run(() => postAccessTunnel({ mode: 'quick' }))}
                >
                  {t('remote.share.tunnel_enable')}
                </Button>
              </If>

              <If cond={status !== null && tunnelState === 'starting'}>
                <div className="flex flex-col gap-4 justify-center items-center">
                  <If
                    cond={downloading}
                    else={(
                      <Description className="flex items-center gap-1.5 text-xs">
                        <Spinner className="size-3" />
                        {t('remote.share.tunnel_starting')}
                        <If cond={stage}>
                          （
                          {t(`remote.share.stage.${stage}`)}
                          ）
                        </If>
                      </Description>
                    )}
                  >
                    <ProgressBar
                      size="sm"
                      value={downloadPercent}
                      isIndeterminate={!knownTotal}
                      className="w-full"
                      valueLabel={downloadLabel}
                    >
                      <Label>{t('remote.share.stage.download')}</Label>
                      <ProgressBar.Output className="text-xs text-muted tabular-nums">{downloadLabel}</ProgressBar.Output>
                      <ProgressBar.Track>
                        <ProgressBar.Fill className="bg-info" />
                      </ProgressBar.Track>
                    </ProgressBar>
                  </If>
                  <Button
                    className="h-8 w-full text-xs"
                    variant="tertiary"
                    size="sm"
                    isDisabled={busy}
                    onPress={() => void run(() => deleteAccessTunnel())}
                  >
                    {t('remote.share.tunnel_stop')}
                  </Button>
                </div>
              </If>

              <If cond={status !== null && tunnelState === 'error'}>
                <Description className="break-all text-xs text-danger">
                  {t('remote.share.tunnel_failed')}
                  {tunnel?.error === undefined ? '' : ` · ${tunnel.error}`}
                </Description>
                <Button
                  className="h-8 w-full text-xs"
                  variant="primary"
                  size="sm"
                  isDisabled={busy}
                  onPress={() => void run(() => postAccessTunnel({ mode: tunnel?.mode ?? 'quick' }))}
                >
                  {t('remote.connect.retry')}
                </Button>
              </If>

              <If cond={status !== null && tunnelState === 'running'}>
                {tunnelLink !== null && (
                  <>
                    <div className="rounded-md bg-panel2 px-2 py-1.5">
                      <Description className="flex items-center justify-between gap-2 font-mono text-[11px]">
                        <div className="min-w-0 flex-1 truncate py-1">{tunnelLink}</div>
                        <Button
                          className="size-6 gap-1.5 text-xs shrink-0"
                          variant="ghost"
                          size="sm"
                          isIconOnly
                          aria-label={t('remote.share.copy')}
                          onPress={() => copyLink(tunnelLink)}
                        >
                          <Copy className="size-3.5" />
                        </Button>
                      </Description>
                    </div>
                  </>
                )}

                {pairing?.tunnelQr !== undefined && (
                  <div className="flex items-center justify-center rounded-lg bg-panel2 p-2">
                    <img src={pairing.tunnelQr} alt={t('remote.share.qr_alt')} className="size-36 rounded-md bg-white p-1" />
                  </div>
                )}

                {pairingCode}

                <Button
                  className="h-8 w-full text-xs"
                  variant="tertiary"
                  size="sm"
                  isDisabled={busy}
                  onPress={() => void run(() => deleteAccessTunnel())}
                >
                  {t('remote.share.tunnel_stop')}
                </Button>
              </If>
            </Tabs.Panel>
          </Tabs>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}
