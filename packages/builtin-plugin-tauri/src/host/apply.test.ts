import type { HostContext, IndexInjectRow } from './types'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from './apply'

vi.mock('./server', () => ({ server: () => {} }))

afterEach(() => {
  vi.unstubAllEnvs()
})

function injections(embedded: string): IndexInjectRow[] {
  vi.stubEnv('DSH_TAURI_DESKTOP', embedded)
  const rows: IndexInjectRow[] = []
  const ctx = {
    effect(callback: () => void) { callback() },
    on(event: string, listener: (table: IndexInjectRow[]) => void) {
      expect(event).toBe('webserver/index-inject')
      listener(rows)
      return () => {}
    },
  } as unknown as HostContext
  apply(ctx)
  return rows
}

it('embedded host marker preserves the native desktop Browser bridge', () => {
  const browser = { acquire() {} }
  const native = { protocolVersion: 1, browser }
  const page = { dshDesktop: native, location: { search: '?dshDesktop' }, URLSearchParams, navigator: { userAgent: 'desktop regression' } }
  const rows = injections('1')
  expect(rows).toHaveLength(2)
  for (const row of rows) {
    if (row.kind === 'script')
      runInNewContext(row.text, page)
  }
  expect(page.dshDesktop).toBe(native)
  expect(page.dshDesktop.browser).toBe(browser)
})

it.each(['?dshDesktop', ''])('embedded host marker installs fallback only for marked pages: %s', async (search) => {
  const page: { location: { search: string }, navigator: { userAgent: string }, dshDesktop?: { protocolVersion: number, deviceInfo: () => Promise<string> } } = { location: { search }, navigator: { userAgent: 'desktop regression' } }
  const rows = injections('1')
  expect(rows).toHaveLength(2)
  for (const row of rows) {
    if (row.kind === 'script')
      runInNewContext(row.text, { ...page, URLSearchParams, globalThis: page })
  }
  if (search === '') {
    expect(page.dshDesktop).toBeUndefined()
    return
  }
  expect(page.dshDesktop?.protocolVersion).toBe(1)
  expect(await page.dshDesktop?.deviceInfo()).toBe('desktop regression')
})

it.each([['?dshDesktop=1&t=1', 'yKfg'], ['', undefined], ['?t=1', undefined]])('embedded host injects the NearToken affiliate code only into desktop pages: %s', (search, expected) => {
  const page: Record<string, unknown> = { location: { search }, URLSearchParams }
  for (const row of injections('1')) {
    if (row.kind === 'script')
      runInNewContext(row.text, page)
  }
  expect(page.NEARTOKEN_AFF).toBe(expected)
})

it('embedded host preserves kernel authentication for index and API requests', () => {
  vi.stubEnv('DSH_TAURI_DESKTOP', '1')
  const connection = {
    browserPeer: { signal: new AbortController().signal },
    disposed: false,
    admit: () => ({ rejection: 401 }),
    authorizeIndex: () => false,
  }
  const admit = connection.admit
  const authorizeIndex = connection.authorizeIndex
  const ctx = {
    connection,
    effect(callback: () => void) { callback() },
    on() { return () => {} },
  } as unknown as HostContext
  apply(ctx)
  expect(connection.admit).toBe(admit)
  expect(connection.authorizeIndex).toBe(authorizeIndex)
  expect(connection.admit()).toEqual({ rejection: 401 })
  expect(connection.authorizeIndex()).toBe(false)
})

it('non-embedded host leaves the index injection table unchanged', () => {
  expect(injections('0')).toEqual([])
})
