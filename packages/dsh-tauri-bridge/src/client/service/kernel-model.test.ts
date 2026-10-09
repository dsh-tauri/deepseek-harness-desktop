import type { StoredEntry } from 'dsh-tauri/client'
import { describe, expect, it, vi } from 'vitest'
import { canLockModelEntry, hasModelLockFace } from './kernel-model'

function entry(component = function ModelSelect() {}): StoredEntry {
  return { component, options: {}, locale: 'model', inject: () => ({}) }
}

function ThirdPartyModel() {}

function readIdentity() {}

function props(): Record<string, unknown> {
  return {
    locked: false,
    available: true,
    directory: { subscribe: () => () => {}, getSnapshot: () => ({}) },
    load: () => {},
    select: async () => {},
    useProjection: readIdentity,
  }
}

describe('official model lock capability', () => {
  it('recognizes only the verified named model renderer and its public injection', () => {
    expect(canLockModelEntry(entry())).toBe(true)
    expect(canLockModelEntry(entry(ThirdPartyModel))).toBe(false)
    expect(canLockModelEntry({ ...entry(), locale: 'settings.model' })).toBe(false)
    expect(canLockModelEntry({ ...entry(), inject: undefined })).toBe(false)
    expect(canLockModelEntry({ ...entry(), component: { $$typeof: Symbol.for('react.memo') } })).toBe(false)
  })

  it('requires the official locked owner and full observable directory business face', () => {
    expect(hasModelLockFace(props())).toBe(true)
    expect(hasModelLockFace(null)).toBe(false)
    for (const key of ['locked', 'available', 'load', 'select', 'useProjection', 'directory']) {
      const value = props()
      delete value[key]
      expect(hasModelLockFace(value)).toBe(false)
    }
    expect(hasModelLockFace({ ...props(), locked: 'true' })).toBe(false)
    expect(hasModelLockFace({ ...props(), directory: { getSnapshot: () => ({}) } })).toBe(false)
  })

  it('capability probes never invoke directory or session hooks', () => {
    const getSnapshot = vi.fn(() => ({}))
    const useProjection = vi.fn(() => null)
    expect(hasModelLockFace({ ...props(), directory: { subscribe: () => () => {}, getSnapshot }, useProjection })).toBe(true)
    expect(getSnapshot).not.toHaveBeenCalled()
    expect(useProjection).not.toHaveBeenCalled()
  })
})
