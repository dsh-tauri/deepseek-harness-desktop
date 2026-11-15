import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pathService } from './path'

const { persisted, sessions } = vi.hoisted(() => ({
  persisted: new Map<string, { header: { cwd: string } }>(),
  sessions: new Map<string, { header: { cwd: string } }>(),
}))

vi.mock('dsh-h3/utils', () => ({
  getServerContext: () => ({ sessions, sessionPersistence: { stat: async (id: string) => persisted.get(id) } }),
}))
vi.mock('../server', () => ({ server: {} }))
vi.mock('dsh-tauri', () => ({
  defineService: (service: unknown) => service,
}))

describe('session workspace status', () => {
  let cwd: string
  let moved: string | undefined

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'dsh-workspace-'))
    sessions.set('session-test', { header: { cwd } })
  })

  afterEach(async () => {
    persisted.clear()
    sessions.clear()
    await rm(cwd, { recursive: true, force: true })
    if (moved !== undefined)
      await rm(moved, { recursive: true, force: true })
    moved = undefined
  })

  it('identifies the saved directory after it has been moved', async () => {
    moved = `${cwd}-moved`
    await rename(cwd, moved)
    await expect(pathService.resolveSessionDirectory('session-test')).resolves.toEqual({ status: 'missing', cwd })
  })

  it('accepts the saved path again after a directory link is restored', async () => {
    moved = `${cwd}-moved`
    await rename(cwd, moved)
    await symlink(moved, cwd, 'junction')
    await expect(pathService.resolveSessionDirectory('session-test')).resolves.toEqual({ status: 'available' })
  })

  it('reports a file replacing the saved directory', async () => {
    await rm(cwd, { recursive: true })
    await writeFile(cwd, '')
    await expect(pathService.resolveSessionDirectory('session-test')).resolves.toEqual({ status: 'not-directory', cwd })
  })

  it('returns unknown for a session without a known directory', async () => {
    await expect(pathService.resolveSessionDirectory('unknown')).resolves.toEqual({ status: 'unknown' })
  })

  it('checks the persisted header when the chat has not loaded', async () => {
    persisted.set('session-unloaded', { header: { cwd } })
    await rm(cwd, { recursive: true })
    await expect(pathService.resolveSessionDirectory('session-unloaded')).resolves.toEqual({ status: 'missing', cwd })
  })
})
