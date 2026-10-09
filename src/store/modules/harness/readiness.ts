function delay(milliseconds: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, milliseconds))
}

export type StartupPhase = 'plugin-install' | 'process-boot' | 'client-modules'
export type ReadinessTimeout = 'inactivity' | 'absolute'

export interface ReadinessProbeResult {
  healthy: boolean
  notOwned: boolean
  /**
   * 服务端口尚未被监听（本地门禁直接判定，探测几乎零成本）。
   *
   * 这是启动早期的正常态而非失败：轮询据此改用快扫间隔，去撞端口开始监听的
   * 那一刻；否则端口起来后最多还要空等满一个常规间隔。
   */
  notListening?: boolean
  /**
   * 端口已在监听，但启动页尚未登记（boot page 404/401/5xx，或建连后请求失败）。
   *
   * 与 `notListening` 同属「本轮没取任何 bundle、下一刻就可能就绪」的状态：端口门禁
   * 已通过说明服务进程起来了，剩下的只是它自己的启动尾巴，本轮只发了一次请求
   * （毫秒级），因此同样改用快扫间隔。
   */
  bootPending?: boolean
  phase?: StartupPhase
  reason?: string
}

export interface ReadinessPollResult extends ReadinessProbeResult {
  timeout?: ReadinessTimeout
}

interface PollReadinessOptions {
  probe: () => Promise<ReadinessProbeResult>
  intervalMs: number
  /**
   * 探测结果标记 `notListening` / `bootPending` 时改用的快扫间隔；
   * 缺省与 `intervalMs` 相同。
   */
  fastRetryIntervalMs?: number
  maxAttempts?: number
  inactivityTimeoutMs?: number
  absoluteTimeoutMs?: number
  shouldContinue?: () => boolean
  onProbe?: (result: ReadinessProbeResult) => void
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
}

interface ActivitySnapshot {
  sequence: number
  reason: string
}

interface WaitForActivityTaskOptions<T> {
  task: Promise<T>
  getActivity: () => ActivitySnapshot
  inactivityTimeoutMs: number
  absoluteTimeoutMs: number
  intervalMs: number
  shouldContinue?: () => boolean
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
}

export interface ActivityTaskResult<T> {
  completed: boolean
  cancelled: boolean
  timeout?: ReadinessTimeout
  value?: T
  reason: string
}

function activityKey(result: ReadinessProbeResult): string {
  return `${result.phase ?? ''}\0${result.reason ?? ''}`
}

function timedOut(
  now: number,
  startedAt: number,
  lastActivityAt: number,
  inactivityTimeoutMs?: number,
  absoluteTimeoutMs?: number,
): ReadinessTimeout | undefined {
  if (absoluteTimeoutMs !== undefined && now - startedAt >= absoluteTimeoutMs) {
    return 'absolute'
  }
  if (inactivityTimeoutMs !== undefined && now - lastActivityAt >= inactivityTimeoutMs) {
    return 'inactivity'
  }
}

function boundedWait(
  requestedMs: number,
  now: number,
  startedAt: number,
  lastActivityAt: number,
  inactivityTimeoutMs?: number,
  absoluteTimeoutMs?: number,
): number {
  const limits = [requestedMs]
  if (absoluteTimeoutMs !== undefined) {
    limits.push(Math.max(0, absoluteTimeoutMs - (now - startedAt)))
  }
  if (inactivityTimeoutMs !== undefined) {
    limits.push(Math.max(0, inactivityTimeoutMs - (now - lastActivityAt)))
  }
  return Math.min(...limits)
}

export async function pollReadiness({
  probe,
  intervalMs,
  fastRetryIntervalMs = intervalMs,
  maxAttempts,
  inactivityTimeoutMs,
  absoluteTimeoutMs,
  shouldContinue = () => true,
  onProbe,
  now = Date.now,
  wait = delay,
}: PollReadinessOptions): Promise<ReadinessPollResult> {
  const startedAt = now()
  let lastActivityAt = startedAt
  let lastKey = ''
  let lastResult: ReadinessProbeResult = { healthy: false, notOwned: false }
  let remainingAttempts = maxAttempts

  while (shouldContinue() && remainingAttempts !== 0) {
    const beforeProbeTimeout = timedOut(
      now(),
      startedAt,
      lastActivityAt,
      inactivityTimeoutMs,
      absoluteTimeoutMs,
    )
    if (beforeProbeTimeout) {
      return { ...lastResult, timeout: beforeProbeTimeout }
    }

    const result = await probe()
    if (!shouldContinue()) {
      return { healthy: false, notOwned: false }
    }
    lastResult = result
    onProbe?.(result)

    const nextKey = activityKey(result)
    if (nextKey !== lastKey) {
      lastKey = nextKey
      lastActivityAt = now()
    }
    if (remainingAttempts !== undefined) {
      remainingAttempts--
    }
    if (result.healthy || result.notOwned) {
      return result
    }

    const afterProbeTimeout = timedOut(
      now(),
      startedAt,
      lastActivityAt,
      inactivityTimeoutMs,
      absoluteTimeoutMs,
    )
    if (afterProbeTimeout) {
      return { ...result, timeout: afterProbeTimeout }
    }
    if (shouldContinue() && remainingAttempts !== 0) {
      const fastRetry = result.notListening === true || result.bootPending === true
      const waitMs = boundedWait(
        fastRetry ? fastRetryIntervalMs : intervalMs,
        now(),
        startedAt,
        lastActivityAt,
        inactivityTimeoutMs,
        absoluteTimeoutMs,
      )
      await wait(waitMs)
    }
  }

  return lastResult
}

export async function waitForActivityTask<T>({
  task,
  getActivity,
  inactivityTimeoutMs,
  absoluteTimeoutMs,
  intervalMs,
  shouldContinue = () => true,
  now = Date.now,
  wait = delay,
}: WaitForActivityTaskOptions<T>): Promise<ActivityTaskResult<T>> {
  const startedAt = now()
  let lastActivityAt = startedAt
  let snapshot = getActivity()
  let settled = false
  let rejected = false
  let value: T | undefined
  let failure: unknown

  void task.then(
    (result) => {
      value = result
      settled = true
    },
    (error) => {
      failure = error
      rejected = true
      settled = true
    },
  )

  while (shouldContinue()) {
    if (settled) {
      if (rejected) {
        throw failure
      }
      return {
        completed: true,
        cancelled: false,
        value,
        reason: snapshot.reason,
      }
    }

    const nextSnapshot = getActivity()
    if (nextSnapshot.sequence !== snapshot.sequence) {
      snapshot = nextSnapshot
      lastActivityAt = now()
    }
    const timeout = timedOut(now(), startedAt, lastActivityAt, inactivityTimeoutMs, absoluteTimeoutMs)
    if (timeout) {
      return {
        completed: false,
        cancelled: false,
        timeout,
        reason: snapshot.reason,
      }
    }
    await wait(boundedWait(
      intervalMs,
      now(),
      startedAt,
      lastActivityAt,
      inactivityTimeoutMs,
      absoluteTimeoutMs,
    ))
  }

  return {
    completed: false,
    cancelled: true,
    reason: snapshot.reason,
  }
}

export class SingleFlight<T> {
  private pending: Promise<T> | null = null

  run(task: () => Promise<T>): Promise<T> {
    if (this.pending) {
      return this.pending
    }
    const pending = task().finally(() => {
      if (this.pending === pending) {
        this.pending = null
      }
    })
    this.pending = pending
    return pending
  }
}

export type ReloadDecision = 'reload' | 'duplicate' | 'exhausted' | 'ready'

export class BoundedReloadGate {
  private attempts = 0
  private lastGeneration = -1
  private ready = false

  constructor(private readonly maxAttempts: number) {}

  request(generation: number): ReloadDecision {
    if (this.ready) {
      return 'ready'
    }
    if (generation === this.lastGeneration) {
      return 'duplicate'
    }
    if (this.attempts >= this.maxAttempts) {
      return 'exhausted'
    }
    this.lastGeneration = generation
    this.attempts++
    return 'reload'
  }

  markReady(): void {
    this.ready = true
  }

  reset(): void {
    this.attempts = 0
    this.lastGeneration = -1
    this.ready = false
  }
}
