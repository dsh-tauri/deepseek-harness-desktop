import type { SyncItemResult } from '../../types/index'
import { describe, expect, it } from 'vitest'
import { mergeSyncResults, syncKeyOf, toggleSelection } from './sync.utils'

describe('toggleSelection', () => {
  it('toggles one key without touching the others', () => {
    const first = new Set(['plugin::p'])
    const second = toggleSelection(first, 'skill:dsh:s')
    expect([...first]).toEqual(['plugin::p'])
    expect([...second].sort()).toEqual(['plugin::p', 'skill:dsh:s'])
    expect([...toggleSelection(second, 'plugin::p')]).toEqual(['skill:dsh:s'])
  })
})

describe('key builders', () => {
  it('keys plugins by name and skills by root and name', () => {
    expect(syncKeyOf({ kind: 'plugin', name: 'p' })).toBe('plugin::p')
    expect(syncKeyOf({ kind: 'skill', name: 'alpha', root: 'dsh' })).toBe('skill:dsh:alpha')
  })
})

describe('mergeSyncResults', () => {
  const ok = (name: string): SyncItemResult => ({ kind: 'plugin', name, ok: true })

  it('keeps the first-seen order and replaces in place', () => {
    const merged = mergeSyncResults([ok('a'), ok('b')], [{ kind: 'plugin', name: 'b', ok: false, error: 'boom' }])
    expect(merged).toEqual([ok('a'), { kind: 'plugin', name: 'b', ok: false, error: 'boom' }])
  })

  it('keeps duplicate prior slots and replaces the last slot on repeated updates', () => {
    const previous = [ok('a'), ok('a')]
    const incoming: SyncItemResult[] = [ok('b'), { kind: 'plugin', name: 'a', ok: false }, { kind: 'plugin', name: 'b', ok: false }]
    expect(mergeSyncResults(previous, incoming)).toEqual([
      ok('a'),
      { kind: 'plugin', name: 'a', ok: false },
      { kind: 'plugin', name: 'b', ok: false },
    ])
    expect(previous).toEqual([ok('a'), ok('a')])
    expect(mergeSyncResults([], [])).toEqual([])
  })

  it('appends unseen items and separates skills by root', () => {
    const merged = mergeSyncResults(
      [{ kind: 'skill', name: 'alpha', root: 'dsh', ok: true }],
      [{ kind: 'skill', name: 'alpha', root: 'agents', ok: false }, ok('c')],
    )
    expect(merged).toEqual([
      { kind: 'skill', name: 'alpha', root: 'dsh', ok: true },
      { kind: 'skill', name: 'alpha', root: 'agents', ok: false },
      ok('c'),
    ])
  })
})
