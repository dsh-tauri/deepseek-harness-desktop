import { describe, expect, it, vi } from 'vitest'
import { inject } from '../index'
import { apply } from './apply'
import { handleSessionEvent } from './events/session-event'
import { handleToolsExecute } from './events/tools-execute'
import { checkoutContextProvider } from './prompts/checkout-context'
import { worktreeContextProvider } from './prompts/worktree-context'
import { worktreeSectionProvider } from './prompts/worktree-section'

describe('worktree plugin registration', () => {
  it('activates without a tools service while retaining events, prompts and lifecycle effects', () => {
    const on = vi.fn()
    const effect = vi.fn()
    const section = vi.fn()
    const context = vi.fn()

    apply({ on, effect, systemPrompt: { section, context } })

    expect(inject).not.toContain('tools')
    expect(on.mock.calls).toEqual([
      ['session/event', handleSessionEvent],
      ['tools/execute', handleToolsExecute],
    ])
    expect(section).toHaveBeenCalledExactlyOnceWith(worktreeSectionProvider)
    expect(context.mock.calls).toEqual([[worktreeContextProvider], [checkoutContextProvider]])
    expect(effect.mock.calls.map(([, label]) => label)).toEqual([
      'plugin: routes',
      'plugin: unregister legacy worktree workspaces',
      'plugin: worktree discard recovery',
      'plugin: host runtime',
    ])
  })
})
