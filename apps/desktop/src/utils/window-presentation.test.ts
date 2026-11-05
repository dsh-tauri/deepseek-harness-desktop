// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { isFullSidebarWindow, isHostedDocument, isHostedServiceDocument } from './window-presentation'

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__DSH_HOSTED__
  delete (globalThis as Record<string, unknown>).__DSH_SERVICE_ORIGIN__
  delete (globalThis as Record<string, unknown>).__DSH_NAVIGATION__
})

describe('hosted document detection', () => {
  it('is not hosted without the injected flag', () => {
    expect(isHostedDocument()).toBe(false)
    expect(isHostedServiceDocument()).toBe(false)
  })

  it('treats the injected document as hosted', () => {
    ;(globalThis as Record<string, unknown>).__DSH_HOSTED__ = true
    expect(isHostedDocument()).toBe(true)
  })

  it('recognises the DSH document only when the origin matches', () => {
    ;(globalThis as Record<string, unknown>).__DSH_HOSTED__ = true
    ;(globalThis as Record<string, unknown>).__DSH_SERVICE_ORIGIN__ = 'http://127.0.0.1:3080'
    expect(isHostedServiceDocument()).toBe(location.origin === 'http://127.0.0.1:3080')
  })

  it('ignores a hosted flag without a service origin', () => {
    ;(globalThis as Record<string, unknown>).__DSH_HOSTED__ = true
    expect(isHostedServiceDocument()).toBe(false)
  })
})

describe('full sidebar window detection', () => {
  it('requires the full-sidebar presentation', () => {
    expect(isFullSidebarWindow()).toBe(false)
    ;(globalThis as Record<string, unknown>).__DSH_NAVIGATION__ = { presentation: 'full-sidebar' }
    expect(isFullSidebarWindow()).toBe(true)
    ;(globalThis as Record<string, unknown>).__DSH_NAVIGATION__ = { presentation: 'other' }
    expect(isFullSidebarWindow()).toBe(false)
  })
})
