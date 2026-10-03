import { router, useNavigation } from 'expo-router'
import { Button } from 'heroui-native/button'
import { useThemeColor } from 'heroui-native/hooks'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Else, If, Then } from 'react-if-lite'
import { BackHandler, ScrollView, Text, useWindowDimensions, View } from 'react-native'
import { Drawer } from 'react-native-drawer-layout'
import { History, Radar, RefreshCw, ScanLine, X } from 'react-native-lucide'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStore } from 'valtio-define'
import { BreathingLight } from '@/components/breathing-light'
import { Dot } from '@/components/dot'
import { Logo, Wordmark } from '@/components/icons'
import { connection } from '@/store/modules/connection'
import { cancelAutoScan, connectAddress, disconnectAndScan, refreshHealth, startAutoScan } from '@/store/modules/connection/runtime'
import { BridgeWebView } from '@/ui/webview'
import { connectionLabel } from '@/utils/bridge-protocol'

function openScanner() {
  cancelAutoScan()
  connection.setDrawerOpen(false)
  router.push('/scan')
}

function openConnections() {
  if (connection.swipeHintVisible)
    connection.dismissHint()
  connection.setDrawerOpen(true)
  void refreshHealth()
}

function ConnectionDrawer() {
  const { t } = useTranslation()
  const state = useStore(connection)
  const [background, foreground, muted] = useThemeColor(['surface', 'foreground', 'muted'])
  let currentLabel: string = t('connection.noConnection')
  if (state.current)
    currentLabel = connectionLabel(state.current)
  let currentStatus: 'checking' | 'available' | 'unavailable' = 'checking'
  if (state.current)
    currentStatus = state.health[state.current.id] ?? 'checking'
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: background }} edges={['top', 'bottom', 'right']}>
      <View className="flex-row items-center justify-between px-5 pb-1 pt-2">
        <Text className="text-xl font-semibold text-foreground">{t('connection.connectionInfo')}</Text>
        <Button variant="ghost" isIconOnly isDisabled={!state.hydrated} accessibilityLabel={t('scan.scanQr')} onPress={openScanner}>
          <ScanLine size={22} color={foreground} />
        </Button>
      </View>
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 20, gap: 24, paddingBottom: 24 }}>
        <If cond={state.notice}>
          <Then><Text className="text-sm leading-6 text-warning" accessibilityLiveRegion="polite">{state.notice}</Text></Then>
        </If>
        <View className="gap-3">
          <Text className="text-sm font-semibold text-foreground">{t('connection.currentConnection')}</Text>
          <Button
            variant="ghost"
            className="h-auto min-h-16 justify-start gap-3 rounded-xl px-3 py-4"
            isDisabled={!state.current}
            accessibilityLabel={t('connection.reconnect')}
            accessibilityHint={`${currentLabel}，${t(`connection.${currentStatus}`)}`}
            onPress={() => {
              if (connection.current)
                connectAddress(connection.current)
            }}
          >
            <If cond={state.current}>
              <Then><Dot status={currentStatus} /></Then>
            </If>
            <Text className="flex-1 text-sm font-medium text-foreground" numberOfLines={1}>{currentLabel}</Text>
          </Button>
        </View>
        <View className="gap-3">
          <View className="flex-row items-center justify-between">
            <Text className="text-sm font-semibold text-foreground">{t('connection.recentConnections')}</Text>
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              isDisabled={!state.hydrated}
              accessibilityLabel={t('connection.refreshConnections')}
              onPress={() => { void refreshHealth() }}
            >
              <RefreshCw size={18} color={foreground} />
            </Button>
          </View>
          <If cond={state.recentFive.length > 0}>
            <Then>
              <View className="gap-2">
                {state.recentFive.map((entry) => {
                  const status = state.health[entry.id] ?? 'checking'
                  return (
                    <Button
                      key={entry.id}
                      variant="ghost"
                      className="h-auto min-h-16 justify-start gap-3 rounded-xl px-3 py-4"
                      accessibilityLabel={`${connectionLabel(entry)}，${t(`connection.${status}`)}`}
                      onPress={() => connectAddress(entry)}
                    >
                      <Dot status={status} />
                      <Text className="flex-1 text-sm font-medium text-foreground" numberOfLines={1}>{connectionLabel(entry)}</Text>
                    </Button>
                  )
                })}
              </View>
            </Then>
            <Else><Text className="py-4 text-sm text-muted">{t('connection.noHistory')}</Text></Else>
          </If>
        </View>
      </ScrollView>
      <View className="gap-3 border-t border-border px-5 pb-4 pt-5">
        <Button variant="danger" isDisabled={!state.current} onPress={disconnectAndScan}>{t('connection.disconnect')}</Button>
        <Button variant="ghost" accessibilityLabel={t('connection.closeDrawer')} onPress={() => connection.setDrawerOpen(false)}>
          <X size={18} color={muted} />
          <Button.Label>{t('connection.closeDrawer')}</Button.Label>
        </Button>
      </View>
    </SafeAreaView>
  )
}

export default function HomeScreen() {
  const { t } = useTranslation()
  const state = useStore(connection)
  const navigation = useNavigation()
  const { width } = useWindowDimensions()
  const [background, foreground, backdrop, accentForeground] = useThemeColor(['background', 'foreground', 'backdrop', 'accent-foreground'])
  const scanning = state.stage === 'scanning'
  let scanText: string = t('connection.scanning')
  if (state.history.length > 0)
    scanText = t('connection.checkingHistory')
  // keep:effect Give the native drawer first refusal for Android's back button.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!navigation.isFocused() || !connection.drawerOpen)
        return false
      connection.setDrawerOpen(false)
      return true
    })
    return () => subscription.remove()
  }, [navigation])
  function renderContent() {
    if (state.current)
      return <BridgeWebView key={state.viewGeneration} address={state.current} generation={state.viewGeneration} />
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: background }}>
        <View className="flex-1 items-center justify-center gap-7 px-8">
          <View className="items-center gap-3">
            <Logo />
            <Wordmark />
          </View>
          <If cond={scanning}>
            <Then>
              <BreathingLight />
              <Text className="text-center text-sm leading-6 text-muted" accessibilityLiveRegion="polite">{scanText}</Text>
              <Button variant="ghost" onPress={cancelAutoScan}>{t('common.cancel')}</Button>
            </Then>
          </If>
        </View>
        <If cond={!scanning}>
          <Then>
            <View className="gap-3 px-6 pb-6">
              <If cond={state.notice}><Then><Text className="pb-3 text-center text-sm leading-6 text-muted" accessibilityLiveRegion="polite">{state.notice}</Text></Then></If>
              <Button size="lg" isDisabled={!state.hydrated} onPress={() => { void startAutoScan() }}>
                <Radar size={20} color={accentForeground} />
                <Button.Label>{t('connection.autoScan')}</Button.Label>
              </Button>
              <Button variant="outline" size="lg" isDisabled={!state.hydrated} onPress={openScanner}>
                <ScanLine size={20} color={foreground} />
                <Button.Label>{t('scan.scanQr')}</Button.Label>
              </Button>
              <Button variant="outline" size="lg" isDisabled={!state.hydrated} onPress={openConnections}>
                <History size={19} color={foreground} />
                <Button.Label>{t('connection.recentConnections')}</Button.Label>
              </Button>
            </View>
          </Then>
        </If>
      </SafeAreaView>
    )
  }
  return (
    <Drawer
      open={state.drawerOpen}
      onOpen={openConnections}
      onClose={() => connection.setDrawerOpen(false)}
      drawerPosition="right"
      direction="ltr"
      drawerType="slide"
      drawerStyle={{ width: Math.min(width * 0.88, 384), backgroundColor: background }}
      overlayStyle={{ backgroundColor: backdrop }}
      overlayAccessibilityLabel={t('connection.closeDrawer')}
      swipeEdgeWidth={width}
      swipeEnabled={state.hydrated}
      renderDrawerContent={() => <ConnectionDrawer />}
      style={{ flex: 1 }}
    >
      {renderContent()}
    </Drawer>
  )
}
