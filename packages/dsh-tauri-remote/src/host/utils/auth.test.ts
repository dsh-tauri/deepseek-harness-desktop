import type { RemotePasswordRecord } from '../types/index'
import { describe, expect, it } from 'vitest'
import { createLinkToken, createSessionSecret, hashPassword, isPasswordRecordUsable, rateLimitAfterFailure, rateLimitBlockedMs, signSession, tokenMatches, verifyPassword, verifySession } from './auth'

const ITERATIONS = 1000

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

const FAILURE_LIMIT = 5

const BAN_MS = 5 * 60 * 1000

function recordOf(password: string): RemotePasswordRecord {
  return hashPassword(password, ITERATIONS)
}

describe('hashPassword', () => {
  it('produces a pbkdf2-sha256 record with the configured iteration count', () => {
    const record = recordOf('correct horse')
    expect(record.algo).toBe('pbkdf2-sha256')
    expect(record.iterations).toBe(ITERATIONS)
    expect(record.salt).not.toBe('')
    expect(record.hash).not.toBe('')
  })

  it('defaults to the pinned iteration constant', () => {
    expect(hashPassword('correct horse')).toMatchObject({ iterations: 600_000 })
  })

  it('salts every record independently, so the same password hashes differently', () => {
    expect(recordOf('correct horse').hash).not.toBe(recordOf('correct horse').hash)
    expect(recordOf('correct horse').salt).not.toBe(recordOf('correct horse').salt)
  })
})

describe('verifyPassword', () => {
  it('accepts the exact password and rejects any other', () => {
    const record = recordOf('correct horse')
    expect(verifyPassword('correct horse', record)).toBe(true)
    expect(verifyPassword('correct hors', record)).toBe(false)
    expect(verifyPassword('correct horse ', record)).toBe(false)
    expect(verifyPassword('', record)).toBe(false)
  })

  it('rejects a record that carries no password at all', () => {
    expect(verifyPassword('correct horse', null)).toBe(false)
  })

  it.each([
    { algo: 'pbkdf2-sha256', salt: 'not-base64!', iterations: ITERATIONS, hash: 'aGFzaA==' },
    { algo: 'pbkdf2-sha256', salt: 'c2FsdA==', iterations: ITERATIONS, hash: 'not-base64!' },
    { algo: 'pbkdf2-sha256', salt: 'c2FsdA==', iterations: 0, hash: 'aGFzaA==' },
    { algo: 'pbkdf2-sha256', salt: 'c2FsdA==', iterations: 1.5, hash: 'aGFzaA==' },
    { algo: 'scrypt', salt: 'c2FsdA==', iterations: ITERATIONS, hash: 'aGFzaA==' },
  ])('treats the corrupted record %j as unverifiable instead of throwing', (record) => {
    expect(verifyPassword('correct horse', record as unknown as RemotePasswordRecord)).toBe(false)
  })
})

describe('isPasswordRecordUsable', () => {
  it('accepts a freshly hashed record and rejects a missing one', () => {
    expect(isPasswordRecordUsable(recordOf('correct horse'))).toBe(true)
    expect(isPasswordRecordUsable(null)).toBe(false)
  })

  it.each([
    { algo: 'pbkdf2-sha256', salt: 'not-base64!', iterations: ITERATIONS, hash: 'aGFzaA==' },
    { algo: 'pbkdf2-sha256', salt: '', iterations: ITERATIONS, hash: 'aGFzaA==' },
    { algo: 'pbkdf2-sha256', salt: 'c2FsdA==', iterations: ITERATIONS, hash: 'not-base64!' },
    { algo: 'pbkdf2-sha256', salt: 'c2FsdA==', iterations: ITERATIONS, hash: 'aGFzaA==' },
    { algo: 'pbkdf2-sha256', salt: 'c2FsdA==', iterations: 0, hash: 'aGFzaA==' },
    { algo: 'pbkdf2-sha256', salt: 'c2FsdA==', iterations: -1, hash: 'aGFzaA==' },
    { algo: 'scrypt', salt: 'c2FsdA==', iterations: ITERATIONS, hash: 'aGFzaA==' },
  ])('rejects the corrupted record %j', (record) => {
    expect(isPasswordRecordUsable(record as unknown as RemotePasswordRecord)).toBe(false)
  })
})

describe('signSession / verifySession', () => {
  const SECRET = createSessionSecret()

  it('round-trips a freshly signed session and reports its issue and expiry times', () => {
    const now = 1_700_000_000_000
    const ticket = signSession(SECRET, now)
    expect(ticket.issuedAt).toBe(now)
    expect(ticket.expiresAt).toBe(now + SESSION_TTL_MS)
    expect(ticket.value.split('.')).toEqual([expect.any(String), String(now), String(now + SESSION_TTL_MS), expect.any(String)])
    expect(verifySession(ticket.value, SECRET, now)).toBe(true)
    expect(verifySession(ticket.value, SECRET, ticket.expiresAt - 1)).toBe(true)
  })

  it('rejects an expired session', () => {
    const now = 1_700_000_000_000
    const ticket = signSession(SECRET, now, 1000)
    expect(verifySession(ticket.value, SECRET, now + 1001)).toBe(false)
    expect(verifySession(ticket.value, SECRET, now + 1000)).toBe(false)
  })

  it('rejects a tampered expiry, a tampered issue time, a tampered signature and a foreign secret', () => {
    const now = 1_700_000_000_000
    const ticket = signSession(SECRET, now)
    const [version, , , mac] = ticket.value.split('.')
    expect(verifySession(`${version}.${now + 999_999}.${now + 999_999}.${mac}`, SECRET, now)).toBe(false)
    expect(verifySession(`${version}.${now - 1}.${now + SESSION_TTL_MS}.${mac}`, SECRET, now)).toBe(false)
    expect(verifySession(`${ticket.value}x`, SECRET, now)).toBe(false)
    expect(verifySession(ticket.value, createSessionSecret(), now)).toBe(false)
  })

  it.each([undefined, '', 'v1', 'v1.123', 'v1.123.456', 'v2.1.9999999999999.abc', 'v1.abc.def.ghi'])('rejects the malformed session value %j', (value) => {
    expect(verifySession(value, SECRET, 1_700_000_000_000)).toBe(false)
  })

  it('refuses to verify anything while no secret is configured', () => {
    expect(verifySession(signSession(SECRET, 1).value, '', 0)).toBe(false)
  })
})

describe('tokenMatches', () => {
  it('accepts only the exact link token', () => {
    const token = createLinkToken()
    expect(token).toHaveLength(43)
    expect(tokenMatches(token, token)).toBe(true)
    expect(tokenMatches(`${token}x`, token)).toBe(false)
    expect(tokenMatches(token.slice(1), token)).toBe(false)
  })

  it('rejects a missing token or a configuration without one', () => {
    expect(tokenMatches(undefined, 'token')).toBe(false)
    expect(tokenMatches('token', null)).toBe(false)
    expect(tokenMatches('token', '')).toBe(false)
    expect(tokenMatches('', 'token')).toBe(false)
  })
})

describe('rate limiting', () => {
  const NOW = 1_700_000_000_000

  it('counts failures without banning below the threshold', () => {
    let record = rateLimitAfterFailure(undefined, NOW)
    expect(record).toEqual({ failures: 1, bannedUntil: 0 })
    for (let index = 2; index < FAILURE_LIMIT; index++)
      record = rateLimitAfterFailure(record, NOW)
    expect(record).toEqual({ failures: FAILURE_LIMIT - 1, bannedUntil: 0 })
    expect(rateLimitBlockedMs(record, NOW)).toBe(0)
  })

  it('bans for the configured duration when the threshold is reached', () => {
    let record = rateLimitAfterFailure(undefined, NOW)
    for (let index = 1; index < FAILURE_LIMIT; index++)
      record = rateLimitAfterFailure(record, NOW)
    expect(record.bannedUntil).toBe(NOW + BAN_MS)
    expect(rateLimitBlockedMs(record, NOW)).toBe(BAN_MS)
    expect(rateLimitBlockedMs(record, NOW + BAN_MS)).toBe(0)
  })

  it('restarts the failure count once the ban has expired', () => {
    const banned = { failures: 0, bannedUntil: NOW + BAN_MS }
    expect(rateLimitAfterFailure(banned, NOW + BAN_MS + 1)).toEqual({ failures: 1, bannedUntil: 0 })
    expect(rateLimitAfterFailure(banned, NOW + 1)).toEqual({ failures: 1, bannedUntil: 0 })
  })

  it('reports no block for an unknown bucket', () => {
    expect(rateLimitBlockedMs(undefined, NOW)).toBe(0)
  })
})
