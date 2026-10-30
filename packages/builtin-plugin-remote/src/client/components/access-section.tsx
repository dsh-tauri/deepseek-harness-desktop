import type { ReactElement, ReactNode } from 'react'
import type { RemoteKey } from '../locales/index'
import type { AccessStatus, AccessTunnel, TunnelProgress } from '../types/index'
import type { TunnelDraft } from '../utils/access-form'
import { Button, Input, SegmentedControl, Select, StateDot, Switch } from 'dsh-tauri-ui/client'
import { useStore } from 'dsh-tauri/client'
import { useEffect, useRef, useState } from 'react'
import * as service from '../service/access'
import { store } from '../store/index'
import { countdownOf, lanDirtyOf, tunnelBodyOf, tunnelDirtyOf, tunnelDraftOf, tunnelMissingOf } from '../utils/access-form'

interface AccessSectionProps {
  t: (key: RemoteKey) => string
}

const LOOPBACK = '127.0.0.1'
const WILDCARD = '0.0.0.0'
const LOOPBACK_ALIASES = [LOOPBACK, '::1', 'localhost']

function tunnelKeyOf(tunnel: AccessTunnel): RemoteKey {
  if (tunnel.state === 'error' || tunnel.error !== undefined)
    return 'access.tunnel.state.error'
  if (tunnel.state === 'starting')
    return 'access.tunnel.state.starting'
  return tunnel.state === 'running' ? 'access.tunnel.state.running' : 'access.tunnel.state.stopped'
}

function progressKeyOf(progress: TunnelProgress): RemoteKey {
  return `access.tunnel.progress.${progress.stage}` as RemoteKey
}

function progressPercentOf(progress: TunnelProgress): number | null {
  if (progress.stage !== 'download' || progress.received === undefined || progress.total === undefined || progress.total <= 0)
    return null
  return Math.min(100, Math.round((progress.received / progress.total) * 100))
}

function addressOptionsOf(status: AccessStatus, t: (key: RemoteKey) => string): { value: string, label: string }[] {
  const extra = status.addresses
    .filter(item => !LOOPBACK_ALIASES.includes(item.address) && item.address !== WILDCARD)
    .map(item => ({
      value: item.address,
      label: `${item.address} · ${item.interface}${item.recommended ? `（${t('access.listen.recommended')}）` : ''}`,
    }))
  return [
    { value: LOOPBACK, label: `${LOOPBACK}（${t('access.lan.loopback')}）` },
    { value: WILDCARD, label: `${WILDCARD}（${t('access.listen.allInterfaces')}）` },
    ...extra,
  ]
}

function Card({ children }: { children: ReactNode }): ReactElement {
  return (
    <section className="rounded-[12px] border-[0.5px] border-border-l2 bg-layer-1 px-[16px]">
      <div className="flex flex-col">{children}</div>
    </section>
  )
}

function Row({ title, hint, children }: { title: string, hint?: string, children: ReactNode }): ReactElement {
  return (
    <div className="flex items-center justify-between gap-[24px] py-[16px] border-b-[0.5px] border-border-l2 last:border-b-0">
      <div className="flex min-w-0 flex-col">
        <span className="text-[14px] leading-[20px] text-primary">{title}</span>
        {hint === undefined ? null : <span className="mt-[4px] text-[12px] leading-[18px] text-secondary">{hint}</span>}
      </div>
      <div className="flex flex-none flex-wrap items-center justify-end gap-[8px]">{children}</div>
    </div>
  )
}

export function AccessSection({ t }: AccessSectionProps): ReactElement {
  const state = useStore(store.access)
  const status = state.snapshot
  const [now, setNow] = useState(() => Date.now())
  const [lanDraft, setLanDraft] = useState<{ address: string } | null>(null)
  const [tunnelDraft, setTunnelDraft] = useState<TunnelDraft | null>(null)
  const [revealed, setRevealed] = useState(false)
  const expiredRef = useRef(0)
  const pairingExpiry = status?.pairing?.expiresAt

  useEffect(() => {
    void service.load()
  }, [])

  useEffect(() => {
    if (pairingExpiry === undefined)
      return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pairingExpiry])

  useEffect(() => {
    if (pairingExpiry === undefined || pairingExpiry > now || expiredRef.current === pairingExpiry)
      return
    expiredRef.current = pairingExpiry
    void service.refresh()
  }, [pairingExpiry, now])

  if (status === null) {
    return (
      <div className="flex flex-col gap-[8px] text-[13px] leading-[20px] text-secondary" data-testid="access-section">
        <span>{t('access.loading')}</span>
        {state.error === null
          ? null
          : <span className="text-error" role="alert" data-testid="access-error">{state.error}</span>}
      </div>
    )
  }

  const tunnel = status.tunnel
  const busy = state.busy
  const address = lanDraft?.address ?? status.listen.address
  const dirtyLan = lanDirtyOf(lanDraft, status.listen)
  const tunnelForm = tunnelDraft ?? tunnelDraftOf(tunnel)
  const tunnelOpen = tunnel.enabled || tunnelDraft !== null
  const dirtyTunnel = tunnelDirtyOf(tunnelDraft, tunnel)
  const missing = tunnelMissingOf(tunnelForm)
  const tunnelLive = tunnel.enabled && (tunnel.state === 'running' || tunnel.state === 'starting')
  const token = status.auth.token
  const pairing = status.pairing
  const countdown = pairing === undefined ? '' : countdownOf(pairing.expiresAt, now)
  const downloading = tunnel.state === 'starting' && tunnel.progress?.stage === 'download'
  const progressPercent = tunnel.progress === undefined ? null : progressPercentOf(tunnel.progress)

  async function setExposure(next: boolean): Promise<void> {
    await service.apply(next ? { enabled: true, authEnabled: true, scope: 'all' } : { enabled: false })
  }

  async function saveLan(): Promise<void> {
    if (lanDraft === null)
      return
    const result = await service.apply({ address: lanDraft.address })
    if (result.ok)
      setLanDraft(null)
  }

  async function setTunnelEnabled(next: boolean): Promise<void> {
    if (next) {
      setTunnelDraft(tunnelDraftOf(tunnel))
      return
    }
    setTunnelDraft(null)
    if (tunnel.enabled)
      await service.stopTunnel()
  }

  function editTunnel(patch: Partial<TunnelDraft>): void {
    setTunnelDraft(previous => ({ ...(previous ?? tunnelDraftOf(tunnel)), ...patch }))
  }

  async function submitTunnel(draft: TunnelDraft, saved: AccessTunnel): Promise<void> {
    if (tunnelMissingOf(draft) !== undefined)
      return
    const body = tunnelBodyOf(draft)
    const result = await service.startTunnel({
      mode: body.mode,
      token: body.token ?? saved.token,
      hostname: body.hostname ?? saved.hostname ?? undefined,
    })
    if (result.ok)
      setTunnelDraft(null)
  }

  function issueToken(): void {
    setRevealed(true)
    void service.rotateToken()
  }

  function revokeToken(): void {
    setRevealed(false)
    void service.revokeToken()
  }

  return (
    <div className="flex flex-col gap-[16px] text-primary" data-testid="access-section">
      {state.error === null
        ? null
        : <div className="text-[12px] leading-[18px] text-error" role="alert" data-testid="access-error">{state.error}</div>}
      {status.error === undefined
        ? null
        : <div className="text-[12px] leading-[18px] text-error" data-testid="access-state-error">{status.error}</div>}
      {status.warnings === undefined || status.warnings.length === 0
        ? null
        : <ul className="m-0 flex list-none flex-col gap-[4px] p-0 text-[12px] leading-[18px] text-warn" data-testid="access-warning">{status.warnings.map(line => <li key={line}>{line}</li>)}</ul>}

      <div className="text-[12px] leading-[18px] text-secondary" data-testid="access-page-hint">{t('access.page.hint')}</div>

      <Card>
        <Row title={t('access.lan.title')} hint={t('access.lan.hint')}>
          <span className="inline-flex" data-testid="access-toggle">
            <Switch checked={status.enabled} label={t('access.lan.title')} disabled={busy} onChange={(next) => { void setExposure(next) }} />
          </span>
        </Row>
        {status.enabled
          ? (
              <>
                <Row title={t('access.listen.address')} hint={t('access.lan.addressHint')}>
                  <div data-testid="access-lan-address">
                    <Select options={addressOptionsOf(status, t)} value={address} label={t('access.listen.address')} disabled={busy} onChange={next => setLanDraft({ address: next })} />
                  </div>
                </Row>
                {dirtyLan
                  ? (
                      <div className="flex items-center justify-end gap-[24px] border-b-[0.5px] border-border-l2 py-[12px]" data-testid="access-lan-draft">
                        <div className="flex flex-none items-center gap-[8px]">
                          <Button variant="outline" size="sm" data-testid="access-lan-cancel" disabled={busy} onClick={() => setLanDraft(null)}>{t('access.draft.cancel')}</Button>
                          <Button variant="primary" size="sm" data-testid="access-lan-save" disabled={busy} onClick={() => { void saveLan() }}>{t('access.draft.save')}</Button>
                        </div>
                      </div>
                    )
                  : null}
              </>
            )
          : null}
      </Card>

      <Card>
        <Row title={t('access.tunnel.title')} hint={t('access.tunnel.intro')}>
          <span className="inline-flex" data-testid="access-tunnel-toggle">
            <Switch checked={tunnelOpen} label={t('access.tunnel.title')} disabled={busy} onChange={(next) => { void setTunnelEnabled(next) }} />
          </span>
        </Row>
        {tunnelOpen
          ? (
              <>
                <Row title={t('access.tunnel.mode')} hint={t('access.tunnel.modeHint')}>
                  <div data-testid="access-tunnel-mode">
                    <SegmentedControl
                      id="dsh-tauri-remote-access-tunnel-mode"
                      label={t('access.tunnel.mode')}
                      options={[{ value: 'quick', label: t('access.tunnel.mode.quick') }, { value: 'token', label: t('access.tunnel.mode.token') }]}
                      value={tunnelForm.mode}
                      disabled={busy}
                      onChange={(next) => { editTunnel({ mode: next === 'token' ? 'token' : 'quick' }) }}
                    />
                  </div>
                </Row>
                {tunnelForm.mode === 'token'
                  ? (
                      <>
                        <Row title={t('access.tunnel.token')} hint={t('access.tunnel.tokenHint')}>
                          <Input
                            type="password"
                            name="tunnel-token"
                            autoComplete="off"
                            aria-label={t('access.tunnel.token')}
                            data-testid="access-tunnel-token"
                            placeholder={t(tunnel.token === null || tunnel.token === undefined || tunnel.token === '' ? 'access.tunnel.tokenPlaceholder' : 'access.tunnel.tokenSaved')}
                            value={tunnelForm.token ?? ''}
                            disabled={busy}
                            onChange={event => editTunnel({ token: event.target.value === '' ? (tunnel.token ?? null) : event.target.value })}
                          />
                        </Row>
                        <Row title={t('access.tunnel.hostname')} hint={t('access.tunnel.hostnameHint')}>
                          <Input
                            name="tunnel-hostname"
                            autoComplete="off"
                            aria-label={t('access.tunnel.hostname')}
                            data-testid="access-tunnel-hostname"
                            value={tunnelForm.hostname}
                            disabled={busy}
                            onChange={event => editTunnel({ hostname: event.target.value })}
                          />
                        </Row>
                      </>
                    )
                  : null}
                {missing === 'hostname'
                  ? <div className="pt-[12px] pb-[12px] text-[12px] leading-[18px] text-warn" data-testid="access-tunnel-hint">{t('access.tunnel.hostnameRequired')}</div>
                  : null}
                <Row title={t('access.tunnel.state')}>
                  <div className="flex flex-none items-center gap-[8px]" data-testid="access-tunnel-actions">
                    {downloading
                      ? null
                      : (
                          <span className="inline-flex items-center gap-[6px] text-[12px] leading-[18px] text-secondary" data-testid="access-tunnel-state">
                            {tunnelKeyOf(tunnel) === 'access.tunnel.state.running' ? <StateDot state="done" size={6} /> : null}
                            {t(tunnelKeyOf(tunnel))}
                          </span>
                        )}
                    {dirtyTunnel
                      ? (
                          <>
                            <Button variant="outline" size="sm" data-testid="access-tunnel-cancel" disabled={busy} onClick={() => setTunnelDraft(null)}>{t('access.draft.cancel')}</Button>
                            <Button variant="primary" size="sm" data-testid="access-tunnel-save" disabled={busy || missing !== undefined} onClick={() => { void submitTunnel(tunnelForm, tunnel) }}>{t('access.draft.save')}</Button>
                          </>
                        )
                      : (
                          <>
                            <Button variant="outline" size="sm" data-testid="access-tunnel-start" disabled={busy || tunnelLive || missing !== undefined} onClick={() => { void submitTunnel(tunnelForm, tunnel) }}>{t(tunnel.state === 'error' ? 'access.tunnel.retry' : 'access.tunnel.start')}</Button>
                            {tunnelLive || tunnel.state === 'error'
                              ? <Button variant="ghost" size="sm" data-testid="access-tunnel-stop" disabled={busy} onClick={() => { void service.stopTunnel() }}>{t('access.tunnel.stop')}</Button>
                              : null}
                          </>
                        )}
                  </div>
                </Row>
                {!downloading || tunnel.progress === undefined
                  ? null
                  : (
                      <div className="flex flex-col gap-[6px] pt-[12px] pb-[12px]" data-testid="access-tunnel-progress">
                        <span className="text-[12px] leading-[18px] text-secondary" data-testid="access-tunnel-progress-line">
                          {progressPercent === null ? t(progressKeyOf(tunnel.progress)) : `${t(progressKeyOf(tunnel.progress))} ${progressPercent}%`}
                        </span>
                        <div className="h-[6px] w-full overflow-hidden rounded-[3px] bg-layer-3" data-testid="access-tunnel-progress-bar">
                          <div className="h-full rounded-[3px] bg-brand transition-[width] duration-200" style={{ width: `${progressPercent ?? 0}%` }} />
                        </div>
                      </div>
                    )}
                {tunnel.error === undefined
                  ? null
                  : <div className="pt-[12px] pb-[12px] text-[12px] leading-[18px] text-error" role="alert" data-testid="access-tunnel-error">{tunnel.error}</div>}
              </>
            )
          : null}
      </Card>

      <Card>
        <Row title={t('access.control.title')} hint={t('access.control.hint')}>
          <Button variant="ghost" size="sm" data-testid="access-token-revoke" disabled={busy} onClick={revokeToken}>{t('access.token.revoke')}</Button>
        </Row>
        <Row title={t('access.pairing.title')} hint={t('access.pairing.hint')}>
          <div className="flex flex-none items-center gap-[8px]" data-testid="access-pairing">
            {pairing === undefined
              ? <span className="text-[12px] leading-[18px] text-secondary" data-testid="access-pairing-code">{t('access.pairing.none')}</span>
              : (
                  <>
                    <span className="text-[12px] leading-[18px] text-secondary" data-testid="access-pairing-countdown">
                      {countdown === '' ? t('access.pairing.expired') : `${t('access.pairing.remaining')} ${countdown}`}
                    </span>
                    <code className="border-l-[0.5px] border-border-l2 pl-[8px] text-[14px] leading-[20px] tracking-[2px]" data-testid="access-pairing-code">{pairing.code}</code>
                  </>
                )}
          </div>
        </Row>
        <Row title={t('access.token.title')} hint={t('access.token.hint')}>
          <div className="flex flex-none items-center gap-[8px]" data-testid="access-permanent">
            {token === undefined
              ? <Button variant="outline" size="sm" data-testid="access-token-rotate" disabled={busy} onClick={issueToken}>{t('access.token.generate')}</Button>
              : (
                  <>
                    <Button variant="outline" size="sm" data-testid="access-permanent-reveal" aria-pressed={revealed} aria-label={t(revealed ? 'access.token.hide' : 'access.token.reveal')} onClick={() => setRevealed(value => !value)}>{t(revealed ? 'access.token.hide' : 'access.token.reveal')}</Button>
                    <code className="border-l-[0.5px] border-border-l2 pl-[8px] text-[14px] leading-[20px] tracking-[2px]" data-testid="access-permanent-value">{revealed ? token : '••••••••'}</code>
                  </>
                )}
          </div>
        </Row>
      </Card>
    </div>
  )
}
