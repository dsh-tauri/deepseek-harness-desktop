import type { PendingDelivery } from '../types'

let writeQueue: Promise<unknown> = Promise.resolve()
let taskQueue: Promise<unknown> = Promise.resolve()

export const runtime = {
  stopping: false,
  running: new Set<string>(),
  accepted: new Set<Promise<unknown>>(),
  pending: new Map<string, PendingDelivery>(),
  flushes: new Map<string, Promise<boolean>>(),
  failed: new Set<string>(),
}

export function withWriteQueue<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = writeQueue.then(fn)
  writeQueue = run.then(() => undefined, () => undefined)
  return run
}

export function withTaskQueue<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = taskQueue.then(fn)
  taskQueue = run.then(() => undefined, () => undefined)
  return run
}

export function trackAccepted<T>(run: Promise<T>): Promise<T> {
  runtime.accepted.add(run)
  void run.then(() => runtime.accepted.delete(run), () => runtime.accepted.delete(run))
  return run
}

export async function drainRuntime(): Promise<void> {
  runtime.stopping = true
  await taskQueue
  await Promise.allSettled([...runtime.accepted])
  await writeQueue
}

export function resetWriteQueue(): void {
  writeQueue = Promise.resolve()
  taskQueue = Promise.resolve()
  runtime.stopping = false
  runtime.running.clear()
  runtime.accepted.clear()
  runtime.pending.clear()
  runtime.flushes.clear()
  runtime.failed.clear()
}
