import { describe, expect, it } from 'vitest'
import { createKeyedThrottle } from './hydration.utils'

function harness(intervalMs: number) {
  let time = 0
  let timers: { at: number, fn: () => void }[] = []
  const throttle = createKeyedThrottle({
    intervalMs,
    now: () => time,
    schedule: (fn, ms) => {
      const timer = { at: time + ms, fn }
      timers.push(timer)
      return () => {
        timers = timers.filter(item => item !== timer)
      }
    },
  })
  return {
    throttle,
    now: () => time,
    pendingTimers: () => timers.length,
    advance(ms: number): void {
      time += ms
      const due = timers.filter(timer => timer.at <= time).sort((a, b) => a.at - b.at)
      for (const timer of due) {
        timers = timers.filter(item => item !== timer)
        timer.fn()
      }
    },
  }
}

describe('createKeyedThrottle', () => {
  it('首次请求立即执行', () => {
    const h = harness(1000)
    let runs = 0
    h.throttle.request('s1', () => {
      runs += 1
    })
    expect(runs).toBe(1)
    expect(h.pendingTimers()).toBe(0)
  })

  it('窗口内的高频请求合并为窗口末尾的一次拖尾执行', () => {
    const h = harness(1000)
    let runs = 0
    const run = (): void => {
      runs += 1
    }
    h.throttle.request('s1', run)
    for (let i = 0; i < 100; i++) {
      h.advance(1)
      h.throttle.request('s1', run)
    }
    expect(runs).toBe(1)
    h.advance(1000)
    expect(runs).toBe(2)
    h.advance(1000)
    expect(runs).toBe(2)
  })

  it('间隔已满时立即执行，不排定拖尾任务', () => {
    const h = harness(1000)
    let runs = 0
    const run = (): void => {
      runs += 1
    }
    h.throttle.request('s1', run)
    h.advance(1000)
    h.throttle.request('s1', run)
    expect(runs).toBe(2)
    expect(h.pendingTimers()).toBe(0)
  })

  it('持续高频请求下执行频率收敛到每窗口至多一次', () => {
    const h = harness(1000)
    let runs = 0
    const run = (): void => {
      runs += 1
    }
    for (let i = 0; i < 1000; i++) {
      h.throttle.request('s1', run)
      h.advance(10)
    }
    expect(runs).toBe(11)
  })

  it('不同 key 各自独立计时', () => {
    const h = harness(1000)
    const runs: string[] = []
    h.throttle.request('s1', () => runs.push('s1'))
    h.throttle.request('s2', () => runs.push('s2'))
    expect(runs).toEqual(['s1', 's2'])
  })

  it('cancel 取消待执行的拖尾任务并重置窗口', () => {
    const h = harness(1000)
    let runs = 0
    const run = (): void => {
      runs += 1
    }
    h.throttle.request('s1', run)
    h.advance(200)
    h.throttle.request('s1', run)
    h.throttle.cancel('s1')
    expect(h.pendingTimers()).toBe(0)
    h.advance(5000)
    expect(runs).toBe(1)
    h.throttle.request('s1', run)
    expect(runs).toBe(2)
  })

  it('clear 清空全部 key 的待执行任务', () => {
    const h = harness(1000)
    let runs = 0
    const run = (): void => {
      runs += 1
    }
    h.throttle.request('s1', run)
    h.throttle.request('s2', run)
    h.throttle.request('s1', run)
    h.throttle.request('s2', run)
    expect(h.pendingTimers()).toBe(2)
    h.throttle.clear()
    expect(h.pendingTimers()).toBe(0)
    h.advance(5000)
    expect(runs).toBe(2)
  })
})
