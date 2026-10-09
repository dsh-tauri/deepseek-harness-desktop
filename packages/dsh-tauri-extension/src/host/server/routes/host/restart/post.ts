import { defineEventHandler } from 'h3'
import { restart } from '../../../../service/restart'

export default defineEventHandler((event) => {
  const headers = event.req.headers
  const origin = headers.get('origin')
  const host = headers.get('host')
  let sameOrigin = false
  if (origin !== null && host !== null) {
    try {
      const parsed = new URL(origin)
      sameOrigin = (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
    }
    catch {
      sameOrigin = false
    }
  }
  const forwarded = headers.has('forwarded') || headers.has('x-forwarded-for') || headers.has('x-real-ip')
  if (!sameOrigin || forwarded) {
    event.res.status = 403
    return { error: 'untrusted origin' }
  }
  const outcome = restart.start()
  if (outcome.owned) {
    event.res.status = 409
    return { error: 'restart is owned by the desktop shell' }
  }
  return { ok: true, pid: outcome.pid, replacementPid: outcome.replacementPid, logOut: outcome.logOut }
})
