/* eslint-disable react-refresh/only-export-components -- 注入入口，不参与 HMR 组件替换 */
import type { ReactNode } from 'react'
import { OverlaysProvider } from '@overlastic/react'
import { useMount } from '@reause/core'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement, useState } from 'react'
import { UNSAFE_PortalProvider } from 'react-aria'
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
const NEUTRALIZER_ATTRIBUTE = 'data-dsh-shell-drag-neutralizer'
const MOUNT_ID = 'dsh-shell-root'
const PORTAL_ID = 'dsh-shell-portal'

/**
 * 把壳层内的弹层挂载点交给 react-aria。
 *
 * HeroUI 的 Dropdown / Modal 内部走 react-aria 的 Overlay，默认 portal 到
 * `document.body`——那是 Shadow 外的 light DOM，拿不到壳层样式表，于是菜单、对话框
 * 渲染成无样式黑字。由 Provider 指定容器后，React 会把节点直接渲染进去；绝不能事后
 * 搬移 DOM 节点，那会打断 React 的节点表（`removeChild ... not a child of this node`）。
 */
function ShellRoot() {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  useMount(() => {
    setContainer(document.querySelector(`[${HOST_ATTRIBUTE}]`)?.shadowRoot?.getElementById(PORTAL_ID) ?? null)
  })
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <OverlaysProvider>
          <PortalTarget container={container}>
            <App />
          </PortalTarget>
        </OverlaysProvider>
      </ToastProvider>
    </QueryClientProvider>
  )
}

function PortalTarget({ container, children }: { container: HTMLElement | null, children: ReactNode }) {
  if (container === null)
    return children
  return (
    <UNSAFE_PortalProvider getContainer={() => container}>
      {children}
    </UNSAFE_PortalProvider>
  )
}

/**
 * 抵消 DSH 顶部的原生拖拽带。
 *
 * `[data-windows-titlebar] .frame::before` 在窗口顶部铺一条等高、`-webkit-app-region:
 * drag` 的带。Electron 的拖拽区在浏览器进程按几何合成，Shadow DOM 里声明的 `no-drag`
 * 不参与该计算，于是覆盖其上的壳层导航栏整条被算作拖拽区：按下有效、抬起被吞，click
 * 永不触发。这条规则落在 light DOM、且排在 DSH 样式之后，把那条带还原成普通区域。
 */
function createDragNeutralizer(): HTMLStyleElement {
  const element = document.createElement('style')
  element.setAttribute(NEUTRALIZER_ATTRIBUTE, '')
  element.textContent
    = '[data-windows-titlebar] [class*="frame"]::before{-webkit-app-region:no-drag;app-region:no-drag}'
  return element
}

/**
 * 修正 DSH 顶层浮层的让位。
 *
 * DSH 的 Modal 用 `padding-top: max(24px, --dsh-frame-overlay-top)` 给顶部留白，但设置
 * 面板的 overlay 只把 panel 按同一变量压矮、再整体垂直居中：屏幕够高时面板上下各留
 * 30px，仍会顶到壳层导航栏底下。这里给设置 overlay 补上同样的顶部内边距，让面板整体
 * 下移、避开导航栏。设置面板 portal 到 body，和壳层宿主是同层兄弟，故用 `:has` 精确定位。
 */
function createOverlayInset(): HTMLStyleElement {
  const element = document.createElement('style')
  element.setAttribute(NEUTRALIZER_ATTRIBUTE, '')
  element.textContent
    = 'html[data-windows-titlebar] body > div:has(> [data-shortcut-modal="settings"])'
      + '{padding-top:var(--dsh-frame-overlay-top, 24px);box-sizing:border-box}'
  return element
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
  // 宿主整体穿透（`pointer-events: none`），交互区域各自声明 `auto`；真正的点击问题
  // 出在浏览器进程的拖拽区判定，由 light DOM 的覆盖规则解决（见 createDragNeutralizer）。
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000'
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = env.__DSH_SHELL_CSS__
  const mount = document.createElement('div')
  mount.id = MOUNT_ID
  mount.style.cssText = 'pointer-events:none'
  // 弹层容器铺满视口且自身不拦截点击：react-aria 的浮层是 `position: fixed`，
  // 锚点按视口算；可交互区域由浮层自己声明。层级必须高于挂载点，否则菜单、对话框会被
  // 导航栏整条盖住（截图里表现为「菜单藏在白底下面」）。
  const portal = document.createElement('div')
  portal.id = PORTAL_ID
  portal.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000'
  shadow.append(style, mount, portal)
  root.append(host)
  root.append(createDragNeutralizer())
  root.append(createOverlayInset())
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
  // 同一文档可能被求值多次（注入脚本 + 页面内再导航）。再次 createRoot 同一容器会
  // 接管旧树、作废它的事件委托——DOM 还在、hover 也正常，点击却无人响应。
  if (mount.hasChildNodes())
    return
  createRoot(mount).render(createElement(ShellRoot))
}

document.documentElement.dataset.theme = resolveTheme(
  undefined,
  window.matchMedia('(prefers-color-scheme: dark)').matches,
)

start()
