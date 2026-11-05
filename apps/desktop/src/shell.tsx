/* eslint-disable react-refresh/only-export-components -- 注入入口，不参与 HMR 组件替换 */
import { OverlaysProvider } from '@overlastic/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ToastProvider } from '@/components/toast-provider'
import { queryClient } from '@/config/client'
import { resolveTheme } from '@/hooks/use-theme-adaptive'
import { App } from '@/layout'
import '@/utils/logger'
import './styles/main.css'

interface ShellEnv {
  __DSH_SHELL_CSS__?: string
  __DSH_SHELL_THEME__?: string
}

const HOST_ATTRIBUTE = 'data-dsh-shell-host'
const MOUNT_ID = 'dsh-shell-root'
const PORTAL_ID = 'dsh-shell-portal'

function ShellRoot() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <OverlaysProvider>
          <App />
        </OverlaysProvider>
      </ToastProvider>
    </QueryClientProvider>
  )
}

/** 主世界的注入脚本调用：确保 Shadow host 与挂载点已就绪。 */
function ensureHostRoot(): void {
  if (document.querySelector(`[${HOST_ATTRIBUTE}]`) !== null)
    return
  const env = globalThis as ShellEnv
  if (env.__DSH_SHELL_CSS__ === undefined)
    return
  const root = document.documentElement
  if (root === null)
    return
  const host = document.createElement('div')
  host.setAttribute(HOST_ATTRIBUTE, '')
  host.setAttribute('data-theme', root.dataset.theme === 'dark' ? 'dark' : 'light')
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000'
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = env.__DSH_SHELL_CSS__
  const mount = document.createElement('div')
  mount.id = MOUNT_ID
  mount.style.cssText = 'pointer-events:none'
  const portal = document.createElement('div')
  portal.id = PORTAL_ID
  portal.style.cssText = 'pointer-events:none'
  shadow.append(style, mount, portal)
  root.append(host)
  new MutationObserver(() => {
    host.setAttribute('data-theme', root.dataset.theme === 'dark' ? 'dark' : 'light')
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] })
}

/**
 * 渲染整棵壳层 UI。
 *
 * 生产：主窗口文档即 DSH，注入脚本先备好 Shadow host，这里把壳层渲染进去，与 DSH
 * 双向隔离。页内加载：没有注入样式，渲染进 `#root` 的 light DOM。
 */
function start(): void {
  if (typeof document === 'undefined')
    return
  if (document.readyState === 'loading' || document.documentElement === null) {
    document.addEventListener('DOMContentLoaded', start, { once: true })
    return
  }
  ensureHostRoot()
  const shadow = document.querySelector(`[${HOST_ATTRIBUTE}]`)?.shadowRoot
  // 文档即 DSH 时只渲染进注入的 Shadow host：落到 DSH 自己的 `#root` 会把壳层塞进
  // DSH 容器并遮住整页。没有注入样式才视为壳层页，用 `#root` 兜底。
  const hosted = (globalThis as ShellEnv).__DSH_SHELL_CSS__ !== undefined
  const mount = hosted
    ? shadow?.getElementById(MOUNT_ID)
    : document.getElementById('root')
  if (mount === null || mount === undefined)
    return
  createRoot(mount).render(createElement(ShellRoot))
}

document.documentElement.dataset.theme = resolveTheme(
  undefined,
  window.matchMedia('(prefers-color-scheme: dark)').matches,
)

start()
