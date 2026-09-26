import { useEventListener, useMount } from '@reause/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useRef } from 'react'
import { store } from '@/store'

/** 远端弹窗 label 前缀（与 rust remote_open_window 的窗口命名一致）。 */
const REMOTE_WINDOW_LABEL_PREFIX = 'remote-'

/**
 * 远端机器数据面的组件侧装配：启动轮询（store 内幂等）并挂「窗口聚焦 /
 * 页面可见」触发的即时刷新。卸载时只摘监听——轮询属于壳层生命周期，由
 * store 持有（StrictMode 双挂载下 boot 只执行一次）。
 *
 * 远端弹窗（label remote-<machineId>，加载壳层本体）启动即切到目标机器：
 * 本窗口的 store 独立于主窗口，切换只影响本窗口视图。
 */
export function useRemoteMachines(): void {
  useMount(() => {
    store.remote.boot()
    // 非 tauri 运行时（单测 jsdom）getCurrentWindow 直接抛——按主窗口语义跳过
    let label = ''
    try {
      label = getCurrentWindow().label
    }
    catch {
      label = ''
    }
    if (label.startsWith(REMOTE_WINDOW_LABEL_PREFIX)) {
      const machineId = label.slice(REMOTE_WINDOW_LABEL_PREFIX.length)
      if (machineId !== '')
        void store.remote.openInitialMachine(machineId)
    }
  })

  function refreshNow() {
    if (!document.hidden)
      void store.remote.refresh()
  }

  useEventListener('focus', refreshNow)
  useEventListener(useRef(document), 'visibilitychange', refreshNow)
}
