import { QueryClientProvider } from '@tanstack/react-query'
import { router, Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { HeroUINativeProvider } from 'heroui-native/provider'
import { useEffect } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { queryClient } from '@/config/client'
import { useHostsHealth } from '@/hooks/use-hosts-health'
import { useNotifications } from '@/hooks/use-notifications'
import { connection } from '@/store/modules/connection'
import { connectAddress, startAutoScan, stopConnectionRuntime } from '@/store/modules/connection/runtime'
import { bindConnectionPersistence, restoreConnections } from '@/store/modules/connection/storage'
import '../global.css'

function RootNavigator() {
  useNotifications()
  // 已保存主机的健康轮询（含前台重取）由 React Query 托管，见 hooks/use-hosts-health.ts。
  useHostsHealth()
  // keep:effect Own hydration, persistence, cancellable discovery and notification focus.
  useEffect(() => {
    let disposed = false
    let unsubscribePersistence = () => {}
    function focusRequested() {
      const focus = connection.pendingFocus
      if (!connection.hydrated || !focus)
        return
      let entry = connection.current
      if (entry?.id !== focus.origin)
        entry = connection.history.find(entry => entry.id === focus.origin) ?? null
      if (!entry) {
        connection.queueFocus(null)
        return
      }
      router.dismissTo('/')
      connection.setDrawerOpen(false)
      if (connection.current?.id !== focus.origin)
        connectAddress(entry)
    }
    const unsubscribeFocus = connection.$subscribeKey('focusGeneration', focusRequested)
    async function initialize() {
      await restoreConnections()
      if (disposed)
        return
      unsubscribePersistence = bindConnectionPersistence()
      focusRequested()
      // 历史连接交给可取消的扫描自动接入；其余情况（无历史 / 已在连接中）由健康查询立即探测一次。
      if (connection.stage === 'idle' && connection.history.length > 0)
        void startAutoScan({ historyOnly: true })
    }
    void initialize()
    return () => {
      disposed = true
      unsubscribeFocus()
      unsubscribePersistence()
      stopConnectionRuntime()
    }
  }, [])

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <HeroUINativeProvider config={{ devInfo: { stylingPrinciples: false } }}>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="scan" options={{ presentation: 'fullScreenModal' }} />
          </Stack>
        </HeroUINativeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <RootNavigator />
    </QueryClientProvider>
  )
}
