import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REMOVE_TREE_OPTIONS,
  removeDirectoryReliably,
} from './filesystem'

const temporaryDirectories: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-filesystem-'))
  temporaryDirectories.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('removeDirectoryReliably', () => {
  it('renames into same-root trash before recursively removing the tree', async () => {
    const root = await tempRoot()
    const source = join(root, 'worktrees', 'hash', 'repo')
    const trash = join(root, '.trash', 'hash', 'repo')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'large-dependency.txt'), 'content')

    const renameSpy = vi.fn(rename)
    const rmSpy = vi.fn(rm)
    await removeDirectoryReliably(source, trash, {
      lstat,
      mkdir: path => mkdir(path, { recursive: true }),
      rename: renameSpy,
      rm: rmSpy,
      delay: () => Promise.resolve(),
    })

    expect(renameSpy).toHaveBeenCalledWith(source, trash)
    expect(rmSpy).toHaveBeenCalledWith(trash, REMOVE_TREE_OPTIONS)
    expect(existsSync(source)).toBe(false)
    expect(existsSync(trash)).toBe(false)
  })

  it('falls back to fs.rm and performs outer retries when rename is unavailable', async () => {
    const root = await tempRoot()
    const source = join(root, 'worktrees', 'hash', 'repo')
    const trash = join(root, '.trash', 'hash', 'repo')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'locked.txt'), 'content')

    const renameError = Object.assign(new Error('cross-device rename'), { code: 'EXDEV' })
    const rmSpy = vi.fn<(path: string, options: typeof REMOVE_TREE_OPTIONS) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
      .mockImplementation((path, options) => rm(path, options))
    const delaySpy = vi.fn(() => Promise.resolve())

    await removeDirectoryReliably(source, trash, {
      lstat,
      mkdir: path => mkdir(path, { recursive: true }),
      rename: () => Promise.reject(renameError),
      rm: rmSpy,
      delay: delaySpy,
    })

    expect(rmSpy).toHaveBeenCalledTimes(3)
    expect(rmSpy).toHaveBeenNthCalledWith(1, source, REMOVE_TREE_OPTIONS)
    expect(delaySpy).toHaveBeenCalledTimes(2)
    expect(delaySpy).toHaveBeenCalledWith(2_000)
    expect(existsSync(source)).toBe(false)
  })

  it('finishes deleting deterministic trash left by an interrupted attempt', async () => {
    const root = await tempRoot()
    const source = join(root, 'worktrees', 'hash', 'repo')
    const trash = join(root, '.trash', 'hash', 'repo')
    await mkdir(trash, { recursive: true })
    await writeFile(join(trash, 'residue.txt'), 'content')
    const renameSpy = vi.fn(rename)

    await removeDirectoryReliably(source, trash, {
      lstat,
      mkdir: path => mkdir(path, { recursive: true }),
      rename: renameSpy,
      rm,
      delay: () => Promise.resolve(),
    })

    expect(renameSpy).not.toHaveBeenCalled()
    expect(existsSync(trash)).toBe(false)
  })
})
