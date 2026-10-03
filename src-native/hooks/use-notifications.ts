import * as Notifications from 'expo-notifications'
import { useEffect } from 'react'
import { AppState, Platform } from 'react-native'
import { NOTIFICATION_CHANNEL } from '@/config/constants'
import { i18n } from '@/i18n'
import { connection } from '@/store/modules/connection'
import { isRecord, parseQrPayload } from '@/utils/bridge-protocol'
import { createNotificationDispatcher, createResponseCoalescer } from '@/utils/notification-policy'

const silentChannel = `${NOTIFICATION_CHANNEL}-silent`
let channelsReady: Promise<void> | undefined

function prepareChannels(): Promise<void> {
  if (Platform.OS !== 'android')
    return Promise.resolve()
  channelsReady ??= Promise.all([
    Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL, {
      name: i18n.t('notification.channel'),
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      vibrationPattern: [0, 200],
    }),
    Notifications.setNotificationChannelAsync(silentChannel, {
      name: i18n.t('notification.channelSilent'),
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: null,
      enableVibrate: false,
    }),
  ]).then(() => {}).catch((error) => {
    channelsReady = undefined
    throw error
  })
  return channelsReady
}

const dispatcher = createNotificationDispatcher({
  isForeground: () => AppState.currentState === 'active',
  async checkPermission() {
    await prepareChannels()
    return (await Notifications.getPermissionsAsync()).granted
  },
  async requestPermission() {
    if (AppState.currentState !== 'active')
      return false
    return (await Notifications.requestPermissionsAsync()).granted
  },
  async deliver(message, origin, identifier) {
    let trigger: Notifications.NotificationTriggerInput = null
    if (Platform.OS === 'android') {
      let channelId = NOTIFICATION_CHANNEL
      if (message.silent)
        channelId = silentChannel
      trigger = { channelId }
    }
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: {
        title: message.title,
        body: message.body,
        sound: !message.silent,
        data: { origin, sessionId: message.sessionId, title: message.title, tag: message.tag },
      },
      trigger,
    })
  },
  reportError(message, error) {
    console.error(message, error)
  },
})

export const sendNativeNotification = dispatcher.notify
export const requestNotificationAccess = dispatcher.ensurePermission

export function useNotifications(): void {
  // keep:effect Register and dispose native notification presentation and response listeners.
  useEffect(() => {
    const acceptResponse = createResponseCoalescer()
    let disposed = false
    let warmResponseReceived = false
    Notifications.setNotificationHandler({
      async handleNotification(notification) {
        const background = AppState.currentState !== 'active'
        return {
          shouldShowBanner: background,
          shouldShowList: background,
          shouldPlaySound: background && notification.request.content.sound !== null,
          shouldSetBadge: false,
        }
      },
    })
    function handleResponse(response: Notifications.NotificationResponse): boolean {
      if (disposed || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER)
        return false
      const data: unknown = response.notification.request.content.data
      if (!isRecord(data) || typeof data.origin !== 'string')
        return false
      const address = parseQrPayload(data.origin)
      if (!address || address.id !== data.origin)
        return false
      const key = `${response.notification.request.identifier}:${response.notification.date}:${response.actionIdentifier}`
      if (!acceptResponse(key))
        return true
      connection.queueFocus({
        origin: address.id,
        sessionId: typeof data.sessionId === 'string' ? data.sessionId.slice(0, 256) : '',
        title: typeof data.title === 'string' ? data.title.slice(0, 256) : '',
        tag: typeof data.tag === 'string' ? data.tag.slice(0, 256) : '',
      })
      void Notifications.clearLastNotificationResponseAsync().catch(error => console.error('[notification] clear response failed:', error))
      return true
    }
    const responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
      if (handleResponse(response))
        warmResponseReceived = true
    })
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response && !warmResponseReceived)
          handleResponse(response)
      })
      .catch(error => console.error('[notification] restore response failed:', error))
    return () => {
      disposed = true
      responseSubscription.remove()
      Notifications.setNotificationHandler(null)
    }
  }, [])
}
