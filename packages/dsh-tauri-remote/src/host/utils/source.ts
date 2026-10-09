import type { IncomingHttpHeaders } from 'node:http'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'

const SOURCE_CLASS_HEADER = 'x-dsh-remote-source'
const SOURCE_SESSION_HEADER = 'x-dsh-remote-session'
const LOOPBACK_CLASS = 'loopback'

export function isLoopbackPeer(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 来源分类判定：两枚内部标识头都不存在时回退 TCP 对端地址；任一枚存在则必须两枚同时
 * 有效（单值 + 会话标识匹配）才采用其声明，否则一律按不可信处理——网关转发到本机 DSH
 * 时对端恒为回环，回退会把伪造头变成回环权限。
 */
export function isLoopbackSource(headers: IncomingHttpHeaders, peerAddress: string | undefined, session: string): boolean {
  const declared = headers[SOURCE_CLASS_HEADER]
  const token = headers[SOURCE_SESSION_HEADER]
  if (declared === undefined && token === undefined)
    return isLoopbackPeer(peerAddress)
  if (typeof declared !== 'string' || typeof token !== 'string')
    return false
  if (session === '' || !sessionMatches(token, session))
    return false
  return declared === LOOPBACK_CLASS
}

function sessionMatches(token: string, session: string): boolean {
  const left = Buffer.from(token)
  const right = Buffer.from(session)
  return left.length === right.length && timingSafeEqual(left, right)
}
