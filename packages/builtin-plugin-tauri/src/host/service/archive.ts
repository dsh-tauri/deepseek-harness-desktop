import type { HostContext } from '../types'

interface DomainChangeSource {
  on: (name: 'domain/changed', listener: () => void) => () => void
}

const ARCHIVE_POLL_MS = 1_000

export function watchArchive(ctx: HostContext, sink: (archived: readonly string[]) => void): () => void {
  let delivered = ''
  const push = (): void => {
    const archived = ctx.workspaceRegistry.archivedSessionIds.map(String)
    const next = archived.join('\n')
    if (next === delivered)
      return
    delivered = next
    sink(archived)
  }
  push()
  const poll = setInterval(push, ARCHIVE_POLL_MS)
  const detach = (ctx as unknown as DomainChangeSource).on('domain/changed', push)
  return () => {
    clearInterval(poll)
    detach()
  }
}
