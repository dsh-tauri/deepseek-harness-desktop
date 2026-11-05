import React from 'react'
import ReactDOM from 'react-dom/client'
import { resolveTheme } from '@/hooks/use-theme-adaptive'
import { App } from './app'
import './main.css'

// 跟随系统主题：toast 窗口拿不到壳层的主题偏好（那是另一个 webview 的 store），
// 但 HeroUI 的深浅色只需要与系统一致，视觉上不会与壳层冲突。
document.documentElement.dataset.theme = resolveTheme(
  undefined,
  window.matchMedia('(prefers-color-scheme: dark)').matches,
)

// 系统深浅色切换时同步，避免壳层已跟随而提示层停在旧配色。
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
  document.documentElement.dataset.theme = resolveTheme(undefined, event.matches)
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
