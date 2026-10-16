import type { EventHandlerRequest } from 'h3'
import type { RemoteAccessStatus } from '../../../service/access.types'
import type { GetAccessQuery } from '../index.types'
import { defineEventHandler, getQuery, HTTPError } from 'h3'
import { access } from '../../../service/access'
import { waitForPairingUse } from '../../../service/pairing'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteAccessStatus>>(async (event) => {
  const query = getQuery<GetAccessQuery>(event)
  const raw = query.sincePairingUseSeq
  const since = raw === undefined ? undefined : typeof raw === 'string' && /^\d+$/u.test(raw) ? Number(raw) : Number.NaN
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0))
    throw new HTTPError({ statusCode: 400, message: 'invalid sincePairingUseSeq' })
  if (since !== undefined)
    await waitForPairingUse(since, event.req.signal)
  return await access.status()
})
