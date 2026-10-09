// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePetSource } from './use-pet-source'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function asset(id: string) {
  return { id, spritesheet: `data:image/png;base64,${id}`, sprite_version_number: 2, columns: 8, rows: 9 }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('pet source requests', () => {
  it.each(['resolve', 'reject'] as const)('preserves the current pet when an older request finishes with %s', async (completion) => {
    const old = deferred<ReturnType<typeof asset>>()
    invoke.mockImplementation((command, args) => command === 'log_frontend' ? Promise.resolve() : args.id === 'codex:old' ? old.promise : Promise.resolve(asset(args.id)))
    const { result, rerender } = renderHook(({ id }) => usePetSource(id), { initialProps: { id: 'codex:old' } })
    rerender({ id: 'codex:new' })
    await act(async () => {})
    expect(result.current.source?.uri).toBe('data:image/png;base64,codex:new')
    await act(async () => {
      if (completion === 'resolve')
        old.resolve(asset('codex:old'))
      else
        old.reject(new Error('old request failed'))
    })
    expect(result.current.source?.uri).toBe('data:image/png;base64,codex:new')
    expect(result.current.error).toBeNull()
  })

  it('does not restore an asset after selection is cleared', async () => {
    const pending = deferred<ReturnType<typeof asset>>()
    invoke.mockReturnValue(pending.promise)
    const { result, rerender } = renderHook(({ id }) => usePetSource(id), { initialProps: { id: 'codex:old' } })
    rerender({ id: '' })
    await act(async () => {
      pending.resolve(asset('codex:old'))
    })
    expect(result.current).toEqual({ source: null, error: null })
  })
})
