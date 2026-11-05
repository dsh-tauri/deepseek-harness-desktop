import { useEventListener } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { useListen } from '@/hooks/use-listen'
import { Loadable } from '@/layout/startup/loadable'
import { store } from '@/store'
import { zoomActionFromShortcut } from '@/utils/zoom'

interface HarnessWebviewState {
  label: string
  loaded: boolean
  alive: boolean
  crashed: boolean
}

interface HarnessWebviewReservation {
  key: string
  label: string
}

export interface NativeWebviewProps {
  srcOverride?: string | null
  borderTint?: string | null
}

export function NativeWebview({ srcOverride = null, borderTint = null }: NativeWebviewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const lifecycleRef = useRef(Promise.resolve())
  const updatesRef = useRef(Promise.resolve())
  const syncRef = useRef<() => void>(undefined)
  const readyLabelRef = useRef<string | undefined>(undefined)
  const harness = useStore(store.harness)
  const setting = useStore(store.setting)
  const layoutRef = useRef({ showError: harness.showWebviewError, zoom: setting.zoom_factor })
  layoutRef.current = { showError: harness.showWebviewError, zoom: setting.zoom_factor }
  const { t } = useTranslation()
  const remoteMode = srcOverride !== null && srcOverride !== ''
  const mounted = remoteMode || harness.serviceHealthy
  const src = remoteMode ? srcOverride : harness.webviewSrc
  const generation = harness.webviewKey
  const requestKey = `${src}#${String(generation)}`
  const [prepared, setPrepared] = useState<HarnessWebviewReservation | null>(null)
  const [preparationError, setPreparationError] = useState('')
  const guest = prepared?.key === requestKey ? prepared : null

  useEffect(() => {
    if (!mounted || !src)
      return
    let disposed = false
    let activeLabel: string | undefined
    lifecycleRef.current = lifecycleRef.current.then(async () => {
      if (disposed)
        return
      setPreparationError('')
      const label = await invoke<string>('prepare_harness_webview', { url: src, navigation: (window as Window & { __DSH_NAVIGATION__?: unknown }).__DSH_NAVIGATION__ ?? null })
      activeLabel = label
      if (!disposed)
        setPrepared({ key: requestKey, label })
    }).catch((error) => {
      if (!disposed)
        setPreparationError(String(error))
    })
    return () => {
      disposed = true
      setPrepared(null)
      lifecycleRef.current = lifecycleRef.current.then(async () => {
        await updatesRef.current
        if (activeLabel)
          await invoke('release_harness_webview', { label: activeLabel })
      }).catch(error => console.error('[Webview] failed to release guest:', error))
    }
  }, [mounted, src, requestKey])

  useListen<HarnessWebviewState>('harness-webview-state', ({ payload }) => {
    if (guest === null || payload.label !== guest.label || store.harness.webviewKey !== generation)
      return
    const readyLabel = payload.loaded && !payload.crashed ? guest.label : undefined
    if (readyLabelRef.current !== readyLabel) {
      readyLabelRef.current = readyLabel
      syncRef.current?.()
    }
    if (remoteMode)
      return
    if (!payload.alive || payload.crashed)
      store.harness.markWebviewLeaving()
    if (payload.loaded && !payload.crashed)
      store.harness.markWebviewLoaded()
    if (payload.alive && !payload.crashed)
      store.harness.markWebviewAlive(generation)
    if (payload.crashed)
      store.harness.markWebviewError()
  }, { target: { kind: 'Window', label: getCurrentWindow().label } })

  useListen<{ label?: string, detail?: string }>('dsh://plugin-boot:failed', ({ payload }) => {
    if (remoteMode || guest === null || payload?.label !== guest.label || store.harness.webviewKey !== generation)
      return
    void store.harness.handleWebviewBootFailure(payload.detail)
  }, { target: { kind: 'Window', label: getCurrentWindow().label } })

  useEffect(() => {
    const host = hostRef.current
    if (host === null || guest === null)
      return
    let disposed = false
    let requested = ''
    let revision = 0
    let cancelPending: (() => void) | undefined
    function sync(): void {
      if (disposed)
        return
      const rect = host!.getBoundingClientRect()
      if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite))
        return
      const available = (remoteMode || !layoutRef.current.showError) && rect.width > 0 && rect.height > 0
      const devicePixelRatio = window.devicePixelRatio
      const zoomFactor = layoutRef.current.zoom
      const request = JSON.stringify([rect.left, rect.top, rect.width, rect.height, available, devicePixelRatio, zoomFactor])
      if (requested === request)
        return
      requested = request
      const ticket = ++revision
      cancelPending?.()
      updatesRef.current = updatesRef.current.then(async () => {
        if (disposed || ticket !== revision)
          return
        let frame: number | undefined
        let cancel!: () => void
        const cancelled = new Promise<undefined>((resolve) => {
          cancel = () => {
            if (frame !== undefined)
              cancelAnimationFrame(frame)
            resolve(undefined)
          }
        })
        cancelPending = cancel
        const current = () => !disposed && ticket === revision
        try {
          const scale = await Promise.race([getCurrentWindow().scaleFactor(), cancelled])
          if (!current() || scale === undefined)
            return
          const ratio = devicePixelRatio / scale
          if (!Number.isFinite(ratio) || ratio <= 0)
            return
          const bounds = { label: guest!.label, x: rect.left * ratio, y: rect.top * ratio, width: Math.max(1, rect.width * ratio), height: Math.max(1, rect.height * ratio), zoomFactor }
          await invoke('update_harness_webview', { ...bounds, visible: available })
        }
        finally {
          if (cancelPending === cancel)
            cancelPending = undefined
        }
      }).catch((error) => {
        requested = ''
        console.error('[Webview] failed to update native view:', error)
      })
    }
    syncRef.current = sync
    const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(sync)
    for (let element: HTMLElement | null = host; element; element = element.parentElement)
      resizeObserver?.observe(element)
    const mutationObserver = new MutationObserver(sync)
    mutationObserver.observe(document.body, { attributes: true, attributeFilter: ['aria-hidden', 'class', 'data-state', 'hidden', 'style'], childList: true, subtree: true })
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    sync()
    return () => {
      disposed = true
      cancelPending?.()
      syncRef.current = undefined
      resizeObserver?.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, [guest, remoteMode])

  useEffect(() => {
    syncRef.current?.()
  }, [harness.showWebviewError, setting.zoom_factor])

  function zoom(action: 'increase' | 'decrease' | 'reset') {
    void store.setting.zoom(action).catch(error => console.error('[Zoom] failed to save zoom:', error))
  }
  useEventListener('keydown', (event: KeyboardEvent) => {
    const action = zoomActionFromShortcut(event)
    if (action) {
      event.preventDefault()
      zoom(action)
    }
  }, { capture: true })

  useListen<{ action?: string }>('dsh://zoom-shortcut', ({ payload }) => {
    if (payload.action === 'increase' || payload.action === 'decrease' || payload.action === 'reset')
      zoom(payload.action)
  })
  useListen('dsh://appearance:ready', () => {
    if (!remoteMode)
      store.harness.markWebviewBootReady()
  })

  if (preparationError)
    return <Loadable errorMsg={preparationError} onRetry={() => store.harness.refreshWebview()} />
  if (!mounted || !guest)
    return <Loadable subtitle={t(harness.startupStatusKey)} />

  return (
    <div className="relative flex min-h-0 flex-1" style={borderTint ? { borderColor: borderTint, borderWidth: 2, borderStyle: 'solid' } : undefined}>
      <div ref={hostRef} data-testid="dsh-harness-webview" title="Harness" className="relative min-h-0 flex-1" />
      {!remoteMode && harness.showWebviewError && (
        <div className="absolute inset-0">
          <Loadable errorMsg={t('ui.webview_error')} onRetry={() => store.harness.refreshWebview()} />
        </div>
      )}
    </div>
  )
}
