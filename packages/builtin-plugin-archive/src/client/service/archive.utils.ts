export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return Promise.race([promise, new Promise<void>(resolve => setTimeout(resolve, ms))])
}
