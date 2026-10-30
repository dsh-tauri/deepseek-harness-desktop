import type { ClientRemote } from '../types/remotes.ts'

export interface ServiceLookup {
  get: (name: string) => unknown
}

export function resolveRemote(ctx: ServiceLookup): ClientRemote | undefined {
  return ctx.get('remote') as ClientRemote | undefined
}
