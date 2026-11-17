import type { RemoteCoreSlot, RemoteCoreVersion } from './remote-core.rows'
import { describe, expect, it } from 'vitest'
import { buildRemoteCoreRows } from './remote-core.rows'

const versions: RemoteCoreVersion[] = [
  { version: '0.2.6', tag: 'dsh-0.2.6-1', preview: false },
  { version: '0.2.5-beta.1', tag: 'dsh-0.2.5-beta.1-2', preview: true },
  { version: '0.2.4', tag: 'dsh-0.2.4-1', preview: false },
]

function installed(slot: Partial<Extract<RemoteCoreSlot, { kind: 'installed' }>> & { slotKey: string, version: string }): RemoteCoreSlot {
  return {
    kind: 'installed',
    active: false,
    removable: true,
    preview: false,
    ...slot,
  } as RemoteCoreSlot
}

describe('远端核心清单合成', () => {
  it('marks the copy in use and the copies already downloaded', () => {
    const rows = buildRemoteCoreRows([
      installed({ slotKey: 'dsh', version: '0.2.4', active: true, removable: false }),
      installed({ slotKey: 'dsh-0.2.5-beta.1-2', tag: 'dsh-0.2.5-beta.1-2', version: '0.2.5-beta.1' }),
    ], versions)

    expect(rows.map(row => [row.version, row.present, row.active])).toEqual([
      ['0.2.6', false, false],
      ['0.2.5-beta.1', true, false],
      ['0.2.4', true, true],
    ])
    expect(rows.find(row => row.version === '0.2.5-beta.1')?.preview).toBe(true)
    expect(rows.find(row => row.version === '0.2.6')?.tag).toBe('dsh-0.2.6-1')
  })

  it('keeps a copy that is no longer published as an orphaned row', () => {
    const rows = buildRemoteCoreRows([
      installed({ slotKey: 'dsh-0.2.0-1', tag: 'dsh-0.2.0-1', version: '0.2.0' }),
    ], versions)

    const orphan = rows.find(row => row.version === '0.2.0')
    expect(orphan?.orphaned).toBe(true)
    expect(orphan?.removable).toBe(true)
    expect(orphan?.present).toBe(true)
  })

  it('does not orphan a downloaded copy when another copy already claimed the published version', () => {
    const rows = buildRemoteCoreRows([
      installed({ slotKey: 'dsh', version: '0.2.4', active: true, removable: false }),
      installed({ slotKey: 'dsh-0.2.4-1', tag: 'dsh-0.2.4-1', version: '0.2.4' }),
    ], versions)

    expect(rows.filter(row => row.version === '0.2.4')).toHaveLength(2)
    expect(rows.filter(row => row.version === '0.2.4').every(row => row.orphaned === false)).toBe(true)
  })

  it('keeps the copy in use visible even without a published version', () => {
    const rows = buildRemoteCoreRows([
      installed({ slotKey: 'dsh', version: '0.2.3', active: true, removable: false }),
    ], versions)

    const active = rows.find(row => row.version === '0.2.3')
    expect(active?.active).toBe(true)
    expect(active?.present).toBe(true)
    expect(active?.removable).toBe(false)
    expect(active?.orphaned).toBe(false)
  })

  it('reports an unsupported copy without hiding it', () => {
    const rows = buildRemoteCoreRows([
      { kind: 'unsupported', slotKey: 'dsh-0.2.1-1', version: '0.2.1', tag: 'dsh-0.2.1-1', error: 'REMOTE_DSH_VERSION_UNSUPPORTED' },
    ], versions)

    const unsupported = rows.find(row => row.version === '0.2.1')
    expect(unsupported?.unsupported).toBe(true)
    expect(unsupported?.error).toBe('REMOTE_DSH_VERSION_UNSUPPORTED')
    expect(unsupported?.orphaned).toBe(false)
  })

  it('reports an unreadable copy instead of dropping it', () => {
    const rows = buildRemoteCoreRows([
      { kind: 'unreadable', slotKey: 'broken', error: 'REMOTE_DSH_PACKAGE_INVALID' },
    ], versions)

    const unreadable = rows.find(row => row.id === 'slot:broken')
    expect(unreadable?.error).toBe('REMOTE_DSH_PACKAGE_INVALID')
    expect(unreadable?.present).toBe(true)
  })
})
