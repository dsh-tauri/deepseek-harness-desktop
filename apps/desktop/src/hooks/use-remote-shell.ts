import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'

/**
 * 当前窗口挂在哪台远端机器上（壳层权威状态，来自 Rust 侧）。
 *
 * 配置面板据此决定是否渲染「暂不支持远程 SSH」：远端实例的档案、插件与数据
 * 都不从发起端改写，页面只做提示，不再提供本机作用域选择器。
 *
 * 首次查询落地前返回 `undefined`：这时还不知道窗口归属，调用方不能按「本机」
 * 渲染——远端窗口会先闪一帧本机面板，并把本机作用域的查询真的发出去。
 */
export function useRemoteShellMachine(): string | null | undefined {
  const [machineId, setMachineId] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void invoke<{ machineId: string } | null>('get_remote_shell_state').then(
        (state) => {
          if (alive)
            setMachineId(state?.machineId ?? null)
        },
        () => {
          if (alive)
            setMachineId(null)
        },
      )
    }
    load()
    const timer = setInterval(load, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  return machineId
}
