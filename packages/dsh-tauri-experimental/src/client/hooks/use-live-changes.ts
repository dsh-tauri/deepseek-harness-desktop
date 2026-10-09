import type { LiveSnapshot } from '../types'
import { useTimeoutPoll } from 'dsh-tauri/client'
import { useEffect, useRef, useState } from 'react'
import { getLive } from '../apis'
import { RUNNING_CHANGES_LIVE_POLL_INTERVAL_MS } from '../constants'

/**
 * 一次读数属于哪个会话的哪次订阅。
 *
 * `generation` 是「订阅世代」：会话 id、或「是否在跑」的闸门一变就作废。
 * 单靠会话 id 不够——同一个会话结束（闸门关）再重新开始（闸门开）后 id 没变，
 * 上一次会话/上一轮的读数会被当成当前读数继续用（统计越叠越大）。
 */
interface LiveReading {
  sessionId: string
  generation: number
  live: LiveSnapshot
}

/**
 * 运行中实时读数（`client/hooks/`）。
 *
 * 宿主侧自己按 1.5s 刷新 git 读数、路由只读内存，所以客户端这里的轮询成本极低；
 * 反过来宿主无法主动推给客户端（不引入投影/事件轴的复杂度），故用固定间隔轮询。
 * 轮询节拍交给 `@reause/core` 的 `useTimeoutPoll`（经 `dsh-tauri/client` 引入）。
 *
 * **读数必须随边界归零**：它只是「这一轮此刻改了什么」。会话切换、会话结束（闸门关闭）、
 * 或同一个会话里闸门重新打开，旧读数一律不再成立——否则组件实例被复用时提示条会继续渲染
 * 上一份统计，并随工作区漂移越变越大。归零走**派生**而不是 effect 里的 setState。
 *
 * @param sessionId - 当前会话 id。
 * @param shouldPoll - 是否允许轮询（owner 份额明确说「没在跑」时置 false）。
 * @returns 最新读数；无活动 turn（或读数已过期）时为 null。
 */
export function useLiveChanges(sessionId: string | undefined, shouldPoll: boolean): LiveSnapshot | null {
  const [reading, setReading] = useState<LiveReading | null>(null)
  /** 订阅世代：每次「会话 id / 闸门」变化自增，用来让此前那份读数失效。 */
  const generationRef = useRef(0)
  /** 当前节拍属于哪次订阅（供回调判定世代；必须在 useTimeoutPoll 之前声明）。 */
  const readingScopeRef = useRef<{ sessionId: string | undefined, generation: number }>({ sessionId: undefined, generation: 0 })

  // immediate:false —— 起停由下面的 effect 显式控制；此前每次订阅条件变化都要
  // 「先停旧节拍、再按新条件起新节拍」，让 useTimeoutPoll 自己在挂载时启动会绕过它。
  const { pause, resume } = useTimeoutPoll(async (): Promise<void> => {
    // 本次 effect 闭包快照：节拍回调经 ref 转发，因此必然读到**最新**闭包，
    // 与「在飞旧请求回来时用世代判定丢弃」互补。
    const { sessionId: currentId, generation } = readingScopeRef.current
    if (currentId === undefined)
      return
    try {
      const next = await getLive({ sessionId: currentId })
      if (generationRef.current !== generation)
        return
      setReading('active' in next && next.active ? { sessionId: currentId, generation, live: next } : null)
    }
    catch {
      // 读数失败只影响提示条：静默清空，不打断会话。
      if (generationRef.current === generation)
        setReading(null)
    }
  }, RUNNING_CHANGES_LIVE_POLL_INTERVAL_MS, { immediate: false })

  // keep:effect 轮询节拍的起停必须跟随「会话 id / 闸门」两个 React 依赖，无声明式等价物
  useEffect(() => {
    // 每次订阅条件变化都推进世代：旧读数与在飞的旧请求随之作废。
    generationRef.current += 1
    const generation = generationRef.current
    readingScopeRef.current = { sessionId, generation }
    if (sessionId === undefined || !shouldPoll)
      return
    resume()
    return () => {
      pause()
    }
  }, [sessionId, shouldPoll, pause, resume])

  if (!shouldPoll || reading === null || reading.sessionId !== sessionId || reading.generation !== generationRef.current)
    return null
  return reading.live
}
