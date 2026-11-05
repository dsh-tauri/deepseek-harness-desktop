import { Button } from '@heroui/react'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/main.css'

const MOUNT_ID = 'dsh-shell-root'
const PORTAL_ID = 'dsh-shell-portal'

interface ShellEnv {
  __DSH_SHELL_CSS__?: string
  __DSH_SHELL_THEME__?: string
}

function ShellPreview() {
  return createElement(
    'div',
    { className: 'bg-panel text-ink rounded-xl p-4 shadow-lg', style: { pointerEvents: 'auto' } },
    createElement('div', { className: 'text-sm font-semibold' }, '壳层 UI 预览'),
    createElement('div', { className: 'mt-1 text-xs opacity-70' }, 'Shadow DOM 注入管线已就绪'),
    createElement(Button, { className: 'mt-3', size: 'sm', variant: 'primary' }, '示例按钮'),
  )
}

function attachShadow(css: string, theme: string): HTMLElement {
  const host = document.createElement('div')
  host.setAttribute('data-dsh-shell-host', '')
  host.setAttribute('data-theme', theme)
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000'
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = css
  const mount = document.createElement('div')
  mount.id = MOUNT_ID
  mount.style.cssText = 'pointer-events:none'
  const portal = document.createElement('div')
  portal.id = PORTAL_ID
  portal.style.cssText = 'pointer-events:none'
  shadow.append(style, mount, portal)
  document.documentElement.append(host)
  return mount
}

function attachLight(): HTMLElement {
  const mount = document.createElement('div')
  mount.id = MOUNT_ID
  document.body.append(mount)
  return mount
}

/**
 * 挂载壳层 UI。
 *
 * 生产由 preload 调用：注入脚本先写 `__DSH_SHELL_CSS__`（已重写为 `:host` 作用域的
 * 样式）与 `__DSH_SHELL_THEME__`，再执行本文件的 IIFE 产物，壳层渲染进 Shadow DOM。
 * `pnpm dev:shell` 直接以模块加载本文件，没有注入样式，走 light DOM 预览。
 */
export function start(): void {
  if (document.readyState === 'loading' || document.documentElement === null) {
    document.addEventListener('DOMContentLoaded', () => start(), { once: true })
    return
  }
  const env = globalThis as ShellEnv
  if (document.querySelector('[data-dsh-shell-host]') !== null)
    return
  if (document.getElementById(MOUNT_ID) !== null)
    return
  const mount = env.__DSH_SHELL_CSS__ === undefined
    ? attachLight()
    : attachShadow(env.__DSH_SHELL_CSS__, env.__DSH_SHELL_THEME__ === 'dark' ? 'dark' : 'light')
  createRoot(mount).render(createElement(ShellPreview))
}

if (typeof document !== 'undefined')
  start()
