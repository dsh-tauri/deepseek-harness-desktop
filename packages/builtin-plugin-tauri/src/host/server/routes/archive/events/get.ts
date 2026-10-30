import type { HostContext } from '../../../../types'
import { getServerContext } from 'dsh-h3/utils'
import { defineEventHandler, EventStream } from 'h3'
import { watchArchive } from '../../../../service/archive'

const SSE_KEEPALIVE_COMMENT = 'keepalive'
const SSE_KEEPALIVE_MS = 25_000

export default defineEventHandler((event) => {
  const stream = new EventStream(event)
  void stream.pushComment(SSE_KEEPALIVE_COMMENT)

  const ctx = getServerContext<HostContext>(event)
  const detach = watchArchive(ctx, (archived) => {
    void stream.push({ data: JSON.stringify({ archivedSessionIds: archived }) })
  })
  const keepalive = setInterval(() => {
    void stream.pushComment(SSE_KEEPALIVE_COMMENT)
  }, SSE_KEEPALIVE_MS)

  stream.onClosed(() => {
    clearInterval(keepalive)
    detach()
  })
  return stream
})
