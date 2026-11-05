import type { DshPlugin } from '@/types'
import { useEventListener, useIntervalFn, useMount, useWatch } from '@reause/core'
import { useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { queryKeys } from '@/config/query-keys'
import { useListen } from '@/hooks/use-listen'
import { useThemeAdaptive } from '@/hooks/use-theme-adaptive'
import { useWakelockRelease } from '@/hooks/use-wakelock-release'
import { toast } from '@/utils/toast'
import { store } from '../store'
import { Recovery } from '../ui/plugin/recovery'
import { Webview } from './components/webview'
import { useFrameChrome } from './components/window-chrome'
import '../i18n'

const DESKTOP_UPDATE_POLL_INTERVAL = 10 * 60_000

interface DownloadFinishedPayload {
  url: string
  path: string | null
  success: boolean
}

export function App() {
  const queryClient = useQueryClient()
  useListen<DshPlugin[]>('dsh-plugins-updated', ({ payload }) => {
    queryClient.setQueryData(queryKeys.plugins, payload)
  })

  const { t } = useTranslation()
  const { status } = useStore(store.harness)
  const { hydrated: settingReady, auto_update: autoUpdate } = useStore(store.setting)
  const { updateInfo, updating } = useStore(store.harnessUpdater)

  useWakelockRelease()
  useThemeAdaptive()
  useFrameChrome()

  useEventListener('keydown', (event: KeyboardEvent) => {
    if (!import.meta.env.DEV)
      return
    if (!event.ctrlKey || !event.shiftKey)
      return
    if (event.code === 'Digit1') {
      event.preventDefault()
      store.recovery.setRuntimeRecovery({
        plugins: ['dsh-better-sidebar'],
        reason: 'slot_conflict',
        detail: 'sidebar',
        rawError: 'Preview: dsh-better-sidebar reported a UI slot conflict.',
      })
    }
    else if (event.code === 'Digit2') {
      event.preventDefault()
      store.harness.fail('Preview: plugin startup failure')
      store.recovery.setRuntimeRecovery({
        plugins: ['dsh-better-sidebar'],
        reason: 'duplicate_loader_entry',
        detail: 'dshSidebarApi',
        rawError: 'Preview: duplicate loader entry id: dshSidebarApi',
      })
    }
  })

  useMount(() => store.harness.startup())

  const autoCheckUpdate = settingReady && autoUpdate
  function checkDesktopUpdate() {
    if (!store.setting.hydrated || !store.setting.auto_update)
      return
    void store.desktopUpdater.check().catch(() => {})
  }
  useWatch([autoCheckUpdate], checkDesktopUpdate, { immediate: true })
  useIntervalFn(checkDesktopUpdate, DESKTOP_UPDATE_POLL_INTERVAL)

  const toastKeyRef = useRef<string | null>(null)
  useListen<DownloadFinishedPayload>('harness-download-finished', ({ payload }) => {
    if (status !== 'ready')
      return
    if (toastKeyRef.current)
      toast.close(toastKeyRef.current)
    const { success, path } = payload
    toastKeyRef.current = toast(success ? t('download.saved') : t('download.failed'), {
      description: success && path
        ? (
            <div className="truncate max-w-[300px]">
              {`${t('download.saved_to')}: ${path}`}
            </div>
          )
        : undefined,
      placement: 'bottom end',
      actionProps: success && path
        ? {
            children: t('download.show_in_folder'),
            variant: 'tertiary',
            onPress: () => {
              if (toastKeyRef.current)
                toast.close(toastKeyRef.current)
              void invoke('reveal_in_folder', { path }).catch((err) => {
                console.error('[Harness] reveal_in_folder failed:', err)
              })
            },
          }
        : undefined,
      onClose: () => {
        toastKeyRef.current = null
      },
    })
  })

  useWatch([updateInfo, updating], () => {
    if (!updateInfo || updating)
      return
    store.harnessUpdater.showToast(() => store.harnessUpdater.handleUpdate())
  }, { immediate: true })

  return (
    <div className="flex h-screen w-screen" data-testid="dsh-shell-root">
      <Webview />
      {}
      <If cond={status === 'ready'}>
        <Recovery />
      </If>
    </div>
  )
}
