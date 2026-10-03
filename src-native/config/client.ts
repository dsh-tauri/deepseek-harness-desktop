import { focusManager, QueryClient } from '@tanstack/react-query'
import { AppState } from 'react-native'

/**
 * 用 React Native 的 AppState 驱动 React Query 的焦点状态：应用退到后台即视为失焦
 * （`refetchIntervalInBackground: false` 会暂停轮询），回到前台立即重取活跃查询。
 * 等价替代原先 `app/_layout.tsx` 里手写的 interval + AppState 监听。
 */
focusManager.setEventListener((handleFocus) => {
  const subscription = AppState.addEventListener('change', state => handleFocus(state === 'active'))
  return () => subscription.remove()
})

/** 局域网内直连主机的探测没有瞬时网络抖动的重试价值，失败即返回；超时与取消由 probeBridge 负责。 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
  },
})
