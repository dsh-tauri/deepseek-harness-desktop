import type { Frame } from './process.fixture'
import type { NativeSession, NativeSessionOpenOptions } from './types'
import { spawn } from 'node:child_process'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClaudeSession } from './claude'
import { createSink, ProcessFixture } from './process.fixture'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const command = { file: 'C:/fixture/claude.exe', args: [], env: { PATH: 'C:/fixture/bin' } }
const storedId = '11111111-1111-4111-8111-111111111111'
const sessions: NativeSession[] = []
const initialization = { subtype: 'initialize', hooks: { SessionStart: [{ hookCallbackIds: ['dsh-native-session-identity'] }] } }

function claudeProcess(options: {
  acknowledge?: boolean
  useSystemInit?: boolean
  useSnapshot?: boolean
  mismatch?: boolean
  forkId?: string
  model?: string
  models?: Frame[]
  account?: Frame
  capabilities?: string[]
  intercept?: (frame: Frame, fixture: ProcessFixture) => boolean
} = {}) {
  const useSnapshot = options.useSnapshot ?? !options.useSystemInit
  let initializationCount = 0
  const fixture = new ProcessFixture((frame) => {
    if (options.intercept?.(frame, fixture))
      return
    if (frame.type === 'control_request') {
      const request = frame.request as Frame
      const response: Frame = {}
      if (request.subtype === 'initialize') {
        initializationCount++
        const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[]
        const nativeId = args.find(arg => arg.startsWith('--session-id=') || arg.startsWith('--resume='))!.split('=')[1]!
        const acknowledgedId = options.mismatch ? 'different-native-session' : args.includes('--fork-session') ? options.forkId ?? '22222222-2222-4222-8222-222222222222' : nativeId
        response.hooks_applied = true
        response.session_state = 'idle'
        if (options.acknowledge !== false && !useSnapshot) {
          if (options.useSystemInit)
            fixture.send({ type: 'system', subtype: 'init', session_id: acknowledgedId, model: options.model, capabilities: options.capabilities ?? [] })
          else
            response.session_id = acknowledgedId
        }
        response.capabilities = options.capabilities ?? []
        if (options.models)
          response.models = options.models
        if (options.account)
          response.account = options.account
        fixture.send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } })
        if (useSnapshot && options.acknowledge !== false && initializationCount > 1)
          fixture.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [], uuid: 'native-snapshot', session_id: acknowledgedId })
        return
      }
      fixture.send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } })
    }
  })
  vi.mocked(spawn).mockReturnValue(fixture.child)
  return fixture
}

async function open(nativeId: string | null = null, sink = createSink(), options?: NativeSessionOpenOptions) {
  const session = await createClaudeSession(command, 'C:/fixture/workspace', nativeId, sink, new AbortController().signal, options)
  sessions.push(session)
  return session
}

const modelInfo = (value: string, levels: string[] = ['low', 'high']) => ({ value, displayName: `Native ${value}`, description: `${value} description`, supportsEffort: true, supportedEffortLevels: levels })
const user = () => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'inspect the workspace' }] })
const result = (fixture: ProcessFixture, id: string, extra: Frame = {}) => fixture.send({ type: 'result', subtype: 'success', is_error: false, session_id: id, result: 'final text, not another assistant message', ...extra })
const stream = (fixture: ProcessFixture, event: Frame, extra: Frame = {}) => fixture.send({ type: 'stream_event', event, parent_tool_use_id: null, ...extra })

beforeEach(() => vi.mocked(spawn).mockReset())
afterEach(async () => {
  for (const session of sessions.splice(0))
    await session.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('claude native stream-json control contract', () => {
  it('requires a native id acknowledgement before returning a newly reserved session', async () => {
    const fixture = claudeProcess({ useSnapshot: false })
    const session = await open()
    expect(session.id).toMatch(/^[\da-f-]{36}$/)
    const args = vi.mocked(spawn).mock.calls[0]![1]
    expect(args).toEqual([
      '--print',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      `--session-id=${session.id}`,
    ])
    expect(spawn).toHaveBeenCalledWith('C:/fixture/claude.exe', args, {
      cwd: 'C:/fixture/workspace',
      env: { PATH: 'C:/fixture/bin', CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    expect(fixture.frames).toEqual([{ type: 'control_request', request_id: expect.any(String), request: initialization }])
  })

  it.each(['create', 'resume', 'fork'] as const)('opens %s from the native repeated-initialize snapshot without a bootstrap prompt', async (mode) => {
    vi.useFakeTimers()
    const fixture = claudeProcess({ useSnapshot: true, models: [modelInfo('native-model')] })
    const sink = createSink()
    const opening = open(mode === 'resume' ? storedId : null, sink, mode === 'fork' ? { forkFrom: storedId } : undefined)
    await Promise.all([
      vi.advanceTimersByTimeAsync(60_000),
      expect(opening).resolves.toMatchObject({ id: mode === 'resume' ? storedId : expect.any(String) }),
    ])
    const controls = [
      { type: 'control_request', request_id: expect.any(String), request: initialization },
      { type: 'control_request', request_id: expect.any(String), request: initialization },
    ]
    expect(fixture.frames).toEqual(controls)
    const session = await opening
    if (mode === 'fork')
      expect(session.id).toBe('22222222-2222-4222-8222-222222222222')
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[]
    expect(args).toContain(mode === 'create' ? `--session-id=${session.id}` : `--resume=${storedId}`)
    expect(args.includes('--fork-session')).toBe(mode === 'fork')
    expect(await session.models!(new AbortController().signal)).toEqual({ models: [
      { id: 'native-model', name: 'Native native-model', description: 'native-model description', reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }] } },
    ] })
    expect(sink.text).not.toHaveBeenCalled()
    expect(sink.assistant).not.toHaveBeenCalled()
    const submitted = session.submit([user()], new AbortController().signal)
    result(fixture, session.id)
    await submitted
    expect(fixture.frames).toEqual([
      ...controls,
      { type: 'user', session_id: session.id, uuid: expect.any(String), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: 'inspect the workspace' }] } },
    ])
    expect(fixture.kill).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('refuses initialize without an id acknowledgement instead of binding a reserved UUID', async () => {
    vi.useFakeTimers()
    const fixture = claudeProcess({ acknowledge: false })
    const rejected = expect(open()).rejects.toMatchObject({ code: 'BRIDGE_NATIVE_BIND_UNCONFIRMED' })
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected
    expect(fixture.frames).toEqual([
      { type: 'control_request', request_id: expect.any(String), request: initialization },
      { type: 'control_request', request_id: expect.any(String), request: initialization },
    ])
    expect(fixture.stdin.end).toHaveBeenCalledTimes(1)
    expect(fixture.kill).not.toHaveBeenCalled()
  })

  it('waits for the repeated-initialize snapshot after its control acknowledgement', async () => {
    const fixture = claudeProcess({ acknowledge: false })
    const repeated = fixture.next(frame => frame.type === 'control_request' && fixture.frames.length === 2)
    const opening = open(storedId)
    const settled = vi.fn()
    void opening.then(settled, settled)
    await repeated
    expect(settled).not.toHaveBeenCalled()
    expect(fixture.frames).toEqual([
      { type: 'control_request', request_id: expect.any(String), request: initialization },
      { type: 'control_request', request_id: expect.any(String), request: initialization },
    ])
    fixture.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [], uuid: 'late-snapshot', session_id: storedId })
    const session = await opening
    expect(session.id).toBe(storedId)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it.each(['resume', 'fork', 'missing-id'] as const)('refuses the %s identity from the repeated-initialize snapshot', async (mode) => {
    const fixture = claudeProcess({ acknowledge: false })
    const repeated = fixture.next(frame => frame.type === 'control_request' && fixture.frames.length === 2)
    const opening = open(mode === 'fork' ? null : storedId, createSink(), mode === 'fork' ? { forkFrom: storedId } : undefined)
    const rejected = expect(opening).rejects.toMatchObject({ code: mode === 'resume' ? 'BRIDGE_RESUME_MISMATCH' : mode === 'fork' ? 'BRIDGE_FORK_MISMATCH' : 'BRIDGE_PROTOCOL' })
    await repeated
    fixture.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [], uuid: 'invalid-snapshot', ...mode === 'missing-id' ? {} : { session_id: mode === 'fork' ? storedId : 'wrong-native' } })
    await rejected
    expect(fixture.frames).toEqual([
      { type: 'control_request', request_id: expect.any(String), request: initialization },
      { type: 'control_request', request_id: expect.any(String), request: initialization },
    ])
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('refuses a fatal startup result following a matching snapshot in the same native output chunk', async () => {
    const fixture = claudeProcess({ intercept: (frame, child) => {
      if (frame.type !== 'control_request' || child.frames.length !== 2)
        return false
      child.writeChunk([
        { type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { hooks_applied: true, session_state: 'idle' } } },
        { type: 'system', subtype: 'background_tasks_changed', tasks: [], uuid: 'failed-snapshot', session_id: storedId },
        { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: storedId, errors: ['Native startup refused'] },
      ].map(message => `${JSON.stringify(message)}\n`).join(''))
      return true
    } })
    await expect(open(storedId)).rejects.toMatchObject({ code: 'BRIDGE_NATIVE_TURN', message: '["Native startup refused"]' })
    expect(fixture.frames).toEqual([
      { type: 'control_request', request_id: expect.any(String), request: initialization },
      { type: 'control_request', request_id: expect.any(String), request: initialization },
    ])
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('propagates a repeated-initialize control error without a prompt or a fresh-session fallback', async () => {
    const fixture = claudeProcess({ intercept: (frame, child) => {
      if (frame.type !== 'control_request' || child.frames.length !== 2)
        return false
      child.send({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'Cannot refresh native state' } })
      return true
    } })
    await expect(open(storedId)).rejects.toMatchObject({ code: 'BRIDGE_NATIVE_REQUEST', message: 'Cannot refresh native state' })
    expect(fixture.frames).toEqual([
      { type: 'control_request', request_id: expect.any(String), request: initialization },
      { type: 'control_request', request_id: expect.any(String), request: initialization },
    ])
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(fixture.stdin.end).toHaveBeenCalledTimes(1)
  })

  it.each(['pending-control', 'pending-snapshot'] as const)('cancels the %s refresh before accepting a native binding', async (phase) => {
    const fixture = claudeProcess({ acknowledge: false, intercept: (frame, child) => phase === 'pending-control' && frame.type === 'control_request' && child.frames.length === 2 })
    const repeated = fixture.next(frame => frame.type === 'control_request' && fixture.frames.length === 2)
    const controller = new AbortController()
    const rejected = expect(createClaudeSession(command, 'C:/fixture/workspace', storedId, createSink(), controller.signal)).rejects.toThrow('cancel native refresh')
    await repeated
    controller.abort(new Error('cancel native refresh'))
    await rejected
    expect(fixture.frames).toEqual([
      { type: 'control_request', request_id: expect.any(String), request: initialization },
      { type: 'control_request', request_id: expect.any(String), request: initialization },
    ])
    expect(fixture.stdin.end).toHaveBeenCalledTimes(1)
    expect(fixture.kill).not.toHaveBeenCalled()
  })

  it('bounds the total startup deadline while the repeated initialize control is unanswered', async () => {
    vi.useFakeTimers()
    const fixture = claudeProcess({ intercept: frame => frame.type === 'control_request' })
    const opening = open(storedId)
    const rejected = expect(opening).rejects.toMatchObject({ code: 'BRIDGE_NATIVE_BIND_UNCONFIRMED' })
    const settled = vi.fn()
    void opening.then(settled, settled)
    await vi.advanceTimersByTimeAsync(30_000)
    const repeated = fixture.next(frame => frame.type === 'control_request' && fixture.frames.length === 2)
    fixture.send({ type: 'control_response', response: { subtype: 'success', request_id: fixture.frames[0]!.request_id, response: { hooks_applied: true, session_state: 'idle' } } })
    await repeated
    await vi.advanceTimersByTimeAsync(29_999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toHaveBeenCalledTimes(1)
    await rejected
    expect(fixture.frames).toEqual([
      { type: 'control_request', request_id: expect.any(String), request: initialization },
      { type: 'control_request', request_id: expect.any(String), request: initialization },
    ])
    expect(fixture.stdin.end).toHaveBeenCalledTimes(1)
    expect(fixture.kill).not.toHaveBeenCalled()
  })

  it('accepts a matching system/init before the initialize response as native acknowledgement', async () => {
    const fixture = claudeProcess({ useSystemInit: true })
    const session = await open(storedId)
    expect(session.id).toBe(storedId)
    expect(vi.mocked(spawn).mock.calls[0]![1]).toContain(`--resume=${storedId}`)
    expect(fixture.frames.some(frame => frame.type === 'user')).toBe(false)
  })

  it('waits for a real SessionStart hook after initialize and replies without injecting prompt context', async () => {
    const fixture = claudeProcess({ acknowledge: false })
    const opening = open(storedId)
    const settled = vi.fn()
    void opening.then(settled, settled)
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    const reply = fixture.next(frame => frame.type === 'control_response')
    fixture.send({ type: 'control_request', request_id: 'native-session-start', request: { subtype: 'hook_callback', callback_id: 'dsh-native-session-identity', input: { hook_event_name: 'SessionStart', source: 'resume', session_id: storedId, cwd: 'C:/fixture/workspace' } } })
    expect(await reply).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'native-session-start', response: {} } })
    const session = await opening
    expect(session.id).toBe(storedId)
    expect(fixture.frames.some(frame => frame.type === 'user')).toBe(false)
  })

  it('fails closed when SessionStart reports a different native identity', async () => {
    const fixture = claudeProcess({ acknowledge: false })
    const rejected = expect(open(storedId)).rejects.toMatchObject({ code: 'BRIDGE_RESUME_MISMATCH' })
    fixture.send({ type: 'control_request', request_id: 'wrong-session-start', request: { subtype: 'hook_callback', callback_id: 'dsh-native-session-identity', input: { hook_event_name: 'SessionStart', source: 'resume', session_id: 'replacement-native' } } })
    await rejected
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(fixture.frames.some(frame => frame.type === 'user')).toBe(false)
  })

  it('releases a cancelled preprompt native identity wait without accepting a reservation', async () => {
    const fixture = claudeProcess({ acknowledge: false })
    const signal = new AbortController()
    const rejected = expect(createClaudeSession(command, 'C:/fixture/workspace', null, createSink(), signal.signal)).rejects.toThrow('cancel native creation')
    signal.abort(new Error('cancel native creation'))
    await rejected
    expect(fixture.frames.some(frame => frame.type === 'user')).toBe(false)
    expect(fixture.stdin.end).toHaveBeenCalledTimes(1)
  })

  it('rejects a resume identity mismatch without retrying with a new native session', async () => {
    const fixture = claudeProcess({ mismatch: true })
    await expect(open(storedId)).rejects.toMatchObject({ code: 'BRIDGE_RESUME_MISMATCH' })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(spawn).mock.calls[0]![1]).toContain(`--resume=${storedId}`)
    expect(fixture.frames.some(frame => frame.type === 'user')).toBe(false)
  })

  it.each([
    { mode: 'resume', fatalId: storedId },
    { mode: 'resume', fatalId: 'error-only-native' },
    { mode: 'fork', fatalId: storedId },
    { mode: 'fork', fatalId: 'error-only-child' },
  ] as const)('rejects $mode startup failure before confirming its error-only identity $fatalId', async ({ mode, fatalId }) => {
    const fixture = claudeProcess({ intercept: (frame, child) => {
      if (frame.type !== 'control_request')
        return false
      child.send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: fatalId, errors: ['No conversation found'] })
      return true
    } })
    await expect(open(mode === 'resume' ? storedId : null, createSink(), mode === 'fork' ? { forkFrom: storedId } : undefined)).rejects.toMatchObject({ code: 'BRIDGE_NATIVE_TURN', message: '["No conversation found"]' })
    expect(fixture.frames).toEqual([{ type: 'control_request', request_id: expect.any(String), request: initialization }])
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('forks by official resume and fork-session flags and binds only a new acknowledgement', async () => {
    const fixture = claudeProcess({ forkId: 'child-session' })
    const session = await open(null, createSink(), { forkFrom: storedId })
    expect(session.id).toBe('child-session')
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[]
    expect(args).toContain(`--resume=${storedId}`)
    expect(args).toContain('--fork-session')
    expect(args.some(arg => arg.startsWith('--session-id='))).toBe(false)
    expect(fixture.frames.some(frame => frame.type === 'user')).toBe(false)
  })

  it('accepts a real fork SessionStart hook but rejects later identity replacement', async () => {
    const fixture = claudeProcess({ acknowledge: false })
    const opening = open(null, createSink(), { forkFrom: storedId })
    fixture.send({ type: 'control_request', request_id: 'fork-hook', request: { subtype: 'hook_callback', callback_id: 'dsh-native-session-identity', input: { hook_event_name: 'SessionStart', source: 'fork', session_id: 'forked-native', model: 'baseline' } } })
    const session = await opening
    expect(session.id).toBe('forked-native')
    const submitted = session.submit([user()], new AbortController().signal)
    const rejected = expect(submitted).rejects.toMatchObject({ code: 'BRIDGE_RESUME_MISMATCH' })
    result(fixture, storedId)
    await rejected
    expect(session.id).toBe('forked-native')
  })

  it('refuses a fork that acknowledges only the source id with no fresh-session fallback', async () => {
    const fixture = claudeProcess({ forkId: storedId })
    await expect(open(null, createSink(), { forkFrom: storedId })).rejects.toMatchObject({ code: 'BRIDGE_FORK_MISMATCH' })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(fixture.frames.some(frame => frame.type === 'user')).toBe(false)
  })

  it('rejects combined resume and fork options without spawning', async () => {
    await expect(open(storedId, createSink(), { forkFrom: 'source' })).rejects.toMatchObject({ code: 'BRIDGE_FORK_INVALID' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('uses initialize supported models and only advertised effort levels without leaking account data', async () => {
    const fixture = claudeProcess({
      useSystemInit: true,
      model: 'baseline',
      models: [modelInfo('baseline', ['medium', 'xhigh']), { value: 'custom', displayName: 'Custom provider', description: 'custom description', supportsEffort: true }],
      account: { email: 'private-fixture', apiKey: 'secret-fixture' },
    })
    const session = await open()
    const catalog = await session.models!(new AbortController().signal)
    expect(catalog).toEqual({ defaultModel: 'baseline', models: [
      { id: 'baseline', name: 'Native baseline', description: 'baseline description', reasoning: { efforts: [{ id: 'medium', name: 'medium' }, { id: 'xhigh', name: 'xhigh' }] } },
      { id: 'custom', name: 'Custom provider', description: 'custom description' },
    ] })
    expect(JSON.stringify(catalog)).not.toMatch(/private-fixture|secret-fixture/)
    expect(fixture.frames).toHaveLength(1)
    expect(fixture.frames.some(frame => frame.type === 'user')).toBe(false)
  })

  it('keeps each Claude alias once instead of exposing its resolved model id as a duplicate row', async () => {
    const fixture = claudeProcess({
      models: [
        { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5)', supportsEffort: true, supportedEffortLevels: ['high'] },
        { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['high'] },
        { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', supportsEffort: true, supportedEffortLevels: ['high'] },
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', supportsEffort: true, supportedEffortLevels: ['high'] },
        { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', supportsEffort: true, supportedEffortLevels: ['high'] },
      ],
    })
    const session = await open(storedId)
    const catalog = await session.models!(new AbortController().signal)
    expect(catalog.models.map(model => ({ id: model.id, name: model.name }))).toEqual([
      { id: 'default', name: 'Default (recommended)' },
      { id: 'opus', name: 'Opus' },
      { id: 'fable', name: 'Fable' },
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'haiku', name: 'Haiku' },
    ])
    expect(catalog.defaultModel).toBeUndefined()
    expect(catalog.models.some(model => model.id.startsWith('claude-'))).toBe(false)
    expect(fixture.frames.some(frame => frame.type === 'user')).toBe(false)
  })

  it('reports absent discovery as unsupported and never guesses effort levels', async () => {
    const fixture = claudeProcess()
    const session = await open()
    await expect(session.models!(new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_MODEL_DISCOVERY_UNAVAILABLE' })
    expect(fixture.frames).toHaveLength(2)
  })

  it('awaits set_model and apply_flag_settings acknowledgements before the one snapshotted user frame', async () => {
    const fixture = claudeProcess({
      models: [modelInfo('chosen')],
      intercept: frame => frame.type === 'control_request' && ['set_model', 'apply_flag_settings'].includes(String((frame.request as Frame).subtype)),
    })
    const session = await open()
    const selection = { model: 'chosen', reasoningEffort: 'high' }
    const setModel = fixture.next(frame => frame.type === 'control_request' && (frame.request as Frame).subtype === 'set_model')
    const submitted = session.submit([user()], new AbortController().signal, selection)
    selection.model = 'unadvertised'
    selection.reasoningEffort = 'unadvertised'
    const modelRequest = await setModel
    expect(modelRequest.request).toEqual({ subtype: 'set_model', model: 'chosen' })
    expect(fixture.frames.some(frame => frame.type === 'user')).toBe(false)
    const setEffort = fixture.next(frame => frame.type === 'control_request' && (frame.request as Frame).subtype === 'apply_flag_settings')
    fixture.send({ type: 'control_response', response: { subtype: 'success', request_id: modelRequest.request_id, response: {} } })
    const effortRequest = await setEffort
    expect(effortRequest.request).toEqual({ subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } })
    expect(fixture.frames.some(frame => frame.type === 'user')).toBe(false)
    const input = fixture.next(frame => frame.type === 'user')
    fixture.send({ type: 'control_response', response: { subtype: 'success', request_id: effortRequest.request_id, response: {} } })
    expect(await input).toMatchObject({ type: 'user', session_id: session.id })
    result(fixture, session.id)
    await submitted
    expect(fixture.frames.filter(frame => frame.type === 'user')).toHaveLength(1)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('retains native defaults on the first null selection and explicitly restores public defaults after overrides', async () => {
    const fixture = claudeProcess({ models: [modelInfo('chosen')] })
    const session = await open()
    const signal = new AbortController().signal
    const first = session.submit([user()], signal, { model: null, reasoningEffort: null })
    result(fixture, session.id)
    await first
    expect(fixture.frames.filter(frame => frame.type === 'control_request').map(frame => frame.request)).toEqual([initialization, initialization])
    const changedInput = fixture.next(frame => frame.type === 'user')
    const changed = session.submit([user()], signal, { model: 'chosen', reasoningEffort: 'high' })
    await changedInput
    result(fixture, session.id)
    await changed
    const resetInput = fixture.next(frame => frame.type === 'user')
    const reset = session.submit([user()], signal, { model: null, reasoningEffort: null })
    await resetInput
    result(fixture, session.id)
    await reset
    expect(fixture.frames.filter(frame => frame.type === 'control_request').map(frame => frame.request)).toEqual([
      initialization,
      initialization,
      { subtype: 'set_model', model: 'chosen' },
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } },
      { subtype: 'set_model', model: null },
      { subtype: 'apply_flag_settings', settings: { effortLevel: null } },
    ])
  })

  it.each(['resume', 'fork'] as const)('clears inherited model and effort flags before the first null selection after %s', async (mode) => {
    const fixture = claudeProcess({ useSystemInit: true, model: 'persisted-override' })
    const session = await open(mode === 'resume' ? storedId : null, createSink(), mode === 'fork' ? { forkFrom: storedId } : undefined)
    const input = fixture.next(frame => frame.type === 'user')
    const submitted = session.submit([user()], new AbortController().signal, { model: null, reasoningEffort: null })
    await input
    result(fixture, session.id)
    await submitted
    expect(fixture.frames.filter(frame => frame.type === 'control_request').map(frame => frame.request)).toEqual([
      initialization,
      { subtype: 'set_model', model: null },
      { subtype: 'apply_flag_settings', settings: { effortLevel: null } },
    ])
    expect(fixture.frames.filter(frame => frame.type === 'user')).toHaveLength(1)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('restores model-default effort when a fresh selection changes only the model', async () => {
    const fixture = claudeProcess({ models: [modelInfo('chosen')] })
    const session = await open()
    const input = fixture.next(frame => frame.type === 'user')
    const submitted = session.submit([user()], new AbortController().signal, { model: 'chosen', reasoningEffort: null })
    await input
    result(fixture, session.id)
    await submitted
    expect(fixture.frames.filter(frame => frame.type === 'control_request').map(frame => frame.request)).toEqual([
      initialization,
      initialization,
      { subtype: 'set_model', model: 'chosen' },
      { subtype: 'apply_flag_settings', settings: { effortLevel: null } },
    ])
  })

  it('refuses default-model effort validation against a resumed persisted model', async () => {
    const fixture = claudeProcess({
      useSystemInit: true,
      model: 'persisted-override',
      models: [modelInfo('persisted-override')],
      intercept: (frame, child) => {
        if (frame.type !== 'user')
          return false
        result(child, storedId)
        return true
      },
    })
    const session = await open(storedId)
    expect((await session.models!(new AbortController().signal)).defaultModel).toBeUndefined()
    await expect(session.submit([user()], new AbortController().signal, { model: null, reasoningEffort: 'high' })).rejects.toMatchObject({ code: 'BRIDGE_DEFAULT_UNAVAILABLE' })
    expect(fixture.frames).toHaveLength(1)
    expect(session.id).toBe(storedId)
  })

  it('validates default-model effort only from fresh SessionStart model metadata', async () => {
    const fixture = claudeProcess({ acknowledge: false, models: [modelInfo('baseline', ['high'])] })
    const opening = open()
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[]
    const nativeId = args.find(arg => arg.startsWith('--session-id='))!.split('=')[1]!
    fixture.send({ type: 'control_request', request_id: 'baseline-hook', request: { subtype: 'hook_callback', callback_id: 'dsh-native-session-identity', input: { hook_event_name: 'SessionStart', source: 'startup', session_id: nativeId, model: 'baseline' } } })
    const session = await opening
    const input = fixture.next(frame => frame.type === 'user')
    const submitted = session.submit([user()], new AbortController().signal, { model: null, reasoningEffort: 'high' })
    await input
    result(fixture, session.id)
    await submitted
    expect(fixture.frames.filter(frame => frame.type === 'control_request').map(frame => frame.request)).toEqual([initialization, { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } }])
  })

  it.each(['with-reset', 'after-reset'] as const)('refuses unprovable CLI-default effort %s when startup settings selected another model', async (phase) => {
    const cliDefault = 'different-cli-default'
    let nativeModel = 'configured-startup'
    const usedModels: string[] = []
    const fixture = claudeProcess({
      useSystemInit: true,
      model: 'configured-startup',
      models: [modelInfo('configured-startup', ['high']), modelInfo('chosen', ['high']), modelInfo(cliDefault, ['low'])],
      intercept: (frame, child) => {
        if (frame.type === 'control_request') {
          const request = frame.request as Frame
          if (request.subtype === 'set_model')
            nativeModel = typeof request.model === 'string' ? request.model : cliDefault
        }
        if (frame.type !== 'user')
          return false
        usedModels.push(nativeModel)
        result(child, String(frame.session_id))
        return true
      },
    })
    const session = await open()
    const signal = new AbortController().signal
    await session.submit([user()], signal, { model: 'chosen', reasoningEffort: 'high' })
    if (phase === 'after-reset') {
      await session.submit([user()], signal, { model: null, reasoningEffort: null })
      expect(nativeModel).toBe(cliDefault)
    }
    const before = fixture.frames.length
    await expect(session.submit([user()], signal, { model: null, reasoningEffort: 'high' })).rejects.toMatchObject({ code: 'BRIDGE_DEFAULT_UNAVAILABLE' })
    expect(fixture.frames).toHaveLength(before)
    if (phase === 'after-reset')
      expect((await session.models!(signal)).defaultModel).toBeUndefined()
    expect(usedModels).toEqual(phase === 'after-reset' ? ['chosen', cliDefault] : ['chosen'])
    await session.submit([user()], signal, { model: cliDefault, reasoningEffort: 'low' })
    expect(nativeModel).toBe(cliDefault)
    expect(fixture.frames.at(-1)).toMatchObject({ type: 'user', session_id: session.id })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('rejects unadvertised effort before either control or user input', async () => {
    const fixture = claudeProcess({ models: [{ value: 'custom', displayName: 'Custom', supportsEffort: true }] })
    const session = await open()
    await expect(session.submit([user()], new AbortController().signal, { model: 'custom', reasoningEffort: 'high' })).rejects.toMatchObject({ code: 'BRIDGE_EFFORT_UNSUPPORTED' })
    expect(fixture.frames).toHaveLength(2)
    expect(session.id).toMatch(/^[\da-f-]{36}$/)
  })

  it('fails closed on a rejected selection control and never sends a prompt', async () => {
    const fixture = claudeProcess({ models: [modelInfo('chosen')], intercept: (frame, child) => {
      if (frame.type !== 'control_request' || (frame.request as Frame).subtype !== 'set_model')
        return false
      child.send({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'Unsupported set_model capability' } })
      return true
    } })
    const session = await open()
    await expect(session.submit([user()], new AbortController().signal, { model: 'chosen', reasoningEffort: null })).rejects.toMatchObject({ code: 'BRIDGE_NATIVE_REQUEST', message: 'Unsupported set_model capability' })
    expect(fixture.frames.some(frame => frame.type === 'user')).toBe(false)
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('guards concurrent submissions and aborts an unacknowledged model control without submitting input', async () => {
    const fixture = claudeProcess({ models: [modelInfo('chosen')], intercept: frame => frame.type === 'control_request' && (frame.request as Frame).subtype === 'set_model' })
    const session = await open()
    const signal = new AbortController()
    const pending = fixture.next(frame => frame.type === 'control_request' && (frame.request as Frame).subtype === 'set_model')
    const submitted = session.submit([user()], signal.signal, { model: 'chosen', reasoningEffort: null })
    const rejected = expect(submitted).rejects.toThrow('cancel selection')
    await pending
    await expect(session.submit([user()], new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_BUSY' })
    signal.abort(new Error('cancel selection'))
    await rejected
    expect(fixture.frames.some(frame => frame.type === 'user' || (frame.type === 'control_request' && (frame.request as Frame).subtype === 'interrupt'))).toBe(false)
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('keeps live and authoritative block identities while suppressing a duplicate final frame', async () => {
    const fixture = claudeProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const submitted = session.submit([user()], new AbortController().signal)
    expect(fixture.frames.at(-1)).toMatchObject({ type: 'user', session_id: session.id, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: 'inspect the workspace' }] } })
    stream(fixture, { type: 'message_start', message: { id: 'msg-1' } })
    stream(fixture, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
    stream(fixture, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'inspect first' } })
    const thinking = { type: 'assistant', uuid: 'final-thinking', session_id: session.id, message: { id: 'msg-1', content: [{ type: 'thinking', thinking: 'inspect first' }] } }
    fixture.send(thinking)
    fixture.send(thinking)
    stream(fixture, { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
    stream(fixture, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello' } })
    fixture.send({ type: 'assistant', uuid: 'final-text', session_id: session.id, message: { id: 'msg-1', content: [{ type: 'text', text: 'hello' }] } })
    stream(fixture, { type: 'message_stop' })
    result(fixture, session.id)
    await submitted
    expect(sink.thinking.mock.calls).toEqual([['msg-1:block:0', 'inspect first']])
    expect(sink.text.mock.calls).toEqual([['msg-1:block:1', 'hello']])
    expect(sink.assistant.mock.calls).toEqual([
      ['msg-1:block:0', [{ type: 'thinking', text: 'inspect first' }]],
      ['msg-1:block:1', [{ type: 'text', text: 'hello' }]],
    ])
  })

  it('keeps repeated native message ids aligned with their individual streamed block indices', async () => {
    const fixture = claudeProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const submitted = session.submit([user()], new AbortController().signal)
    stream(fixture, { type: 'message_start', message: { id: 'msg-2' } })
    for (const index of [0, 1]) {
      stream(fixture, { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      stream(fixture, { type: 'content_block_delta', index, delta: { type: 'text_delta', text: 'identical text' } })
      fixture.send({ type: 'assistant', uuid: `frame-${index}`, session_id: session.id, message: { id: 'msg-2', content: [{ type: 'text', text: 'identical text' }] } })
    }
    result(fixture, session.id)
    await submitted
    expect(sink.assistant.mock.calls).toEqual([
      ['msg-2:block:0', [{ type: 'text', text: 'identical text' }]],
      ['msg-2:block:1', [{ type: 'text', text: 'identical text' }]],
    ])
  })

  it('emits aggregate assistant tool blocks synchronously as separate presented calls', async () => {
    const fixture = claudeProcess()
    const sink = createSink()
    const order: string[] = []
    const consumed = Promise.withResolvers<string[]>()
    sink.assistant.mockImplementation((id) => {
      order.push(`assistant:${id}`)
      if (id === 'msg-aggregate:block:0')
        void Promise.resolve().then(() => consumed.resolve([...order]))
    })
    sink.toolStart.mockImplementation(id => order.push(`start:${id}`))
    const session = await open(null, sink)
    const submitted = session.submit([user()], new AbortController().signal)
    const settled = vi.fn()
    void submitted.then(settled, settled)
    try {
      fixture.send({ type: 'assistant', uuid: 'aggregate-tools', session_id: session.id, message: { id: 'msg-aggregate', content: [
        { type: 'tool_use', id: 'aggregate-1', name: 'Read', input: { file_path: 'first.ts' } },
        { type: 'tool_use', id: 'aggregate-2', name: 'Read', input: { file_path: 'second.ts' } },
      ] } })
      const expectedOrder = ['assistant:msg-aggregate:block:0', 'start:aggregate-1', 'assistant:msg-aggregate:block:1', 'start:aggregate-2']
      expect(order).toEqual(expectedOrder)
      expect(await consumed.promise).toEqual(expectedOrder)
      expect(sink.assistant.mock.calls).toEqual([
        ['msg-aggregate:block:0', [{ type: 'tool-call', id: 'aggregate-1', name: 'Read', arguments: '{"file_path":"first.ts"}' }]],
        ['msg-aggregate:block:1', [{ type: 'tool-call', id: 'aggregate-2', name: 'Read', arguments: '{"file_path":"second.ts"}' }]],
      ])
      fixture.send({ type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'aggregate-2', content: 'second output' },
        { type: 'tool_result', tool_use_id: 'aggregate-1', content: 'first output' },
      ] } })
    }
    finally {
      result(fixture, session.id)
      await submitted
    }
    expect(sink.toolEnd.mock.calls).toEqual([['aggregate-2', 'second output', false], ['aggregate-1', 'first output', false]])
    expect(settled).toHaveBeenCalledTimes(1)
    expect(fixture.frames.filter(frame => frame.type === 'user')).toHaveLength(1)
  })

  it('keeps one native submit active across same-message tools separated by early results', async () => {
    const fixture = claudeProcess()
    const sink = createSink()
    const order: string[] = []
    sink.assistant.mockImplementation(id => order.push(`assistant:${id}`))
    sink.toolStart.mockImplementation(id => order.push(`start:${id}`))
    sink.toolEnd.mockImplementation(id => order.push(`end:${id}`))
    const session = await open(null, sink)
    const submitted = session.submit([user()], new AbortController().signal)
    const settled = vi.fn()
    void submitted.then(settled, settled)
    try {
      stream(fixture, { type: 'message_start', message: { id: 'msg-parallel' } })
      stream(fixture, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'parallel-1', name: 'Read', input: {} } })
      stream(fixture, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } })
      expect(sink.assistant).not.toHaveBeenCalled()
      expect(sink.toolStart).not.toHaveBeenCalled()
      fixture.send({ type: 'assistant', uuid: 'parallel-first', session_id: session.id, message: { id: 'msg-parallel', content: [{ type: 'tool_use', id: 'parallel-1', name: 'Read', input: { file_path: 'first.ts' } }] } })
      fixture.send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'parallel-1', content: 'first output' }] } })
      await Promise.resolve()
      expect(order).toEqual(['assistant:msg-parallel:block:0', 'start:parallel-1', 'end:parallel-1'])
      expect(settled).not.toHaveBeenCalled()
      await expect(session.submit([user()], new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_BUSY' })
      stream(fixture, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'parallel-2', name: 'Read', input: {} } })
      fixture.send({ type: 'assistant', uuid: 'parallel-second', session_id: session.id, message: { id: 'msg-parallel', content: [{ type: 'tool_use', id: 'parallel-2', name: 'Read', input: { file_path: 'second.ts' } }] } })
      fixture.send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'parallel-2', content: 'second output' }] } })
      await Promise.resolve()
      expect(settled).not.toHaveBeenCalled()
      stream(fixture, { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } })
      fixture.send({ type: 'assistant', uuid: 'parallel-tail', session_id: session.id, message: { id: 'msg-parallel', content: [{ type: 'text', text: 'both inspected' }] } })
      stream(fixture, { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
      stream(fixture, { type: 'message_stop' })
      await Promise.resolve()
      expect(settled).not.toHaveBeenCalled()
      expect(order).toEqual([
        'assistant:msg-parallel:block:0',
        'start:parallel-1',
        'end:parallel-1',
        'assistant:msg-parallel:block:1',
        'start:parallel-2',
        'end:parallel-2',
        'assistant:msg-parallel:block:2',
      ])
      expect(sink.assistant.mock.calls).toEqual([
        ['msg-parallel:block:0', [{ type: 'tool-call', id: 'parallel-1', name: 'Read', arguments: '{"file_path":"first.ts"}' }]],
        ['msg-parallel:block:1', [{ type: 'tool-call', id: 'parallel-2', name: 'Read', arguments: '{"file_path":"second.ts"}' }]],
        ['msg-parallel:block:2', [{ type: 'text', text: 'both inspected' }]],
      ])
    }
    finally {
      result(fixture, session.id)
      await submitted
    }
    expect(settled).toHaveBeenCalledTimes(1)
    expect(fixture.frames.filter(frame => frame.type === 'user')).toHaveLength(1)
    expect(fixture.kill).not.toHaveBeenCalled()
  })

  it('records one native tool call and error result without echoing native user messages', async () => {
    const fixture = claudeProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const submitted = session.submit([user()], new AbortController().signal)
    const assistant = { type: 'assistant', uuid: 'tool-frame', session_id: session.id, message: { id: 'msg-tool', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'git status' } }] } }
    fixture.send(assistant)
    fixture.send(assistant)
    fixture.send({ type: 'user', message: { role: 'user', content: 'native input echo' } })
    const tool = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'not a git repository' }], is_error: true }] } }
    fixture.send(tool)
    fixture.send(tool)
    result(fixture, session.id)
    await submitted
    expect(sink.assistant.mock.calls).toEqual([['msg-tool:block:0', [{ type: 'tool-call', id: 'tool-1', name: 'Bash', arguments: '{"command":"git status"}' }]]])
    expect(sink.toolStart.mock.calls).toEqual([['tool-1', 'Bash', '{"command":"git status"}']])
    expect(sink.toolEnd.mock.calls).toEqual([['tool-1', 'not a git repository', true]])
  })

  it('returns nested permission allow-once with the original native input', async () => {
    const fixture = claudeProcess()
    const sink = createSink()
    sink.approval.mockResolvedValue(true)
    const session = await open(null, sink)
    const submitted = session.submit([user()], new AbortController().signal)
    const answered = fixture.next(frame => frame.type === 'control_response' && (frame.response as Frame).request_id === 'permission-1')
    fixture.send({ type: 'control_request', request_id: 'permission-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tool-approval', input: { command: 'git status' }, title: 'Read repository state' } })
    expect(await answered).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'permission-1', response: { behavior: 'allow', updatedInput: { command: 'git status' } } } })
    expect(sink.approval.mock.calls[0]?.slice(0, 2)).toEqual(['tool-approval', { kind: 'command', title: 'Read repository state', details: '{"tool":"Bash","input":{"command":"git status"}}' }])
    result(fixture, session.id)
    await submitted
  })

  it('maps AskUserQuestion multi-selection back into native updatedInput answers', async () => {
    const fixture = claudeProcess()
    const sink = createSink()
    sink.questions.mockResolvedValue({ 'Which areas?': ['Events', 'Cancel'] })
    const session = await open(null, sink)
    const submitted = session.submit([user()], new AbortController().signal)
    const answered = fixture.next(frame => frame.type === 'control_response')
    const input = { questions: [{ question: 'Which areas?', header: 'Scope', multiSelect: true, options: [{ label: 'Events', description: 'Logs and UI' }, { label: 'Cancel', description: 'Quiescence' }] }] }
    fixture.send({ type: 'control_request', request_id: 'questions-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'question-tool', input } })
    expect(await answered).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'questions-1', response: { behavior: 'allow', updatedInput: { ...input, answers: { 'Which areas?': 'Events, Cancel' } } } } })
    expect(sink.questions.mock.calls[0]?.slice(0, 2)).toEqual(['question-tool', [{ id: 'Which areas?', question: 'Which areas?', multiSelect: true, options: [{ label: 'Events', description: 'Logs and UI' }, { label: 'Cancel', description: 'Quiescence' }] }]])
    result(fixture, session.id)
    await submitted
  })

  it('withdraws native control requests so a late UI answer cannot grant permission', async () => {
    const fixture = claudeProcess()
    const sink = createSink()
    const parked = Promise.withResolvers<boolean>()
    sink.approval.mockReturnValue(parked.promise)
    const session = await open(null, sink)
    const submitted = session.submit([user()], new AbortController().signal)
    fixture.send({ type: 'control_request', request_id: 'withdrawn-1', request: { subtype: 'can_use_tool', tool_name: 'Write', tool_use_id: 'edit-1', input: { file_path: 'fixture.txt', content: 'safe' } } })
    const signal = sink.approval.mock.calls[0]![2]!
    fixture.send({ type: 'control_cancel_request', request_id: 'withdrawn-1' })
    parked.resolve(true)
    await parked.promise
    result(fixture, session.id)
    await submitted
    expect(signal.aborted).toBe(true)
    expect(fixture.frames.some(frame => frame.type === 'control_response')).toBe(false)
  })

  it('does not settle cancellation on interrupt ACK while tracked background tasks remain', async () => {
    const fixture = claudeProcess({ capabilities: ['interrupt_cancel_queued_v1', 'interrupt_receipt_v1'] })
    const session = await open()
    const signal = new AbortController()
    const submitted = session.submit([user()], signal.signal)
    const rejected = expect(submitted).rejects.toThrow('cancel run')
    let settled = false
    void submitted.then(() => settled = true, () => settled = true)
    fixture.send({ type: 'system', subtype: 'session_state_changed', state: 'running', session_id: session.id })
    fixture.send({ type: 'system', subtype: 'task_started', task_id: 'task-1', session_id: session.id })
    signal.abort(new Error('cancel run'))
    result(fixture, session.id, { terminal_reason: 'aborted_tools' })
    fixture.send({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: session.id })
    await Promise.resolve()
    expect(settled).toBe(false)
    const requests = fixture.frames.filter(frame => frame.type === 'control_request').map(frame => frame.request)
    expect(requests).toEqual([initialization, initialization, { subtype: 'interrupt', cancel_queued: true }, { subtype: 'stop_task', task_id: 'task-1' }])
    fixture.send({ type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'stopped', session_id: session.id })
    await rejected
  })

  it('does not withhold a normal result forever for a background shell', async () => {
    const fixture = claudeProcess()
    const session = await open()
    const submitted = session.submit([user()], new AbortController().signal)
    const settled = vi.fn()
    void submitted.then(settled, settled)
    fixture.send({ type: 'system', subtype: 'task_started', task_id: 'shell-1', task_type: 'local_bash', session_id: session.id })
    result(fixture, session.id)
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toHaveBeenCalledTimes(1)
    await submitted
  })

  it('requires a continuation result when authoritative-only main work resumes after a result', async () => {
    const fixture = claudeProcess()
    const session = await open()
    const submitted = session.submit([user()], new AbortController().signal)
    const settled = vi.fn()
    void submitted.then(settled, settled)
    fixture.send({ type: 'system', subtype: 'session_state_changed', state: 'running', session_id: session.id })
    fixture.send({ type: 'system', subtype: 'task_started', task_id: 'agent-1', task_type: 'local_agent', session_id: session.id })
    result(fixture, session.id)
    fixture.send({ type: 'assistant', uuid: 'continued-frame', session_id: session.id, message: { id: 'continued-message', content: [{ type: 'text', text: 'follow-up completed' }] } })
    fixture.send({ type: 'system', subtype: 'task_notification', task_id: 'agent-1', status: 'completed', session_id: session.id })
    fixture.send({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: session.id })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    result(fixture, session.id)
    await submitted
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('refuses to reuse a native process retaining the cancelled queued input', async () => {
    const fixture = claudeProcess({ capabilities: ['interrupt_receipt_v1'], intercept: (frame, child) => {
      if (frame.type !== 'control_request' || (frame.request as Frame).subtype !== 'interrupt')
        return false
      const input = child.frames.find(frame => frame.type === 'user')!
      child.send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { still_queued: [input.uuid] } } })
      return true
    } })
    const session = await open()
    const signal = new AbortController()
    const submitted = session.submit([user()], signal.signal)
    const rejected = expect(submitted).rejects.toMatchObject({ code: 'BRIDGE_INTERRUPT_QUEUED_INPUT' })
    signal.abort(new Error('cancel queued'))
    await rejected
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('force-closes a native process that acknowledges interrupt but never settles its run', async () => {
    vi.useFakeTimers()
    const fixture = claudeProcess()
    const session = await open()
    const signal = new AbortController()
    const submitted = session.submit([user()], signal.signal)
    const rejected = expect(submitted).rejects.toMatchObject({ code: 'BRIDGE_INTERRUPT_TIMEOUT' })
    signal.abort(new Error('cancel stuck'))
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('treats native conversation_reset as failure rather than changing the official binding', async () => {
    const fixture = claudeProcess()
    const session = await open(storedId)
    const submitted = session.submit([user()], new AbortController().signal)
    const rejected = expect(submitted).rejects.toMatchObject({ code: 'BRIDGE_NATIVE_RESET' })
    fixture.send({ type: 'conversation_reset', new_conversation_id: 'new-native-id' })
    await rejected
    expect(session.id).toBe(storedId)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('rejects nontext input instead of sending only its text portion', async () => {
    const fixture = claudeProcess()
    const session = await open()
    const input = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }, { type: 'reasoning', text: 'unsupported' }] })
    await expect(session.submit([input], new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_UNSUPPORTED_CONTENT' })
    expect(fixture.frames.some(frame => frame.type === 'user')).toBe(false)
  })

  it('ends stdin on idle disposal so native transcript flushing can precede termination', async () => {
    const fixture = claudeProcess()
    const session = await open()
    await Promise.all([session.dispose(), session.dispose()])
    expect(fixture.stdin.end).toHaveBeenCalledTimes(1)
    expect(fixture.kill).not.toHaveBeenCalled()
  })
})
