import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { git } from './git'

const directories: string[] = []

async function repository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-worktree-git-'))
  directories.push(cwd)
  expect(await git(['init', '--quiet'], cwd)).toEqual({ ok: true, out: '' })
  return cwd
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(cwd => rm(cwd, { recursive: true, force: true })))
})

describe('git', () => {
  it('trims stdout without interpreting shell characters in arguments', async () => {
    const cwd = await repository()
    const value = 'literal "quotes" & ; $HOME'
    expect(await git(['config', 'audit.value', value], cwd)).toEqual({ ok: true, out: '' })
    expect(await git(['config', '--get', 'audit.value'], cwd)).toEqual({ ok: true, out: value })
  })

  it('reports a nonzero status even when git writes no stderr', async () => {
    const cwd = await repository()
    const result = await git(['rev-parse', '--verify', '--quiet', 'refs/heads/missing'], cwd)
    expect(result).toEqual({
      ok: false,
      error: 'Command failed: git rev-parse --verify --quiet refs/heads/missing',
    })
  })

  it('returns the git diagnostic for a failed command', async () => {
    const cwd = await repository()
    const result = await git(['rev-parse', '--verify', 'refs/heads/missing'], cwd)
    expect(result).toEqual({ ok: false, error: 'fatal: Needed a single revision' })
  })

  it('returns failure when an abort signal is already aborted', async () => {
    const cwd = await repository()
    const controller = new AbortController()
    controller.abort()
    expect(await git(['status', '--porcelain'], cwd, { signal: controller.signal })).toMatchObject({ ok: false })
  })

  it('rejects a nonexistent cwd as an operation failure', async () => {
    const cwd = await repository()
    const missing = join(cwd, 'missing')
    const result = await git(['status'], missing)
    expect(result.ok).toBe(false)
    await mkdir(missing)
    expect((await git(['rev-parse', '--is-inside-work-tree'], missing)).ok).toBe(true)
  })
})
