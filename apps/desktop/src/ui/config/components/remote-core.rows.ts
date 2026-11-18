import type { GetApiTauriRemoteCoreCurrentResponse, GetApiTauriRemoteCoreVersionsResponse } from '@/apis/remote.types'
import { compareVersions } from '@/utils/core-version'

export type RemoteCoreTarget = NonNullable<GetApiTauriRemoteCoreCurrentResponse['item']>
export type RemoteCoreSlot = Extract<RemoteCoreTarget, { availability: 'present' }>['slots'][number]
export type RemoteCoreVersion = NonNullable<GetApiTauriRemoteCoreVersionsResponse['items']>[number]

export interface RemoteCoreRow {
  id: string
  version: string
  tag?: string
  dir?: string
  present: boolean
  active: boolean
  removable: boolean
  preview: boolean
  orphaned: boolean
  unsupported: boolean
  error?: string
}

export function buildRemoteCoreRows(slots: RemoteCoreSlot[], versions: RemoteCoreVersion[]): RemoteCoreRow[] {
  const rows: RemoteCoreRow[] = []
  const claimed = new Set<RemoteCoreSlot>()
  const published = new Set(versions.map(version => version.version))
  for (const version of versions) {
    const slot = slots.find(item => !claimed.has(item) && item.kind !== 'unreadable' && item.version === version.version)
    if (slot === undefined) {
      rows.push({
        id: `version:${version.version}`,
        version: version.version,
        tag: version.tag,
        present: false,
        active: false,
        removable: false,
        preview: version.preview,
        orphaned: false,
        unsupported: false,
      })
      continue
    }
    claimed.add(slot)
    rows.push({
      id: `slot:${slot.slotKey}`,
      version: version.version,
      tag: slot.tag ?? version.tag,
      ...slot.dir === undefined ? {} : { dir: slot.dir },
      present: true,
      active: slot.kind === 'installed' && slot.active,
      removable: slot.kind === 'installed' && !slot.active && slot.removable !== false,
      preview: version.preview,
      orphaned: false,
      unsupported: slot.kind === 'unsupported',
      ...slot.kind === 'unsupported' ? { error: slot.error } : {},
    })
  }
  for (const slot of slots) {
    if (claimed.has(slot))
      continue
    if (slot.kind === 'unreadable') {
      rows.push({
        id: `slot:${slot.slotKey}`,
        version: slot.slotKey,
        present: true,
        active: false,
        removable: false,
        preview: false,
        orphaned: false,
        unsupported: false,
        error: slot.error,
      })
      continue
    }
    const active = slot.kind === 'installed' && slot.active
    rows.push({
      id: `slot:${slot.slotKey}`,
      version: slot.version,
      ...slot.tag === undefined ? {} : { tag: slot.tag },
      ...slot.dir === undefined ? {} : { dir: slot.dir },
      present: true,
      active,
      removable: !active && slot.kind === 'installed',
      preview: slot.kind === 'installed' ? slot.preview : false,
      orphaned: !active && slot.kind === 'installed' && !published.has(slot.version),
      unsupported: slot.kind === 'unsupported',
      ...slot.kind === 'unsupported' ? { error: slot.error } : {},
    })
  }
  return rows.sort((left, right) => compareVersions(right.version, left.version))
}
