import type { Binding } from '../types'
import { describe, expect, it } from 'vitest'
import { worktreeSectionText } from './worktree-facts'

describe('worktreeSectionText', () => {
  it('preserves isolated worktree facts without referring to removed model tools', () => {
    const text = worktreeSectionText({
      hash: 'abc123',
      dirname: 'feature',
      worktreePath: 'C:/worktrees/abc123/feature',
      projectPath: 'C:/project',
    } as Binding)

    expect(text).toContain('is_worktree: true')
    expect(text).toContain('Worktree key: abc123/feature')
    expect(text).toContain('Worktree path: C:/worktrees/abc123/feature')
    expect(text).toContain('Project path: C:/project')
    expect(text).toContain('do not read from or modify it in this session')
    expect(text).not.toContain('create_worktree')
    expect(text).not.toContain('checkout_worktree')
  })
})
