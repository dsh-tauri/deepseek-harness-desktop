import type { Binding } from '../types'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTestDshHome, testDshHome } from '../../../../.test/test-utils'
import { ledger } from './ledger'

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  const { testDshHome: home } = await import('../../../../.test/test-utils')
  return { ...actual, DSH_HOME: home }
})

beforeEach(() => {
  resetTestDshHome()
})

function makeBinding(sessionId: string, hash = 'hash-a'): Binding {
  return {
    sessionId,
    sourceSessionId: 'source-a',
    hash,
    dirname: 'repo',
    worktreePath: join(tmpdir(), `wt-${sessionId}`),
    projectPath: '/tmp/repo',
    branchName: 'dsh/x',
    ownsBranch: true,
    createdAt: new Date().toISOString(),
    log: [],
  }
}

describe('按会话分文件的 binding ledger', () => {
  it('save/load 往返一致', async () => {
    const binding = makeBinding('session-1')
    await ledger.save('session-1', binding)
    expect(ledger.load('session-1')).toEqual(binding)
  })

  it('同组不同会话各自读写互不干扰；覆盖只作用于自己的文件', async () => {
    const a = makeBinding('session-a', 'hash-a')
    const b = makeBinding('session-b', 'hash-b')
    await ledger.save('session-a', a)
    await ledger.save('session-b', b)
    await ledger.save('session-a', { ...a, branchName: 'dsh/updated' })

    expect(ledger.load('session-a')).toMatchObject({ branchName: 'dsh/updated' })
    expect(ledger.load('session-b')).toEqual(b)
    expect(ledger.load('session-none')).toBeNull()
  })

  it('remove 只删指定会话，其余保留', async () => {
    await ledger.save('session-a', makeBinding('session-a'))
    await ledger.save('session-b', makeBinding('session-b'))
    await ledger.remove('session-a')

    expect(ledger.load('session-a')).toBeNull()
    expect(ledger.load('session-b')).toMatchObject({ sessionId: 'session-b' })
    await expect(ledger.remove('session-a')).resolves.toBeUndefined()
  })

  it('list 枚举当前全部绑定', async () => {
    await ledger.save('session-x', makeBinding('session-x', 'hash-x'))
    await ledger.save('session-y', makeBinding('session-y', 'hash-y'))

    expect(ledger.list().map(b => b.sessionId).sort()).toEqual(['session-x', 'session-y'])
    expect(readdirSync(join(testDshHome, 'ledger')).sort()).toEqual(['session-x.json', 'session-y.json'])
  })

  it('无 ledger/ 目录时读取与枚举均安全', () => {
    expect(ledger.load('any')).toBeNull()
    expect(ledger.list()).toEqual([])
    expect(existsSync(join(testDshHome, 'ledger'))).toBe(false)
  })

  it('损坏的 ledger 文件按无绑定处理，不阻断其余会话', async () => {
    await ledger.save('session-good', makeBinding('session-good'))
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(testDshHome, 'ledger', 'session-broken.json'), '{ not json')

    expect(ledger.load('session-broken')).toBeNull()
    expect(ledger.list().map(b => b.sessionId)).toEqual(['session-good'])
  })
})
