import { describe, expect, it } from 'vitest'
import { bubbleContent, getLiveActivity, rawSession, sessionMotion } from './use-bubble-tracker.helpers'

describe('rawSession', () => {
  it('rejects payloads that carry no usable session id', () => {
    expect(rawSession(undefined)).toBeUndefined()
    expect(rawSession(null)).toBeUndefined()
    expect(rawSession('s1')).toBeUndefined()
    expect(rawSession({ id: '' })).toBeUndefined()
    expect(rawSession({ id: 42 })).toBeUndefined()
  })

  it('unwraps a nested session object and keeps only its own fields', () => {
    expect(rawSession({ session: { id: 's1', title: '会话一' }, extra: 1 })).toEqual({ id: 's1', title: '会话一' })
  })

  it('normalizes a flat sessionId to id', () => {
    expect(rawSession({ sessionId: 's2', title: '会话二' })).toEqual({ id: 's2', sessionId: 's2', title: '会话二' })
    expect(rawSession({ session: { sessionId: 's3' } })).toEqual({ id: 's3', sessionId: 's3' })
  })
})

describe('sessionMotion', () => {
  it('prefers the fine-grained workStatus over the coarse status', () => {
    expect(sessionMotion({ id: 's1', workStatus: 'success', status: 'error' })).toBe('success')
    expect(sessionMotion({ id: 's1', workStatus: 'waiting', status: 'failed' })).toBe('waiting')
  })

  it('maps failed/error status and a non-aborted lastAgentError to failed', () => {
    expect(sessionMotion({ id: 's1', status: 'failed' })).toBe('failed')
    expect(sessionMotion({ id: 's1', activity: 'error' })).toBe('failed')
    expect(sessionMotion({ id: 's1', lastAgentError: 'boom' })).toBe('failed')
  })

  it('treats an aborted lastAgentError as a non-failure', () => {
    expect(sessionMotion({ id: 's1', lastAgentError: 'aborted' })).toBeUndefined()
  })

  it('keeps a session that is still running out of the failed tier', () => {
    expect(sessionMotion({ id: 's1', status: 'failed', running: true })).toBe('running')
    expect(sessionMotion({ id: 's1', lastAgentError: 'boom', running: true })).toBe('running')
  })

  it('maps review inputs to the review tier', () => {
    expect(sessionMotion({ id: 's1', status: 'review' })).toBe('review')
    expect(sessionMotion({ id: 's1', activity: 'reviewing' })).toBe('review')
    expect(sessionMotion({ id: 's1', phase: 'plan-review' })).toBe('review')
  })

  it('maps waiting inputs to the waiting tier', () => {
    expect(sessionMotion({ id: 's1', status: 'waiting' })).toBe('waiting')
    expect(sessionMotion({ id: 's1', phase: 'blocked' })).toBe('waiting')
    expect(sessionMotion({ id: 's1', pendingInteraction: { id: 'q1' } })).toBe('waiting')
    expect(sessionMotion({ id: 's1', pending: ['x'] })).toBe('waiting')
  })

  it('maps running inputs to the running tier and everything else to no motion', () => {
    expect(sessionMotion({ id: 's1', status: 'running' })).toBe('running')
    expect(sessionMotion({ id: 's1', activity: 'thinking' })).toBe('running')
    expect(sessionMotion({ id: 's1', running: true })).toBe('running')
    expect(sessionMotion({ id: 's1' })).toBeUndefined()
  })
})

describe('getLiveActivity', () => {
  it('only projects live activity for active motions', () => {
    const session = { id: 's1', liveActivity: { kind: 'reasoning', text: '解析' } }
    expect(getLiveActivity(session, 'success')).toBeUndefined()
    expect(getLiveActivity(session, 'waiting')).toBeUndefined()
    expect(getLiveActivity(session, 'thinking')).toBe('思考 · 解析')
  })

  it('renders a sanitized reasoning tail', () => {
    expect(getLiveActivity({ id: 's1', liveActivity: { kind: 'reasoning', text: '  解析\n  代码  ' } }, 'thinking')).toBe('思考 · 解析 代码')
    expect(getLiveActivity({ id: 's1', liveActivity: { kind: 'reasoning', text: '   ' } }, 'thinking')).toBeUndefined()
  })

  it('renders the tool label with its argument detail', () => {
    expect(getLiveActivity({ id: 's1', liveActivity: { kind: 'tool', name: 'pwsh', args: '{"command":"ls -la"}' } }, 'working')).toBe('Pwsh · ls -la')
    expect(getLiveActivity({ id: 's1', liveActivity: { kind: 'tool', name: 'read', args: '{"file_path":["a.ts","b.ts"]}' } }, 'working')).toBe('读取 · a.ts')
  })

  it('falls back to the raw tool name and drops unusable arguments', () => {
    expect(getLiveActivity({ id: 's1', liveActivity: { kind: 'tool', name: 'custom_tool' } }, 'working')).toBe('工具调用 · custom_tool')
    expect(getLiveActivity({ id: 's1', liveActivity: { kind: 'tool', name: 'grep', args: 'not-json' } }, 'working')).toBe('Grep')
    expect(getLiveActivity({ id: 's1', liveActivity: { kind: 'tool', name: 'bash', args: '[]' } }, 'working')).toBe('Bash')
    expect(getLiveActivity({ id: 's1', liveActivity: { kind: 'tool', name: 'PWSh', args: '{"command":"pwd"}' } }, 'working')).toBe('Pwsh · pwd')
  })

  it('returns no activity for unknown or malformed payloads', () => {
    expect(getLiveActivity({ id: 's1', liveActivity: { kind: 'other', name: 'grep' } }, 'working')).toBeUndefined()
    expect(getLiveActivity({ id: 's1', liveActivity: { kind: 'tool' } }, 'working')).toBeUndefined()
    expect(getLiveActivity({ id: 's1', liveActivity: 'grep' }, 'working')).toBeUndefined()
    expect(getLiveActivity({ id: 's1' }, 'working')).toBeUndefined()
  })
})

describe('bubbleContent', () => {
  it('carries the session title, the task copy and the loading flag', () => {
    expect(bubbleContent({ id: '0', title: '会话一', task: '修复登录' }, 'working'))
      .toEqual({ title: '会话一', description: '正在修复登录', loading: true })
  })

  it('prefers the agent error over any task copy', () => {
    expect(bubbleContent({ id: '0', title: '会话一', task: '修复登录', lastAgentError: 'boom' }, 'failed'))
      .toEqual({ title: '会话一', description: '失败：boom', loading: false })
  })

  it('prefers live activity over the motion copy', () => {
    expect(bubbleContent({ id: '0', title: '会话一', liveActivity: { kind: 'reasoning', text: '解析' } }, 'thinking'))
      .toEqual({ title: '会话一', description: '思考 · 解析', loading: true })
  })

  it('uses the approval copy for a waiting approval session and keeps the title prefix', () => {
    expect(bubbleContent({ id: '0', phase: 'approval', title: '会话一' }, 'waiting'))
      .toEqual({ title: '需授权 · 会话一', description: '等待审批', loading: false })
  })

  it('selects the working-motion copy by the session id seed', () => {
    expect(bubbleContent({ id: '2', title: '会话一' }, 'working'))
      .toEqual({ title: '会话一', description: '系统运行中', loading: true })
  })

  it('selects the tool-activity copy for a working session by its tool name', () => {
    expect(bubbleContent({ id: '0', title: '会话一', liveActivity: { name: 'grep' } }, 'working'))
      .toEqual({ title: '会话一', description: '正在检索', loading: true })
    expect(bubbleContent({ id: '0', title: '会话一', liveActivity: { name: 'write' } }, 'working'))
      .toEqual({ title: '会话一', description: '正在修改', loading: true })
  })

  it('keeps the subagent prefix and selects the running copy', () => {
    expect(bubbleContent({ id: '0', origin: 'subagent', title: '会话一' }, 'running'))
      .toEqual({ title: '子代理 · 会话一', description: '任务运行中', loading: true })
  })

  it('falls back to the untitled title and the motion copy when nothing else is present', () => {
    expect(bubbleContent({ id: '0' }, 'thinking'))
      .toEqual({ title: '新会话', description: '正在分析', loading: true })
  })
})
