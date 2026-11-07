import { OverlaysProvider } from '@overlastic/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ToastProvider } from '@/components/toast-provider'
import { queryClient } from '@/config/client'
import { getInitialTheme } from '@/hooks/use-theme-adaptive'
import { App } from '@/layout'
import '@/utils/logger'
import './styles/main.css'

/**
 * 壳层入口，两条分支：
 *
 * 1. **注入形态**（生产）：Rust 侧 `ShellInjection` 已把 `shell.mjs` 载入并调用
 *    `startShell()`，壳层渲染进 Shadow root，与 DSH 双向隔离。此时本文件不再挂载任何
 *    东西——否则会同时出现 Shadow 里和 `#root` 里两套壳层，两层全屏 UI 互相遮挡，
 *    Playwright 会报「某层拦截点击 / 两个相同的按钮」。
 * 2. **独立壳层页**（dev / 未注入）：当前文档只是壳层页，DSH 由页面内 `<webview>` 承载。
 *    壳层是普通可热更新 React 树，改组件即时生效；DSH 在 webview 里单独加载。
 *
 * 判据用 `__DSH_SHELL_THEME__`：只有 `ShellInjection` 会写它。不能用「Shadow host 是否
 * 已存在」（host 是壳层自己创建的，恒 false），也不能用 origin（壳层页与 DSH 页同源）。
 */
const injected = typeof (globalThis as { __DSH_SHELL_THEME__?: unknown }).__DSH_SHELL_THEME__ === 'string'

if (!injected) {
  document.documentElement.dataset.theme = getInitialTheme()

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
