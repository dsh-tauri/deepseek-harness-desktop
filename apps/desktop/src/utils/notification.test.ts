// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildNotificationResult,
  electNotificationOwner,
  isNotificationShellLabel,
  matchesNotificationSource,
  notificationActionKey,
} from './notification'

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  })
})

describe('notification shell labels', () => {
  it('recognises the main, child and remote windows', () => {
    expect(isNotificationShellLabel('main')).toBe(true)
    expect(isNotificationShellLabel('window-2')).toBe(true)
    expect(isNotificationShellLabel('remote-beta')).toBe(true)
  })

  it('rejects guest windows and unknown labels', () => {
    expect(isNotificationShellLabel('harness-1')).toBe(false)
    expect(isNotificationShellLabel('popup')).toBe(false)
  })
})

describe('notification source matching', () => {
  it('matches only a non-empty identical origin', () => {
    expect(matchesNotificationSource('http://127.0.0.1:3080', 'http://127.0.0.1:3080')).toBe(true)
    expect(matchesNotificationSource('http://127.0.0.1:3081', 'http://127.0.0.1:3080')).toBe(false)
    expect(matchesNotificationSource('', 'http://127.0.0.1:3080')).toBe(false)
    expect(matchesNotificationSource(undefined, 'http://127.0.0.1:3080')).toBe(false)
  })
})

describe('notification owner election', () => {
  it('always claims a notification addressed to this window', () => {
    expect(electNotificationOwner(['main'], { windowLabel: 'main', sourceOrigin: 'http://a.test' }, 'main')).toBe(true)
  })

  it('rejects metadata without a source origin', () => {
    expect(electNotificationOwner(['main'], { windowLabel: 'main' }, 'main')).toBe(false)
  })

  it('falls back to the first candidate when nothing is registered yet', () => {
    localStorage.setItem('dsh-notification-source:main', 'http://a.test')
    expect(electNotificationOwner(['main'], { sourceOrigin: 'http://a.test' }, 'main')).toBe(true)
  })

  it('yields when another live window registered the same origin', () => {
    localStorage.setItem('dsh-notification-source:window-2', 'http://a.test')
    expect(electNotificationOwner(['main', 'window-2'], { sourceOrigin: 'http://a.test' }, 'window-2')).toBe(true)
    expect(electNotificationOwner(['main', 'window-2'], { sourceOrigin: 'http://a.test' }, 'main')).toBe(false)
  })
})

describe('notification payload', () => {
  it('keeps metadata and normalises a non-string input value', () => {
    expect(buildNotificationResult({ tag: 't', sessionId: 's', deliveryKey: 'd', sourceOrigin: 'http://a.test' }, 'reply', 42))
      .toEqual({ tag: 't', sessionId: 's', deliveryKey: 'd', sourceOrigin: 'http://a.test', action: 'reply', inputValue: undefined })
  })

  it('passes a string input value through', () => {
    expect(buildNotificationResult(undefined, 'reply', 'yes')?.inputValue).toBe('yes')
  })

  it('keys the same notification action identically for merge', () => {
    const payload = { tag: 't', deliveryKey: 'd' }
    expect(notificationActionKey(payload, 'reply')).toBe(notificationActionKey(payload, 'reply'))
    expect(notificationActionKey(payload, 'reply')).not.toBe(notificationActionKey(payload, 'dismiss'))
  })
})
