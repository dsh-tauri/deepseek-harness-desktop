import type { StoredEntry } from 'dsh-tauri/client'

export function canLockModelEntry(entry: StoredEntry): boolean {
  return entry.locale === 'model'
    && typeof entry.component === 'function' && entry.component.name === 'ModelSelect'
    && typeof entry.inject === 'function'
}

export function hasModelLockFace(value: unknown): boolean {
  if (typeof value !== 'object' || value === null)
    return false
  const props = value as Record<string, unknown>
  const directory = props.directory
  return typeof props.locked === 'boolean' && typeof props.available === 'boolean'
    && typeof props.load === 'function' && typeof props.select === 'function'
    && typeof directory === 'object' && directory !== null
    && 'subscribe' in directory && typeof directory.subscribe === 'function'
    && 'getSnapshot' in directory && typeof directory.getSnapshot === 'function'
    && typeof props.useProjection === 'function'
}
