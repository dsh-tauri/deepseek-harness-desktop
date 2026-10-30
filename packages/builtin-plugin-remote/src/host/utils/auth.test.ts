import { describe, expect, it } from 'vitest'
import { createLinkToken, createSessionSecret, rateLimitAfterFailure, rateLimitBlockedMs, signDeviceSession, signSession, tokenMatches, verifyDeviceSession, verifySession } from './auth'

const FAILURE_LIMIT = 5

const BAN_MS = 5 * 60 * 1000

const SESSION_VALUE = 'v1.1700000000000.1702592000000.f16b0583c93fa78f45152f9dcf0b91d5b8e2d4c1642f816307ba020269546e85'

const SESSION_SECRET = 'session-secret'

const ISSUED_AT = 1_700_000_000_000

const EXPIRES_AT = 1_702_592_000_000

describe('signSession / verifySession', () => {
  it('matches the fixed HMAC-SHA256 session fixture and verifies it before expiry', () => {
    expect(signSession(SESSION_SECRET, ISSUED_AT)).toEqual({ value: SESSION_VALUE, issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT })
    expect(verifySession(SESSION_VALUE, SESSION_SECRET, ISSUED_AT)).toBe(true)
    expect(verifySession(SESSION_VALUE, SESSION_SECRET, EXPIRES_AT - 1)).toBe(true)
  })

  it('rejects an expired session at and after its expiry', () => {
    expect(verifySession(SESSION_VALUE, SESSION_SECRET, EXPIRES_AT)).toBe(false)
    expect(verifySession(SESSION_VALUE, SESSION_SECRET, EXPIRES_AT + 1)).toBe(false)
  })

  it('rejects a tampered expiry, issue time, signature and a foreign secret', () => {
    const [, , , mac] = SESSION_VALUE.split('.')
    expect(verifySession(`v1.${ISSUED_AT + 999_999}.${EXPIRES_AT + 999_999}.${mac}`, SESSION_SECRET, ISSUED_AT)).toBe(false)
    expect(verifySession(`v1.${ISSUED_AT - 1}.${EXPIRES_AT}.${mac}`, SESSION_SECRET, ISSUED_AT)).toBe(false)
    expect(verifySession(`${SESSION_VALUE}x`, SESSION_SECRET, ISSUED_AT)).toBe(false)
    expect(verifySession(`v1.${ISSUED_AT}.${EXPIRES_AT}.${mac?.toUpperCase()}`, SESSION_SECRET, ISSUED_AT)).toBe(false)
    expect(verifySession(SESSION_VALUE, 'foreign-secret', ISSUED_AT)).toBe(false)
  })

  it.each([undefined, '', 'v1', 'v1.123', 'v1.123.456', 'v2.1.9999999999999.abc', 'v1.abc.def.ghi'])('rejects the malformed session value %j', (value) => {
    expect(verifySession(value, SESSION_SECRET, ISSUED_AT)).toBe(false)
  })

  it('refuses to verify anything while no secret is configured', () => {
    expect(verifySession(SESSION_VALUE, '', ISSUED_AT)).toBe(false)
  })
})

describe('device sessions', () => {
  it('keeps signed device authorization past cookie expiry without accepting it as a cookie', () => {
    const ticket = signDeviceSession(SESSION_SECRET, ISSUED_AT)
    expect(ticket.issuedAt).toBe(ISSUED_AT)
    expect(ticket.expiresAt).toBe(0)
    expect(verifyDeviceSession(ticket.value, SESSION_SECRET, ISSUED_AT)).toBe(true)
    expect(verifyDeviceSession(ticket.value, SESSION_SECRET, EXPIRES_AT + 365 * 24 * 60 * 60 * 1000)).toBe(true)
    expect(verifySession(ticket.value, SESSION_SECRET, ISSUED_AT)).toBe(false)
    expect(verifyDeviceSession(SESSION_VALUE, SESSION_SECRET, ISSUED_AT)).toBe(false)
    expect(verifyDeviceSession(ticket.value, 'rotated-secret', ISSUED_AT)).toBe(false)
    expect(verifyDeviceSession(ticket.value.replace(`.${ISSUED_AT}.`, `.${ISSUED_AT + 1}.`), SESSION_SECRET, ISSUED_AT)).toBe(false)
    expect(verifyDeviceSession(ticket.value.replace('.0.', `.${EXPIRES_AT}.`), SESSION_SECRET, ISSUED_AT)).toBe(false)
  })

  it('rejects malformed or unsafe signed timestamps in both ticket types', () => {
    for (const issuedAt of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(verifySession(signSession(SESSION_SECRET, issuedAt, EXPIRES_AT).value, SESSION_SECRET, ISSUED_AT)).toBe(false)
      expect(verifyDeviceSession(signDeviceSession(SESSION_SECRET, issuedAt).value, SESSION_SECRET, ISSUED_AT)).toBe(false)
    }
    for (const value of [undefined, '', 'v1.1.0.x', 'v2.1.0.x'])
      expect(verifyDeviceSession(value, SESSION_SECRET, ISSUED_AT)).toBe(false)
    expect(verifySession(signSession(SESSION_SECRET, ISSUED_AT, Number.MAX_SAFE_INTEGER).value, SESSION_SECRET, ISSUED_AT)).toBe(false)
  })
})

describe('createSessionSecret', () => {
  it('generates independent 32-byte base64url secrets', () => {
    const first = createSessionSecret()
    expect(first).toMatch(/^[\w-]{43}$/u)
    expect(createSessionSecret()).not.toBe(first)
  })
})

describe('createLinkToken', () => {
  it('generates eight uppercase letters or digits without ambiguous characters', () => {
    for (let index = 0; index < 32; index++)
      expect(createLinkToken()).toMatch(/^[2-9A-HJ-NP-Z]{8}$/u)
  })
})

describe('tokenMatches', () => {
  it('ignores letter case only for the new eight-character codes', () => {
    expect(tokenMatches('AB23CD45', 'AB23CD45')).toBe(true)
    expect(tokenMatches('ab23cd45', 'AB23CD45')).toBe(true)
    expect(tokenMatches('aB23cD45', 'AB23CD45')).toBe(true)
    expect(tokenMatches('ab23cd46', 'AB23CD45')).toBe(false)
    expect(tokenMatches('ab23cd45x', 'AB23CD45')).toBe(false)
    expect(tokenMatches('b23cd45', 'AB23CD45')).toBe(false)
    expect(tokenMatches('ab23cd45 ', 'AB23CD45')).toBe(false)
    expect(tokenMatches('AB2ſCD45', 'AB2SCD45')).toBe(false)
  })

  it('keeps legacy tokens and other strings case-sensitive', () => {
    const legacy = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE'
    expect(legacy).toHaveLength(43)
    expect(tokenMatches(legacy, legacy)).toBe(true)
    expect(tokenMatches(legacy.toLowerCase(), legacy)).toBe(false)
    expect(tokenMatches('ab23cd45', 'ab23cd45')).toBe(true)
    expect(tokenMatches('AB23CD45', 'ab23cd45')).toBe(false)
    expect(tokenMatches('LINK-TOKEN', 'link-token')).toBe(false)
    expect(tokenMatches('abc01234', 'ABC01234')).toBe(false)
    expect(tokenMatches('01234567', '01234567')).toBe(true)
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
