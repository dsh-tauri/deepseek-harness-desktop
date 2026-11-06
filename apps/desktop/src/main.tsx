import { OverlaysProvider } from '@overlastic/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ToastProvider } from '@/components/toast-provider'
import { queryClient } from '@/config/client'
import { resolveTheme } from '@/hooks/use-theme-adaptive'
import { App } from '@/layout'
import { isHostedServiceDocument } from '@/utils/window-presentation'
import { startShell } from './shell'
import '@/utils/logger'
import './styles/main.css'

/**
 * 壳层入口，两条分支：
 *
 * 1. **文档即 DSH**（生产主路径）：当前 webview 加载的就是本机 DSH 页面，壳层由 `./shell`
 *    渲染进注入脚本备好的 Shadow root，与 DSH 双向隔离。
 * 2. **独立壳层页**（dev）：当前文档只是壳层页，DSH 由页面内的 `<webview>` 标签承载。
 *    壳层本身是可热更新的普通 React 树，改组件即时生效，不必重新 `build:shell` +
 *    重启进程；DSH 放在 webview 里单独加载，其刷新不影响壳层。
 *
 * 判据不能用「Shadow host 是否已存在」——host 正是壳层自己创建的，那样永远走不到第一条
 * 分支。改用「当前文档是否就是 DSH 页面」（注入的服务 origin 与 location 一致）。
 */
const hosted = isHostedServiceDocument()

if (hosted) {
  startShell()
}
else {
  document.documentElement.dataset.theme = resolveTheme(
    undefined,
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <OverlaysProvider>
            <App />
          </OverlaysProvider>
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  )
}
