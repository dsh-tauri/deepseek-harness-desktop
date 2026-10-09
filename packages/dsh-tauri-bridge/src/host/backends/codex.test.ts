import type { Frame } from './process.fixture'
import type { NativeSession } from './types'
import { spawn } from 'node:child_process'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodexSession } from './codex'
import { createSink, ProcessFixture } from './process.fixture'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const command = { file: 'C:/fixture/codex.exe', args: [], env: {} }
const sessions: NativeSession[] = []

interface Terminal {
  itemId: string
  processId: string
}

function codexProcess(options: {
  threadId?: string
  terminals?: Terminal[]
  intercept?: (frame: Frame, fixture: ProcessFixture) => boolean
} = {}) {
  const terminals = options.terminals ?? []
  const fixture = new ProcessFixture((frame) => {
    if (options.intercept?.(frame, fixture))
      return
    switch (frame.method) {
      case 'initialize':
        fixture.send({ id: frame.id, result: { userAgent: 'codex-cli/fixture' } })
        break
      case 'thread/start':
      case 'thread/resume':
        fixture.send({ id: frame.id, result: { thread: { id: options.threadId ?? 'thread-1' } } })
        break
      case 'thread/backgroundTerminals/list':
        fixture.send({ id: frame.id, result: { data: [...terminals], nextCursor: null } })
        break
      case 'thread/backgroundTerminals/terminate': {
        const params = frame.params as Frame
        const index = terminals.findIndex(terminal => terminal.processId === params.processId)
        if (index >= 0)
          terminals.splice(index, 1)
        fixture.send({ id: frame.id, result: { terminated: index >= 0 } })
        break
      }
      case 'turn/start':
        fixture.send({ id: frame.id, result: { turn: { id: 'turn-1' } } })
        break
      case 'turn/interrupt':
        fixture.send({ id: frame.id, result: {} })
    }
  })
  vi.mocked(spawn).mockReturnValue(fixture.child)
  return { fixture, terminals }
}

async function open(storedId: string | null = null, sink = createSink()) {
  const session = await createCodexSession(command, 'C:/fixture/workspace', storedId, sink, new AbortController().signal)
  sessions.push(session)
  return session
}

const user = () => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'inspect the workspace' }] })
const completed = (fixture: ProcessFixture, status = 'completed') => fixture.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status } } })
const notify = (fixture: ProcessFixture, method: string, params: Frame) => fixture.send({ method, params: { threadId: 'thread-1', turnId: 'turn-1', ...params } })

beforeEach(() => vi.mocked(spawn).mockReset())
afterEach(async () => {
  for (const session of sessions.splice(0))
    await session.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('codex native app-server contract', () => {
  it('creates one native thread without a prompt or DSH tool injection', async () => {
    const { fixture } = codexProcess()
    const session = await open()
    expect(session.id).toBe('thread-1')
    expect(spawn).toHaveBeenCalledWith('C:/fixture/codex.exe', ['app-server', '--listen', 'stdio://'], {
      cwd: 'C:/fixture/workspace',
      env: {},
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    expect(fixture.frames.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'thread/start', 'thread/backgroundTerminals/list'])
    expect(fixture.frames[2]).toEqual({ id: 2, method: 'thread/start', params: { cwd: 'C:/fixture/workspace' } })
  })

  it('resumes exactly the stored native thread without starting a replacement', async () => {
    const { fixture } = codexProcess({ threadId: 'stored-thread' })
    const session = await open('stored-thread')
    expect(session.id).toBe('stored-thread')
    expect(fixture.frames[2]).toEqual({ id: 2, method: 'thread/resume', params: { threadId: 'stored-thread', cwd: 'C:/fixture/workspace' } })
    expect(fixture.frames.some(frame => frame.method === 'thread/start')).toBe(false)
  })

  it('refuses a changed resume id instead of silently binding a new thread', async () => {
    const { fixture } = codexProcess({ threadId: 'different-thread' })
    await expect(open('stored-thread')).rejects.toMatchObject({ code: 'BRIDGE_RESUME_MISMATCH' })
    expect(fixture.frames.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'thread/resume'])
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('refuses an unavailable background cleanup capability before any native input', async () => {
    const { fixture } = codexProcess({ intercept: (frame, child) => {
      if (frame.method !== 'thread/backgroundTerminals/list')
        return false
      child.send({ id: frame.id, error: { code: -32601, message: 'Unknown method' } })
      return true
    } })
    await expect(open()).rejects.toMatchObject({ code: 'BRIDGE_NATIVE_REQUEST', message: 'Unknown method' })
    expect(fixture.frames.some(frame => frame.method === 'turn/start')).toBe(false)
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('commits authoritative assistant content once after live text and reasoning deltas', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    const request = await started
    expect(request.params).toEqual({ threadId: 'thread-1', input: [{ type: 'text', text: 'inspect the workspace', text_elements: [] }] })
    notify(fixture, 'item/agentMessage/delta', { itemId: 'assistant-1', delta: 'hel' })
    notify(fixture, 'item/agentMessage/delta', { itemId: 'assistant-1', delta: 'lo' })
    notify(fixture, 'item/reasoning/summaryTextDelta', { itemId: 'reasoning-1', delta: 'verify first' })
    const assistant = { itemId: 'assistant-1', item: { id: 'assistant-1', type: 'agentMessage', text: 'hello' } }
    notify(fixture, 'item/completed', assistant)
    notify(fixture, 'item/completed', assistant)
    notify(fixture, 'item/completed', { item: { id: 'reasoning-1', type: 'reasoning', summary: ['verify first'], content: [] } })
    completed(fixture)
    await submitted
    expect(sink.text.mock.calls).toEqual([['assistant-1', 'hel'], ['assistant-1', 'lo']])
    expect(sink.thinking.mock.calls).toEqual([['reasoning-1', 'verify first']])
    expect(sink.assistant.mock.calls).toEqual([
      ['assistant-1', [{ type: 'text', text: 'hello' }]],
      ['reasoning-1', [{ type: 'thinking', text: 'verify first' }]],
    ])
  })

  it.each(['raw', 'summary'] as const)('streams only the first %s reasoning track while settling the canonical summary', async (first) => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const tracks = first === 'raw' ? ['raw', 'summary'] : ['summary', 'raw']
    for (const track of tracks)
      notify(fixture, track === 'raw' ? 'item/reasoning/textDelta' : 'item/reasoning/summaryTextDelta', { itemId: 'reasoning-2', delta: `${track} reasoning` })
    notify(fixture, 'item/completed', { item: { id: 'reasoning-2', type: 'reasoning', summary: ['summary reasoning'], content: ['raw reasoning'] } })
    completed(fixture)
    await submitted
    expect(sink.thinking.mock.calls).toEqual([['reasoning-2', `${first} reasoning`]])
    expect(sink.assistant.mock.calls).toEqual([['reasoning-2', [{ type: 'thinking', text: 'summary reasoning' }]]])
  })

  it('preserves native tool ids and error results without executing DSH tools', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const item = { id: 'command-1', type: 'commandExecution', command: 'git status', cwd: 'C:/fixture/workspace', status: 'inProgress' }
    notify(fixture, 'item/started', { item })
    notify(fixture, 'item/commandExecution/outputDelta', { itemId: 'command-1', delta: 'fatal:' })
    notify(fixture, 'item/completed', { item: { ...item, status: 'completed', aggregatedOutput: 'fatal: not a git repository', exitCode: 128 } })
    notify(fixture, 'item/completed', { item: { ...item, status: 'completed', aggregatedOutput: 'fatal: not a git repository', exitCode: 128 } })
    completed(fixture)
    await submitted
    const arguments_ = '{"command":"git status","cwd":"C:/fixture/workspace"}'
    expect(sink.assistant.mock.calls).toEqual([['command-1:call', [{ type: 'tool-call', id: 'command-1', name: 'commandExecution', arguments: arguments_ }]]])
    expect(sink.toolStart.mock.calls).toEqual([['command-1', 'commandExecution', arguments_]])
    expect(sink.toolEnd.mock.calls).toEqual([['command-1', 'fatal: not a git repository', true]])
  })

  it.each(['item/started', 'item/completed'] as const)('presents each tool before starting it when the first native notification is %s', async (first) => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const order: string[] = []
    sink.assistant.mockImplementation(id => order.push(`assistant:${id}`))
    sink.toolStart.mockImplementation(id => order.push(`start:${id}`))
    sink.toolEnd.mockImplementation(id => order.push(`end:${id}`))
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    const settled = vi.fn()
    void submitted.then(settled, settled)
    await started
    try {
      const firstTool = { id: 'parallel-command-1', type: 'commandExecution', command: 'git status', cwd: 'C:/fixture/workspace', status: first === 'item/completed' ? 'completed' : 'inProgress', aggregatedOutput: 'first output', exitCode: 0 }
      notify(fixture, first, { item: firstTool })
      if (first === 'item/started')
        notify(fixture, 'item/completed', { item: { ...firstTool, status: 'completed' } })
      await Promise.resolve()
      expect(order).toEqual(['assistant:parallel-command-1:call', 'start:parallel-command-1', 'end:parallel-command-1'])
      expect(settled).not.toHaveBeenCalled()
      await expect(session.submit([user()], new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_BUSY' })
      const secondTool = { id: 'parallel-command-2', type: 'commandExecution', command: 'git diff', cwd: 'C:/fixture/workspace', status: first === 'item/completed' ? 'completed' : 'inProgress', aggregatedOutput: 'second output', exitCode: 0 }
      notify(fixture, first, { item: secondTool })
      if (first === 'item/started')
        notify(fixture, 'item/completed', { item: { ...secondTool, status: 'completed' } })
      await Promise.resolve()
      expect(settled).not.toHaveBeenCalled()
      expect(order).toEqual([
        'assistant:parallel-command-1:call',
        'start:parallel-command-1',
        'end:parallel-command-1',
        'assistant:parallel-command-2:call',
        'start:parallel-command-2',
        'end:parallel-command-2',
      ])
      expect(sink.assistant.mock.calls).toEqual([
        ['parallel-command-1:call', [{ type: 'tool-call', id: 'parallel-command-1', name: 'commandExecution', arguments: '{"command":"git status","cwd":"C:/fixture/workspace"}' }]],
        ['parallel-command-2:call', [{ type: 'tool-call', id: 'parallel-command-2', name: 'commandExecution', arguments: '{"command":"git diff","cwd":"C:/fixture/workspace"}' }]],
      ])
      expect(sink.toolEnd.mock.calls).toEqual([['parallel-command-1', 'first output', false], ['parallel-command-2', 'second output', false]])
    }
    finally {
      completed(fixture)
      await submitted
    }
    expect(settled).toHaveBeenCalledTimes(1)
    expect(fixture.frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1)
    expect(fixture.frames.some(frame => frame.method === 'turn/interrupt')).toBe(false)
    expect(fixture.kill).not.toHaveBeenCalled()
  })

  it('routes a parked approval while RPC traffic continues and returns only allow-once', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    let allow!: (value: boolean) => void
    const asked = Promise.withResolvers<void>()
    sink.approval.mockImplementation(() => {
      asked.resolve()
      return new Promise(resolve => allow = resolve)
    })
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const answered = fixture.next(frame => frame.id === 77 && 'result' in frame)
    fixture.send({ id: 77, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-approval', command: 'git status' } })
    await asked.promise
    notify(fixture, 'item/agentMessage/delta', { itemId: 'assistant-1', delta: 'awaiting your answer' })
    expect(sink.text).toHaveBeenCalledWith('assistant-1', 'awaiting your answer')
    allow(true)
    expect(await answered).toEqual({ id: 77, result: { decision: 'accept' } })
    expect(sink.approval.mock.calls[0]?.slice(0, 2)).toEqual(['command-approval', {
      kind: 'command',
      title: 'git status',
      details: '{"threadId":"thread-1","turnId":"turn-1","itemId":"command-approval","command":"git status"}',
    }])
    completed(fixture)
    await submitted
  })

  it('withdraws a resolved native approval without sending a late grant', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const parked = Promise.withResolvers<boolean>()
    sink.approval.mockReturnValue(parked.promise)
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    fixture.send({ id: 78, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'edit-1' } })
    const signal = sink.approval.mock.calls[0]![2]!
    fixture.send({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 78 } })
    parked.resolve(true)
    await parked.promise
    completed(fixture)
    await submitted
    expect(signal.aborted).toBe(true)
    expect(fixture.frames.some(frame => frame.id === 78)).toBe(false)
  })

  it('maps native question identities to answer arrays in the official question sink', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    sink.questions.mockResolvedValue({ language: 'TypeScript', focus: ['Events', 'Cancel'] })
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const answered = fixture.next(frame => frame.id === 'question-1')
    fixture.send({ id: 'question-1', method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'question-tool', questions: [
      { id: 'language', question: 'Which language?', options: [{ label: 'TypeScript', description: 'Typed code' }] },
      { id: 'focus', question: 'Which areas?' },
    ] } })
    expect(await answered).toEqual({ id: 'question-1', result: { answers: { language: { answers: ['TypeScript'] }, focus: { answers: ['Events', 'Cancel'] } } } })
    expect(sink.questions.mock.calls[0]?.slice(0, 2)).toEqual(['question-tool', [
      { id: 'language', question: 'Which language?', options: [{ label: 'TypeScript', description: 'Typed code' }] },
      { id: 'focus', question: 'Which areas?' },
    ]])
    completed(fixture)
    await submitted
  })

  it('rejects secret questions without persisting their answers', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const answered = fixture.next(frame => frame.id === 79)
    fixture.send({ id: 79, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'secret', questions: [{ id: 'password', question: 'Password?', isSecret: true }] } })
    expect(await answered).toMatchObject({ id: 79, error: { code: -32603, message: 'Secret native questions cannot be recorded in the official session log' } })
    expect(sink.questions).not.toHaveBeenCalled()
    completed(fixture)
    await submitted
  })

  it('cleans only interrupted turn terminals before declaring cancellation settled', async () => {
    const { fixture, terminals } = codexProcess({ terminals: [{ itemId: 'old-command', processId: 'old-process' }] })
    const session = await open()
    const signal = new AbortController()
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], signal.signal)
    const rejected = expect(submitted).rejects.toThrow('cancel this turn')
    await started
    terminals.push({ itemId: 'command-1', processId: 'new-process' })
    notify(fixture, 'item/started', { item: { id: 'command-1', type: 'commandExecution', command: 'watch', processId: 'new-process' } })
    const interrupted = fixture.next(frame => frame.method === 'turn/interrupt')
    signal.abort(new Error('cancel this turn'))
    expect(await interrupted).toMatchObject({ params: { threadId: 'thread-1', turnId: 'turn-1' } })
    completed(fixture, 'interrupted')
    await rejected
    expect(fixture.frames.filter(frame => frame.method === 'thread/backgroundTerminals/terminate').map(frame => frame.params)).toEqual([{ threadId: 'thread-1', processId: 'new-process' }])
    expect(terminals).toEqual([{ itemId: 'old-command', processId: 'old-process' }])
  })

  it('obtains the turn id and interrupts even when cancelled before turn/start replies', async () => {
    const { fixture } = codexProcess({ intercept: frame => frame.method === 'turn/start' })
    const session = await open()
    const signal = new AbortController()
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], signal.signal)
    const rejected = expect(submitted).rejects.toThrow('cancel early')
    const request = await started
    signal.abort(new Error('cancel early'))
    const interrupted = fixture.next(frame => frame.method === 'turn/interrupt')
    fixture.send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
    fixture.send({ id: request.id, result: { turn: { id: 'turn-1' } } })
    await interrupted
    completed(fixture, 'interrupted')
    await rejected
    expect(fixture.frames.filter(frame => frame.method === 'turn/interrupt')).toHaveLength(1)
  })

  it('terminates late commands belonging to a cancelled native turn', async () => {
    const { fixture, terminals } = codexProcess()
    const session = await open()
    const signal = new AbortController()
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], signal.signal)
    const rejected = expect(submitted).rejects.toThrow('cancel late test')
    await started
    const interrupted = fixture.next(frame => frame.method === 'turn/interrupt')
    signal.abort(new Error('cancel late test'))
    await interrupted
    completed(fixture, 'interrupted')
    await rejected
    terminals.push({ itemId: 'late-command', processId: 'late-process' })
    const terminated = fixture.next(frame => frame.method === 'thread/backgroundTerminals/terminate')
    notify(fixture, 'item/started', { item: { id: 'late-command', type: 'commandExecution', command: 'watch', processId: 'late-process' } })
    expect(await terminated).toMatchObject({ params: { threadId: 'thread-1', processId: 'late-process' } })
    expect(terminals).toEqual([])
  })

  it('fails closed when interrupted background terminals remain after termination', async () => {
    const { fixture, terminals } = codexProcess({ intercept: (frame, child) => {
      if (frame.method !== 'thread/backgroundTerminals/terminate')
        return false
      child.send({ id: frame.id, result: { terminated: false } })
      return true
    } })
    const session = await open()
    const signal = new AbortController()
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], signal.signal)
    const rejected = expect(submitted).rejects.toMatchObject({ code: 'BRIDGE_INTERRUPT_CLEANUP_FAILED' })
    await started
    terminals.push({ itemId: 'stuck-command', processId: 'stuck-process' })
    signal.abort(new Error('cancel'))
    await rejected
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
    expect(fixture.frames.some(frame => frame.method === 'turn/interrupt')).toBe(false)
  })

  it('rejects nontext user content rather than submitting a partial native prompt', async () => {
    const { fixture } = codexProcess()
    const session = await open()
    const input = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'reasoning', text: 'not user text' }] })
    await expect(session.submit([input], new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_UNSUPPORTED_CONTENT' })
    expect(fixture.frames.some(frame => frame.method === 'turn/start')).toBe(false)
  })

  it('propagates a native crash and clears active control waits', async () => {
    const { fixture } = codexProcess()
    const session = await open()
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    const rejected = expect(submitted).rejects.toMatchObject({ code: 'BRIDGE_PROCESS_EXIT', message: 'Native process exited (7): native crash' })
    await started
    fixture.stderr.write('native crash')
    fixture.exit(7)
    await rejected
    await expect(session.submit([user()], new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_PROCESS_EXIT' })
  })
})
