import type { ShouldStartLoadRequest, WebViewMessageEvent } from 'react-native-webview/lib/WebViewTypes'
import type { NotificationFocus } from '@/store/modules/connection'
import type { BridgeAddress } from '@/utils/bridge-protocol'
import { useWhenever } from '@reause/core'
import { randomUUID } from 'expo-crypto'
import { useNavigation } from 'expo-router'
import { Button } from 'heroui-native/button'
import { useThemeColor } from 'heroui-native/hooks'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If, Then } from 'react-if-lite'
import { BackHandler, Linking, Modal, Pressable, Text, View } from 'react-native'
import { ArrowLeft, Hand } from 'react-native-lucide'
import { SafeAreaView } from 'react-native-safe-area-context'
import { WebView } from 'react-native-webview'
import { Uniwind } from 'uniwind'
import { useStore } from 'valtio-define'
import { BreathingLight } from '@/components/breathing-light'
import { WEBVIEW_LOAD_TIMEOUT_MS } from '@/config/constants'
import { useAppState } from '@/hooks/use-app-state'
import { requestNotificationAccess, sendNativeNotification } from '@/hooks/use-notifications'
import { connection } from '@/store/modules/connection'
import { connectAddress, refreshHealth } from '@/store/modules/connection/runtime'
import { buildConnectUrl, isTrustedOrigin } from '@/utils/bridge-protocol'
import { createNotificationShim, nativeMessageScript, parseNativeMessage } from '@/utils/webview-bridge'

export function BridgeWebView({ address, generation }: { address: BridgeAddress, generation: number }) {
  const ref = useRef<WebView>(null)
  const { t } = useTranslation()
  const [nonce] = useState(randomUUID)
  const mainUrlRef = useRef(buildConnectUrl(address))
  const canGoBackRef = useRef(false)
  const focusRequestRef = useRef<{ requestId: string, focus: NotificationFocus } | null>(null)
  const documentReadyRef = useRef(false)
  const [documentReady, setDocumentReady] = useState(false)
  const [documentGeneration, setDocumentGeneration] = useState(0)
  const state = useStore(connection)
  const navigation = useNavigation()
  const appState = useAppState()
  const background = useThemeColor('background')
  const shim = createNotificationShim(address.id, nonce)
  // keep:effect Mirror native visibility into the authenticated loaded document.
  useEffect(() => {
    if (!documentReady || state.loadError)
      return
    ref.current?.injectJavaScript(nativeMessageScript(address.id, nonce, {
      type: 'dsh://visibility-state',
      hidden: appState !== 'active',
    }))
  }, [address.id, appState, documentReady, nonce, state.loadError])
  // keep:whenever Request native notification access as soon as a verified document reaches the foreground.
  useWhenever(documentReady && !state.loadError && appState === 'active', () => void requestNotificationAccess())
  // keep:effect Keep notification focus pending until the loaded page acknowledges selection.
  useEffect(() => {
    const focus = state.pendingFocus
    if (!documentReady || state.loadError || focus?.origin !== address.id || appState !== 'active')
      return
    const requestId = randomUUID()
    const webView = ref.current
    focusRequestRef.current = { requestId, focus }
    webView?.injectJavaScript(nativeMessageScript(address.id, nonce, {
      type: 'dsh://focus-session',
      requestId,
      sessionId: focus.sessionId,
      title: focus.title,
      tag: focus.tag,
    }))
    connection.setDrawerOpen(false)
    return () => {
      webView?.injectJavaScript(nativeMessageScript(address.id, nonce, { type: 'dsh://cancel-focus', requestId }))
      if (focusRequestRef.current?.requestId === requestId)
        focusRequestRef.current = null
    }
  }, [address.id, appState, documentReady, nonce, state.loadError, state.pendingFocus, state.focusGeneration])
  // keep:effect Bound a silent or non-DSH WebView load without mistaking Android's finish event for success.
  useEffect(() => {
    if (documentReady || state.loadError)
      return
    const timeout = setTimeout(() => connection.markLoadFailed(generation, t('connection.connectionFailed')), WEBVIEW_LOAD_TIMEOUT_MS)
    return () => clearTimeout(timeout)
  }, [documentGeneration, documentReady, generation, state.loadError, t])
  // keep:effect Route Android back to WebView history without consuming an open drawer's back event.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!navigation.isFocused() || connection.drawerOpen || !canGoBackRef.current)
        return false
      ref.current?.goBack()
      return true
    })
    return () => subscription.remove()
  }, [navigation])
  async function openExternal(raw: string) {
    try {
      const url = new URL(raw)
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password)
        await Linking.openURL(url.toString())
    }
    catch {
      connection.setNotice(t('connection.connectionFailed'))
    }
  }
  function allowNavigation(request: ShouldStartLoadRequest): boolean {
    if (request.isTopFrame === false)
      return true
    if (isTrustedOrigin(request.url, address.id)) {
      mainUrlRef.current = request.url
      return true
    }
    if (request.url === 'about:blank')
      return true
    void openExternal(request.url)
    return false
  }
  function handleMessage({ nativeEvent }: WebViewMessageEvent) {
    const message = parseNativeMessage(nativeEvent.data, nativeEvent.url, address.id, nonce)
    if (!message || generation !== connection.viewGeneration)
      return
    if (message.type === 'dsh://bridge-ready') {
      if (connection.loadError)
        return
      documentReadyRef.current = true
      setDocumentReady(true)
      connection.markLoaded(generation)
      return
    }
    if (!documentReadyRef.current || connection.loadError)
      return
    if (message.type === 'dsh://theme-state') {
      Uniwind.setTheme(message.theme)
      return
    }
    if (message.type === 'dsh://focus-result') {
      const request = focusRequestRef.current
      const pending = connection.pendingFocus
      if (!request || request.requestId !== message.requestId || !pending
        || pending.origin !== request.focus.origin || pending.sessionId !== request.focus.sessionId
        || pending.tag !== request.focus.tag || pending.title !== request.focus.title) {
        return
      }
      connection.queueFocus(null)
      if (!message.handled)
        connection.setNotice(t('connection.focusFailed'))
      return
    }
    void sendNativeNotification(message, address.id)
  }
  function loadingStarted(url: string, loading: boolean) {
    if (generation !== connection.viewGeneration || !isTrustedOrigin(url, address.id))
      return
    mainUrlRef.current = url
    if (!loading)
      return
    focusRequestRef.current = null
    documentReadyRef.current = false
    setDocumentReady(false)
    setDocumentGeneration(value => value + 1)
  }
  function loaded(url: string) {
    if (isTrustedOrigin(url, address.id))
      ref.current?.injectJavaScript(shim)
  }
  function openDrawer() {
    connection.dismissHint()
    connection.setDrawerOpen(true)
    void refreshHealth()
  }
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: background }} edges={['top', 'bottom']}>
      <View className="flex-1">
        <WebView
          ref={ref}
          source={{ uri: buildConnectUrl(address) }}
          style={{ flex: 1, backgroundColor: background }}
          injectedJavaScriptBeforeContentLoaded={shim}
          injectedJavaScript={shim}
          injectedJavaScriptForMainFrameOnly
          injectedJavaScriptBeforeContentLoadedForMainFrameOnly
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          mixedContentMode="never"
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={allowNavigation}
          onMessage={handleMessage}
          onLoadStart={event => loadingStarted(event.nativeEvent.url, event.nativeEvent.loading)}
          onLoad={event => loaded(event.nativeEvent.url)}
          onError={() => connection.markLoadFailed(generation, t('connection.connectionFailed'))}
          onHttpError={({ nativeEvent }) => {
            if (nativeEvent.statusCode >= 400 && nativeEvent.statusCode !== 401 && nativeEvent.url === mainUrlRef.current)
              connection.markLoadFailed(generation, t('connection.connectionFailed'))
          }}
          onNavigationStateChange={(navigation) => {
            canGoBackRef.current = navigation.canGoBack
            if (isTrustedOrigin(navigation.url, address.id))
              mainUrlRef.current = navigation.url
          }}
          onOpenWindow={({ nativeEvent }) => { void openExternal(nativeEvent.targetUrl) }}
          onRenderProcessGone={() => connection.markLoadFailed(generation, t('connection.connectionFailed'))}
          onContentProcessDidTerminate={() => connection.markLoadFailed(generation, t('connection.connectionFailed'))}
        />
        <If cond={state.notice && !state.drawerOpen}>
          <Then>
            <Pressable
              className="absolute left-3 right-3 top-3 rounded-xl border border-border bg-surface px-4 py-3"
              accessibilityRole="button"
              accessibilityLabel={state.notice ?? t('connection.connectionInfo')}
              onPress={openDrawer}
            >
              <Text className="text-sm leading-6 text-warning" accessibilityLiveRegion="polite">{state.notice}</Text>
            </Pressable>
          </Then>
        </If>
        <If cond={state.loading}>
          <Then>
            <View className="absolute inset-0 items-center justify-center gap-5 bg-background">
              <BreathingLight />
              <Text className="text-sm text-muted">{t('connection.loading')}</Text>
            </View>
          </Then>
        </If>
        <If cond={state.loadError}>
          <Then>
            <View className="absolute inset-0 items-center justify-center gap-5 bg-background px-8">
              <Text className="text-center text-base leading-7 text-foreground">{state.loadError}</Text>
              <Button onPress={() => connectAddress(address)}>{t('connection.reconnect')}</Button>
              <Button variant="ghost" onPress={openDrawer}>{t('connection.connectionInfo')}</Button>
            </View>
          </Then>
        </If>
        <If cond={documentReady && state.swipeHintVisible && !state.drawerOpen}>
          <Then>
            <Modal
              transparent
              visible
              statusBarTranslucent
              navigationBarTranslucent
              onRequestClose={() => connection.dismissHint()}
            >
              <Pressable
                className="flex-1 items-center justify-center gap-5 bg-black/60"
                accessibilityRole="button"
                accessibilityLabel={t('connection.swipeAccessibility')}
                onPress={() => connection.dismissHint()}
              >
                <View className="flex-row items-center gap-3">
                  <ArrowLeft size={34} color="#ffffff" />
                  <Hand size={52} color="#ffffff" strokeWidth={1.5} />
                </View>
                <Text className="text-base font-medium text-white">{t('connection.swipeHint')}</Text>
              </Pressable>
            </Modal>
          </Then>
        </If>
      </View>
    </SafeAreaView>
  )
}
