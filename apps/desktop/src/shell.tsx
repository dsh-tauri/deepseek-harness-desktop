/* eslint-disable react-refresh/only-export-components -- 注入入口，不参与 HMR 组件替换 */
import type { ReactNode } from 'react'
import { OverlaysProvider } from '@overlastic/react'
import { useMount } from '@reause/core'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement, useState } from 'react'
import { UNSAFE_PortalProvider } from 'react-aria'
import { createRoot } from 'react-dom/client'
import { enableShadowDOM } from 'react-stately/private/flags/flags'
import { ToastProvider } from '@/components/toast-provider'
import { queryClient } from '@/config/client'
import { getInitialTheme } from '@/hooks/use-theme-adaptive'
import { App } from '@/layout'
import '@/utils/logger'
import './styles/main.css'

interface ShellEnv {
  /** 注入脚本提供的样式；缺省时用构建期注入到本模块的 `SHELL_CSS`（dev / 页面内加载）。 */
  __DSH_SHELL_CSS__?: string
  __DSH_SHELL_THEME__?: string
  __DSH_SHELL_LOADED__?: boolean
}

/**
 * 壳层样式，构建期由 `dsh-shell-shadow-css` 插件原地替换成 CSS 文本字面量。
 *
 * 这样壳层只有一份 `shell.mjs` 即可自包含：插件在 `generateBundle` 里把产出 CSS 的
 * `:root` 改写为 `:host` 后，替换掉这里的占位符并删除 css asset，注入脚本不必再传样式。
 * 未经过插件（如 ts 单测 / dev）时该常量保持原值，由调用方再回退到注入变量。
 */
const SHELL_CSS = '__DSH_SHELL_CSS_PLACEHOLDER__'

const HOST_ATTRIBUTE = 'data-dsh-shell-host'
const NEUTRALIZER_ATTRIBUTE = 'data-dsh-shell-drag-neutralizer'
const MOUNT_ID = 'dsh-shell-root'
const PORTAL_ID = 'dsh-shell-portal'

// 壳层整棵树渲染在 Shadow DOM 里，必须先打开 react-aria 的 Shadow DOM 支持。
// 该开关默认关闭，关闭时 `usePress` 判定「事件目标是否在按下元素内」用的是普通
// `contains`，跨 shadow 边界的 retarget 会让它恒为 false——`pointerdown` 一进来就
// 被丢弃，`onPress` 永不触发。表现为按钮有 hover、有 pointerdown，点了却毫无反应。
// 挂到全局对象上：纯函数调用会被 tree-shaking 判为无副作用整段删掉。
;(globalThis as { __dshEnableShadowDom?: () => void }).__dshEnableShadowDom = enableShadowDOM
enableShadowDOM()

/**
 * 把壳层内所有浮层挂载点交给 react-aria。
 *
 * HeroUI 的 Dropdown / Modal / Toast 默认 portal 到 `document.body`——那是 Shadow 外的
 * light DOM，拿不到壳层样式表，会渲染成无样式黑字；留在壳层挂载点里又会低于弹层容器，
 * 被导航栏或其它浮层盖住。由 Provider 统一指定容器后，React 把节点直接渲染进去；
 * 绝不能事后搬移 DOM 节点，那会打断 React 的节点表（`removeChild ... not a child`）。
 *
 * 必须包住 `ToastProvider`：toast 的 region 也是 portal，放外层才进得来。
 */
function ShellRoot() {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  useMount(() => {
    setContainer(document.querySelector(`[${HOST_ATTRIBUTE}]`)?.shadowRoot?.getElementById(PORTAL_ID) ?? null)
  })
  return (
    <QueryClientProvider client={queryClient}>
      <PortalTarget container={container}>
        <ToastProvider>
          <OverlaysProvider>
            <App />
          </OverlaysProvider>
        </ToastProvider>
      </PortalTarget>
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

function createOverlayInset(): HTMLStyleElement {
  const element = document.createElement('style')
  element.setAttribute(NEUTRALIZER_ATTRIBUTE, '')
  element.textContent
    = 'html[data-windows-titlebar] [data-shortcut-modal="settings"][data-slot-sidebar="dsh-tauri-ui"]'
      + '{top:var(--dsh-windows-titlebar-height,44px);height:calc(100% - var(--dsh-windows-titlebar-height,44px))}'
  return element
}

/** 确保 Shadow host 与挂载点已就绪；主世界注入脚本与 dev 自举都走这里。 */
function ensureHostRoot(): void {
  if (document.querySelector(`[${HOST_ATTRIBUTE}]`) !== null)
    return
  const env = globalThis as ShellEnv
  const css = env.__DSH_SHELL_CSS__ ?? SHELL_CSS
  const root = document.documentElement
  if (root === null)
    return
  const host = document.createElement('div')
  host.setAttribute(HOST_ATTRIBUTE, '')
  host.setAttribute('data-theme', root.dataset.theme === 'dark' ? 'dark' : 'light')
  // 层级 999：高于 DSH 页面里除弹窗外的所有层（面板 40、遮罩 25、overlay 20 等），
  // 又低于 DSH 自己的弹窗根（1000），这样参数面板、快捷键等弹窗能正常盖住导航栏，
  // 不再需要用镜像层去「假装被遮住」。宿主本身铺满视口但整体穿透，交互区域各自声明 auto。
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:999'
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = css
  const mount = document.createElement('div')
  mount.id = MOUNT_ID
  // 挂载点必须整体穿透：它铺满视口，设成 `auto` 会把 DSH 页面的点击全部吞掉。
  // 可交互性交给 `Shell` 的内容容器显式声明——启动/预装/恢复页 `auto`，文档即 DSH 时
  // `none` 让点击落到背后的页面，导航栏等控件自己声明 `auto`。
  mount.style.cssText = 'position:fixed;inset:0;pointer-events:none'
  // 弹层容器铺满视口且自身不拦截点击：react-aria 的浮层是 `position: fixed`，
  // 锚点按视口算；可交互区域由浮层自己声明。层级必须高于挂载点，否则菜单、对话框会被
  // 导航栏整条盖住（截图里表现为「菜单藏在白底下面」）。
  const portal = document.createElement('div')
  portal.id = PORTAL_ID
  portal.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000'
  shadow.append(style, mount, portal)
  document.body.append(host)
  root.append(createDragNeutralizer())
  root.append(createOverlayInset())
  new MutationObserver(() => {
    host.setAttribute('data-theme', root.dataset.theme === 'dark' ? 'dark' : 'light')
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] })
}

/**
 * 渲染整棵壳层 UI —— 只负责「文档即 DSH」这一种形态。
 *
 * 主窗口 webContents 直接加载 DSH 页面，注入脚本先备好 Shadow host，这里把壳层渲染
 * 进去，与 DSH 双向隔离。dev 下的独立壳层页（没有 DSH 文档）由 `main.tsx` 用 webview
 * 标签承载 DSH，不在本文件处理，因此这里不再回退到 `#root` 的 light DOM。
 */
function start(): void {
  if (typeof document === 'undefined')
    return
  if (document.readyState === 'loading' || document.documentElement === null) {
    document.addEventListener('DOMContentLoaded', start, { once: true })
    return
  }
  document.documentElement.dataset.theme = getInitialTheme()
  ensureHostRoot()
  const mount = document
    .querySelector(`[${HOST_ATTRIBUTE}]`)
    ?.shadowRoot
    ?.getElementById(MOUNT_ID)
  if (mount === null || mount === undefined)
    return
  // 同一文档可能被求值多次（注入脚本 + 页面内再导航）。再次 createRoot 同一容器会
  // 接管旧树、作废它的事件委托——DOM 还在、hover 也正常，点击却无人响应。
  if (mount.hasChildNodes())
    return
  createRoot(mount).render(createElement(ShellRoot))
}

/**
 * 壳层自举入口：只在「文档即 DSH」时由 `main.tsx` 调用（注入脚本已备好 Shadow host）。
 * 独立壳层页（dev）走 `main.tsx` 的另一分支，不经过这里。
 */
export function startShell(): void {
  start()
}
