import { Toast, useToast } from 'heroui-native/toast'
import { useEffect, useRef } from 'react'
import { View } from 'react-native'
import { useStore } from 'valtio-define'
import { useAppState } from '@/hooks/use-app-state'
import { i18n } from '@/i18n'
import { appUpdate } from '@/store/modules/app-update'

export function useAppUpdate(): void {
  const appState = useAppState()
  const { toast } = useToast()
  const state = useStore(appUpdate)
  const notifiedVersionRef = useRef<string | null>(null)

  // keep:effect 更新检查是外部网络副作用：挂载查一次，回到前台再查。
  useEffect(() => {
    if (appState === 'active')
      void appUpdate.check()
  }, [appState])

  useEffect(() => {
    const version = state.latestVersion
    if (!version || !state.hasUpdate || state.ignoredVersion === version || notifiedVersionRef.current === version)
      return
    notifiedVersionRef.current = version
    toast.show({
      id: 'app-update',
      duration: 'persistent',
      component: props => (
        <Toast {...props} className="gap-3">
          <View className="gap-1">
            <Toast.Title>{i18n.t('update.title')}</Toast.Title>
            <Toast.Description>{i18n.t('update.description', { version })}</Toast.Description>
          </View>
          <View className="flex-row justify-end gap-2">
            <Toast.Action
              onPress={() => {
                void appUpdate.openDownload()
                props.hide(props.id)
              }}
            >
              {i18n.t('update.now')}
            </Toast.Action>
            <Toast.Action
              variant="ghost"
              onPress={() => {
                appUpdate.dismiss()
                props.hide(props.id)
              }}
            >
              {i18n.t('update.later')}
            </Toast.Action>
          </View>
        </Toast>
      ),
    })
  }, [state.hasUpdate, state.ignoredVersion, state.latestVersion, toast])
}
