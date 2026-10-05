import type { RemoteAuthFailureRecord, RemotePasswordRecord, RemoteSessionTicket } from '../types/index'
import { Buffer } from 'node:buffer'
import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

const AUTH_FAILURE_LIMIT = 5

const AUTH_BAN_MS = 5 * 60 * 1000

/** OWASP 对 PBKDF2-SHA256 的现行建议下限（本机实测约 48ms/次）。 */
const PBKDF2_ITERATIONS = 600_000

const HASH_BYTES = 32

const SALT_BYTES = 16

const SECRET_BYTES = 32

const SESSION_VERSION = 'v1'

export function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): RemotePasswordRecord {
  const salt = randomBytes(SALT_BYTES)
  return {
    algo: 'pbkdf2-sha256',
    salt: salt.toString('base64'),
    iterations,
    hash: derive(password, salt, iterations).toString('base64'),
  }
}

export function verifyPassword(password: string, record: RemotePasswordRecord | null): boolean {
  const usable = usablePasswordOf(record)
  return usable !== undefined && matches(derive(password, usable.salt, usable.iterations), usable.hash)
}

/** 密码记录可用性：算法、迭代次数、salt 与 hash 编码及长度全部合规才可用（S2 §11 的损坏判定复用同一份规则）。 */
export function isPasswordRecordUsable(record: RemotePasswordRecord | null): record is RemotePasswordRecord {
  return usablePasswordOf(record) !== undefined
}

export function signSession(secret: string, now: number, ttlMs = SESSION_TTL_MS): RemoteSessionTicket {
  const expiresAt = now + ttlMs
  return { value: `${SESSION_VERSION}.${now}.${expiresAt}.${signatureOf(secret, now, expiresAt)}`, issuedAt: now, expiresAt }
}

export function verifySession(value: string | undefined, secret: string, now: number): boolean {
  if (value === undefined || secret === '')
    return false
  const segments = value.split('.')
  const version = segments[0]
  const issuedAt = Number(segments[1])
  const expiresAt = Number(segments[2])
  const mac = segments[3]
  if (segments.length !== 4 || version !== SESSION_VERSION || mac === undefined || !Number.isInteger(issuedAt) || !Number.isInteger(expiresAt) || expiresAt <= now)
    return false
  return matches(Buffer.from(signatureOf(secret, issuedAt, expiresAt)), Buffer.from(mac))
}

export function createLinkToken(): string {
  return randomBytes(SECRET_BYTES).toString('base64url')
}

export function createSessionSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url')
}

export function tokenMatches(provided: string | undefined, expected: string | null): boolean {
  if (provided === undefined || expected === null || expected === '')
    return false
  return matches(Buffer.from(provided), Buffer.from(expected))
}

export function rateLimitAfterFailure(
  record: RemoteAuthFailureRecord | undefined,
  now: number,
  limit = AUTH_FAILURE_LIMIT,
  banMs = AUTH_BAN_MS,
): RemoteAuthFailureRecord {
  const base = record === undefined || (record.bannedUntil > 0 && record.bannedUntil <= now) ? 0 : record.failures
  const failures = base + 1
  return failures >= limit ? { failures: 0, bannedUntil: now + banMs } : { failures, bannedUntil: 0 }
}

export function rateLimitBlockedMs(record: RemoteAuthFailureRecord | undefined, now: number): number {
  return record === undefined ? 0 : Math.max(0, record.bannedUntil - now)
}

// --- internal ---
function usablePasswordOf(record: RemotePasswordRecord | null): { salt: Buffer, hash: Buffer, iterations: number } | undefined {
  if (record === null || record.algo !== 'pbkdf2-sha256' || !Number.isInteger(record.iterations) || record.iterations <= 0)
    return undefined
  const salt = decodeBase64(record.salt)
  const hash = decodeBase64(record.hash)
  if (salt === undefined || salt.length === 0 || hash === undefined || hash.length !== HASH_BYTES)
    return undefined
  return { salt, hash, iterations: record.iterations }
}

function derive(password: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(password, salt, iterations, HASH_BYTES, 'sha256')
}

function signatureOf(secret: string, issuedAt: number, expiresAt: number): string {
  return createHmac('sha256', secret).update(`${SESSION_VERSION}.${issuedAt}.${expiresAt}`).digest('hex')
}

function matches(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

function decodeBase64(value: string): Buffer | undefined {
  const decoded = Buffer.from(value, 'base64')
  return decoded.toString('base64') === value ? decoded : undefined
}
