import { invoke } from '@tauri-apps/api/core'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app'
import './main.css'

/** 跟随主窗口主题：覆盖窗口独立渲染，拿不到主窗口的 store，单独取一次主题偏好。 */
async function applyTheme(): Promise<void> {
  let preference: 'dark' | 'light' | 'system' = 'system'
  try {
    preference = await invoke<'dark' | 'light' | 'system'>('get_dsh_theme')
  }
  catch (error) {
    console.error('[toast-overlay] read theme failed:', error)
  }
  const systemDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  document.documentElement.dataset.theme = preference === 'light' || preference === 'dark'
    ? preference
    : (systemDark ? 'dark' : 'light')
}

void applyTheme()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
