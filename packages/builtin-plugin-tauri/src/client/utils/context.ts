export function effectContext<T>(self: unknown): T | undefined {
  if (self === null || typeof self !== 'object')
    return undefined
  return Object.hasOwn(self, 'ctx') ? (self as { ctx: T }).ctx : (self as T)
}
