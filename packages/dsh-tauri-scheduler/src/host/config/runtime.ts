let writeQueue: Promise<unknown> = Promise.resolve()

export function withWriteQueue<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = writeQueue.then(() => fn())
  writeQueue = run.then(() => undefined, () => undefined)
  return run
}

export function resetWriteQueue(): void {
  writeQueue = Promise.resolve()
}
