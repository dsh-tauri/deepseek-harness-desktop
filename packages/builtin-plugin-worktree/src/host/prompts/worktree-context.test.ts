import type { Binding } from '../types'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTestDshHome, testDshHome } from '../../../../.test/test-utils'
import { checkoutContextProvider } from './checkout-context'
import { worktreeContextProvider } from './worktree-context'
import { worktreeSectionProvider } from './worktree-section'

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  const { testDshHome: home } = await import('../../../../.test/test-utils')
  return { ...actual, DSH_HOME: home }
})

const BINDING = {
  sessionId: 'session-a',
  sourceSessionId: 'session-source',
  hash: 'abc123def456',
  dirname: 'repo',
  worktreePath: 'C:/Users/me/.dsh/worktrees/abc123def456/repo',
  projectPath: 'D:/projects/repo',
  branchName: '(detached)',
  ownsBranch: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  log: [],
} as Binding

function bind(sessionId: string, binding: Binding = { ...BINDING, sessionId }): void {
  mkdirSync(join(testDshHome, 'ledger'), { recursive: true })
  writeFileSync(join(testDshHome, 'ledger', `${sessionId}.json`), `${JSON.stringify(binding, null, 2)}\n`)
}

function scope(sessionId: string): { scope: { session: { id: string } } } {
  return { scope: { session: { id: sessionId } } }
}

beforeEach(() => {
  resetTestDshHome()
})

describe('工作树提示词注入', () => {
  it('常驻 section 带上工作树事实与项目路径隔离要求', () => {
    bind('session-a')
    const text = worktreeSectionProvider.text(scope('session-a'))
    expect(text).toContain('is_worktree: true')
    expect(text).toContain('Worktree key: abc123def456/repo')
    expect(text).toContain('Worktree path: C:/Users/me/.dsh/worktrees/abc123def456/repo')
    expect(text).toContain('Project path: D:/projects/repo')
    expect(text).toContain('do not read from or modify it in this session')
  })

  it('动态快照与常驻 section 使用同一组事实，兜住被压缩遮蔽的常驻 section', () => {
    bind('session-a')
    const context = worktreeContextProvider.text(scope('session-a'))
    expect(context).toContain('is_worktree: true')
    expect(context).toContain('Worktree key: abc123def456/repo')
    expect(context).toContain('Worktree path: C:/Users/me/.dsh/worktrees/abc123def456/repo')
    expect(context).toContain('Project path: D:/projects/repo')
    expect(worktreeSectionProvider.text(scope('session-a'))).toContain(context.split('\n\n')[0])
  })

  it('无绑定时两条通道都注入空串，不污染提示词', () => {
    expect(worktreeSectionProvider.text(scope('session-missing'))).toBe('')
    expect(worktreeContextProvider.text(scope('session-missing'))).toBe('')
    expect(worktreeContextProvider.text({})).toBe('')
    expect(worktreeSectionProvider.text({ scope: { session: { id: 42 } } })).toBe('')
  })

  it('两个 provider 的 name 互不相同，避免同一作用域重复注册', () => {
    expect(worktreeContextProvider.name).not.toBe(worktreeSectionProvider.name)
    expect(worktreeContextProvider.name).not.toBe(checkoutContextProvider.name)
  })
})
