export async function waitFor<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined)
    signal.throwIfAborted()
  }
  let cancel!: () => void
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
  })
  try {
    return await Promise.race([pending, aborted])
  }
  finally {
    signal.removeEventListener('abort', cancel)
  }
}
