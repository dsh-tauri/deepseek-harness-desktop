import { OverlaysProvider } from '@overlastic/react'
import { QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { startToastActionBridge } from '@/utils/toast'
import { queryClient } from './config/client'
import { resolveTheme } from './hooks/use-theme-adaptive'
import { App } from './layout'
import '@/utils/logger'
import './styles/main.css'

document.documentElement.dataset.theme = resolveTheme(
  undefined,
  window.matchMedia('(prefers-color-scheme: dark)').matches,
)

// 透明 toast 窗口里点的操作按钮会把 action id 回传到壳层，这里注册一次执行原回调。
startToastActionBridge()

// 壳层不再渲染 toast：Harness 是原生子视图，会整块盖住壳层 DOM，只有独立的透明
// 置顶窗口才看得见（issue #1408）。toast 全部由 `toast.html` 那个窗口呈现。
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <OverlaysProvider>
        <App />
      </OverlaysProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
