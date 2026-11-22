export function onceAsync<T>(create: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => pending ??= create().catch((error) => {
    pending = undefined
    throw error
  })
}
