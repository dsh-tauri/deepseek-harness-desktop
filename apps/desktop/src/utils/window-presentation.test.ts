// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { isFullSidebarWindow, isHostedDocument, isHostedServiceDocument } from './window-presentation'

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__DSH_HOSTED__
  delete (globalThis as Record<string, unknown>).__DSH_SERVICE_ORIGIN__
  delete (globalThis as Record<string, unknown>).__DSH_BOOT__
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

  it('recognises a booted hosted document after its service selects a different port', () => {
    ;(globalThis as Record<string, unknown>).__DSH_HOSTED__ = true
    ;(globalThis as Record<string, unknown>).__DSH_SERVICE_ORIGIN__ = 'http://127.0.0.1:3080'
    ;(globalThis as Record<string, unknown>).__DSH_BOOT__ = { entries: [] }
    expect(isHostedServiceDocument()).toBe(true)
  })

  it('does not treat a same-origin shell bootstrap page as the DSH document', () => {
    ;(globalThis as Record<string, unknown>).__DSH_HOSTED__ = true
    ;(globalThis as Record<string, unknown>).__DSH_SERVICE_ORIGIN__ = location.origin
    expect(isHostedServiceDocument()).toBe(false)
  })

  it('does not treat a hosted bootstrap without DSH boot data as ready', () => {
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
