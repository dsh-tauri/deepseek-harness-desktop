import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Deferred } from './transport'
import type { NativeCommand, NativeContent, NativeQuestion, NativeSession, NativeSink } from './types'
import { abortError, deferred, errorFrom, INTERRUPT_TIMEOUT_MS, JsonLinesProcess, NativeBridgeError, PendingRequests, record, stringField, textMessages } from './transport'

interface ToolState {
  output: string
  ended: boolean
}

interface BackgroundTerminal {
  itemId: string
  processId: string
}

interface CodexTurn {
  result: Deferred<void>
  signal: AbortSignal
  id?: string
  submitted: boolean
  interruptSent: boolean
  baseline: Set<string>
  commandItems: Set<string>
  terminalError?: Error
  cleanup?: Promise<void>
  tools: Map<string, ToolState>
  assistants: Set<string>
  text: Map<string, string>
  thinking: Map<string, string>
  liveThinking: Map<string, string>
  interruptTimer?: ReturnType<typeof setTimeout>
}

function nativeTool(item: Record<string, unknown>): { name: string, arguments: string } | undefined {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'commandExecution', arguments: JSON.stringify({ command: item.command, cwd: item.cwd }) }
    case 'fileChange':
      return { name: 'fileChange', arguments: JSON.stringify({ changes: item.changes }) }
    case 'mcpToolCall':
      return { name: `mcp::${stringField(item, 'server')}/${stringField(item, 'tool')}`, arguments: JSON.stringify(item.arguments ?? {}) }
    case 'dynamicToolCall':
      return { name: stringField(item, 'tool'), arguments: JSON.stringify(item.arguments ?? {}) }
    case 'collabAgentToolCall':
      return { name: `collabAgent::${stringField(item, 'tool')}`, arguments: JSON.stringify({ prompt: item.prompt, receiverThreadIds: item.receiverThreadIds, model: item.model }) }
    case 'webSearch':
    case 'imageView':
    case 'imageGeneration':
    case 'sleep': {
      const { id: _id, type, ...arguments_ } = item
      return { name: String(type), arguments: JSON.stringify(arguments_) }
    }
    default:
      return undefined
  }
}

class CodexSession implements NativeSession {
  private readonly transport: JsonLinesProcess
  private readonly requests: PendingRequests
  private readonly approvals = new Map<string | number, AbortController>()
  private requestId = 0
  private nativeId = ''
  private active?: CodexTurn
  private failure?: Error
  private disposed = false
  private disposePromise?: Promise<void>
  private cleanup?: Promise<void>
  private readonly interruptedTurns = new Set<string>()
  private backgroundBaseline?: Set<string>
  private readonly commandItems = new Set<string>()

  constructor(command: NativeCommand, private readonly sink: NativeSink, cwd: string) {
    this.transport = new JsonLinesProcess(command, ['app-server', '--listen', 'stdio://'], cwd)
    this.requests = new PendingRequests(value => this.transport.write(value))
    this.transport.onFailure((error) => {
      this.failure = error
      this.requests.failAll(error)
      this.active?.result.reject(error)
      for (const controller of this.approvals.values())
        controller.abort(error)
      this.approvals.clear()
    })
    this.transport.onMessage(message => this.receive(message))
  }

  get id(): string {
    return this.nativeId
  }

  async open(cwd: string, storedId: string | null, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    try {
      await this.request('initialize', {
        clientInfo: { name: 'dsh-tauri-bridge', title: 'DSH native session bridge', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      }, signal)
      this.transport.write({ method: 'initialized', params: {} })
      const response = record(await this.request(storedId === null ? 'thread/start' : 'thread/resume', {
        ...storedId === null ? {} : { threadId: storedId },
        cwd,
      }, signal))
      const id = stringField(record(response.thread), 'id')
      if (storedId !== null && id !== storedId)
        throw new NativeBridgeError('BRIDGE_RESUME_MISMATCH', 'Codex resumed a different native thread; refusing to replace the stored binding')
      this.nativeId = id
      this.backgroundBaseline = new Set((await this.listTerminals(signal)).map(terminal => terminal.processId))
      signal.throwIfAborted()
    }
    catch (error) {
      await this.dispose()
      throw error
    }
  }

  async submit(messages: readonly UserMessage[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.disposed || this.failure)
      throw this.failure ?? new NativeBridgeError('BRIDGE_PROCESS_CLOSED', 'Codex session was disposed')
    if (this.active)
      throw new NativeBridgeError('BRIDGE_BUSY', 'Codex native session already has an active turn')
    const input = textMessages(messages).map(text => ({ type: 'text', text, text_elements: [] }))
    if (input.length === 0)
      throw new NativeBridgeError('BRIDGE_EMPTY_INPUT', 'Codex native turn requires a user message')
    const turn: CodexTurn = {
      result: deferred<void>(),
      signal,
      submitted: false,
      interruptSent: false,
      baseline: new Set(),
      commandItems: new Set(),
      tools: new Map(),
      assistants: new Set(),
      text: new Map(),
      thinking: new Map(),
      liveThinking: new Map(),
    }
    this.active = turn
    const aborted = (): void => {
      if (turn.submitted)
        this.interrupt(turn)
    }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      turn.baseline = new Set((await this.listTerminals(signal)).map(terminal => terminal.processId))
      signal.throwIfAborted()
      turn.submitted = true
      // turn/started may precede the response; retain its id even during cancel.
      const response = record(await this.request('turn/start', { threadId: this.id, input }))
      const id = stringField(record(response.turn), 'id')
      if (turn.id && id !== turn.id)
        throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Codex turn/start response disagrees with turn/started')
      turn.id = id
      if (signal.aborted)
        this.interrupt(turn)
      await turn.result.promise
      if (turn.cleanup)
        await turn.cleanup
      if (signal.aborted) {
        await this.cleanupTerminals(turn)
        signal.throwIfAborted()
      }
      if (turn.terminalError) {
        await this.cleanupTerminals(turn)
        throw turn.terminalError
      }
    }
    catch (error) {
      if (!signal.aborted)
        this.transport.fail(errorFrom(error))
      throw this.failure ?? (signal.aborted ? abortError(signal) : error)
    }
    finally {
      signal.removeEventListener('abort', aborted)
      clearTimeout(turn.interruptTimer)
      for (const controller of this.approvals.values())
        controller.abort(new NativeBridgeError('BRIDGE_REQUEST_CLOSED', 'Native turn has ended'))
      this.approvals.clear()
      this.active = undefined
    }
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.close()
    return this.disposePromise
  }

  private async close(): Promise<void> {
    this.disposed = true
    const error = new NativeBridgeError('BRIDGE_PROCESS_CLOSED', 'Codex native session was disposed')
    this.active?.result.reject(error)
    for (const controller of this.approvals.values())
      controller.abort(error)
    this.approvals.clear()
    try {
      if (this.id !== '' && this.backgroundBaseline && !this.failure)
        await this.cleanupTerminals()
    }
    finally {
      this.requests.failAll(error)
      await this.transport.close()
    }
  }

  private request(method: string, params: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    const id = ++this.requestId
    return this.requests.request(id, { id, method, params }, signal, timeoutMs)
  }

  private interrupt(turn: CodexTurn): void {
    if (!turn.interruptTimer) {
      turn.interruptTimer = setTimeout(() => {
        this.transport.fail(new NativeBridgeError('BRIDGE_INTERRUPT_TIMEOUT', 'Codex did not settle the interrupted turn; its process was closed'))
      }, INTERRUPT_TIMEOUT_MS)
    }
    if (!turn.id || turn.interruptSent)
      return
    turn.interruptSent = true
    this.interruptedTurns.add(turn.id)
    turn.cleanup = (async () => {
      await this.cleanupTerminals(turn)
      await this.request('turn/interrupt', { threadId: this.id, turnId: turn.id }, undefined, INTERRUPT_TIMEOUT_MS)
      await this.cleanupTerminals(turn)
    })()
    void turn.cleanup.catch((error) => {
      if (this.active === turn)
        this.transport.fail(errorFrom(error))
    })
  }

  private async listTerminals(signal?: AbortSignal): Promise<BackgroundTerminal[]> {
    const terminals: BackgroundTerminal[] = []
    const cursors = new Set<string>()
    let cursor: string | null = null
    do {
      const response = record(await this.request('thread/backgroundTerminals/list', { threadId: this.id, cursor, limit: 100 }, signal, INTERRUPT_TIMEOUT_MS))
      if (!Array.isArray(response.data))
        throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Codex background terminal listing is missing data')
      for (const value of response.data) {
        const terminal = record(value)
        terminals.push({ itemId: stringField(terminal, 'itemId'), processId: stringField(terminal, 'processId') })
        if (terminals.length > 10_000)
          throw new NativeBridgeError('BRIDGE_PROTOCOL_LIMIT', 'Codex background terminal listing exceeded its limit')
      }
      if (response.nextCursor !== null && response.nextCursor !== undefined && typeof response.nextCursor !== 'string')
        throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Codex background terminal cursor is invalid')
      cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null
      if (cursor !== null) {
        if (cursors.has(cursor))
          throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Codex background terminal listing repeated a cursor')
        cursors.add(cursor)
      }
    } while (cursor !== null)
    return terminals
  }

  private cleanupTerminals(turn?: CodexTurn): Promise<void> {
    const cleanup = async (): Promise<void> => {
      const owns = (terminal: BackgroundTerminal): boolean => turn
        ? turn.commandItems.has(terminal.itemId) || !turn.baseline.has(terminal.processId)
        : this.commandItems.has(terminal.itemId) || !this.backgroundBaseline!.has(terminal.processId)
      for (const terminal of (await this.listTerminals()).filter(owns))
        await this.request('thread/backgroundTerminals/terminate', { threadId: this.id, processId: terminal.processId }, undefined, INTERRUPT_TIMEOUT_MS)
      if ((await this.listTerminals()).some(owns))
        throw new NativeBridgeError('BRIDGE_INTERRUPT_CLEANUP_FAILED', 'Codex retained interrupted background terminals')
    }
    const pending = (this.cleanup ?? Promise.resolve()).then(cleanup)
    this.cleanup = pending
    return pending
  }

  private receive(message: Record<string, unknown>): void {
    const id = message.id
    if ((typeof id === 'number' || typeof id === 'string') && ('result' in message || 'error' in message)) {
      const error = message.error ? record(message.error) : undefined
      this.requests.settle(id, message.result, error ? new NativeBridgeError('BRIDGE_NATIVE_REQUEST', typeof error.message === 'string' ? error.message : JSON.stringify(error)) : undefined)
      return
    }
    const method = stringField(message, 'method')
    const params = record(message.params ?? {})
    if (typeof id === 'number' || typeof id === 'string') {
      void this.answer(id, method, params).catch(error => this.transport.fail(errorFrom(error)))
      return
    }
    if (method === 'serverRequest/resolved') {
      if (params.threadId !== this.id)
        return
      const requestId = params.requestId
      if (typeof requestId === 'number' || typeof requestId === 'string') {
        this.approvals.get(requestId)?.abort(new NativeBridgeError('BRIDGE_REQUEST_CLOSED', 'Codex resolved the server request'))
        this.approvals.delete(requestId)
      }
      return
    }
    if (params.threadId === this.id && method === 'item/started' && typeof params.turnId === 'string' && this.interruptedTurns.has(params.turnId)) {
      const item = record(params.item)
      if (item.type === 'commandExecution' && typeof item.processId === 'string') {
        void (async () => {
          await this.request('thread/backgroundTerminals/terminate', { threadId: this.id, processId: item.processId }, undefined, INTERRUPT_TIMEOUT_MS)
          if ((await this.listTerminals()).some(terminal => terminal.processId === item.processId))
            throw new NativeBridgeError('BRIDGE_INTERRUPT_CLEANUP_FAILED', 'Codex retained a late interrupted command')
        })().catch(error => this.transport.fail(errorFrom(error)))
      }
    }
    const turn = this.active
    if (!turn || params.threadId !== this.id)
      return
    const nativeTurn = method === 'turn/started' || method === 'turn/completed' ? record(params.turn) : undefined
    const turnId = nativeTurn?.id ?? params.turnId
    if (typeof turnId === 'string') {
      if (turn.id && turnId !== turn.id)
        return
      turn.id ??= turnId
    }
    if (turn.signal.aborted)
      this.interrupt(turn)
    switch (method) {
      case 'turn/started':
        return
      case 'turn/completed': {
        const status = stringField(nativeTurn!, 'status')
        if (status === 'interrupted' && !turn.signal.aborted)
          turn.terminalError = new NativeBridgeError('BRIDGE_NATIVE_INTERRUPTED', 'Codex interrupted the native turn')
        else if (status !== 'completed' && status !== 'interrupted')
          turn.terminalError = new NativeBridgeError('BRIDGE_NATIVE_TURN', `Codex turn ended with ${status}: ${JSON.stringify(nativeTurn!.error ?? {})}`)
        turn.result.resolve()
        return
      }
      case 'error':
        if (params.willRetry !== true)
          turn.terminalError = new NativeBridgeError('BRIDGE_NATIVE_TURN', JSON.stringify(params.error ?? params))
        return
      case 'item/agentMessage/delta':
      case 'item/plan/delta': {
        const id = stringField(params, 'itemId')
        const delta = stringField(params, 'delta')
        turn.text.set(id, (turn.text.get(id) ?? '') + delta)
        this.sink.text(id, delta)
        return
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const id = stringField(params, 'itemId')
        const delta = stringField(params, 'delta')
        // Summary and raw reasoning are independent content tracks.
        const track = `${id}:${method === 'item/reasoning/textDelta' ? 'raw' : 'summary'}`
        turn.thinking.set(track, (turn.thinking.get(track) ?? '') + delta)
        if (!turn.liveThinking.has(id))
          turn.liveThinking.set(id, track)
        if (turn.liveThinking.get(id) === track)
          this.sink.thinking(id, delta)
        return
      }
      case 'item/commandExecution/outputDelta': {
        const tool = turn.tools.get(stringField(params, 'itemId'))
        if (tool)
          tool.output += typeof params.delta === 'string' ? params.delta : ''
        return
      }
      case 'item/started':
      case 'item/completed':
        this.item(turn, record(params.item), method === 'item/completed')
    }
  }

  private item(turn: CodexTurn, item: Record<string, unknown>, completed: boolean): void {
    const id = stringField(item, 'id')
    if (item.type === 'commandExecution') {
      turn.commandItems.add(id)
      this.commandItems.add(id)
    }
    const tool = nativeTool(item)
    if (tool) {
      if (!turn.tools.has(id)) {
        this.sink.assistant(`${id}:call`, [{ type: 'tool-call', id, name: tool.name, arguments: tool.arguments }])
        this.sink.toolStart(id, tool.name, tool.arguments)
        turn.tools.set(id, { output: '', ended: false })
      }
      const state = turn.tools.get(id)!
      if (completed && !state.ended) {
        state.ended = true
        const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : state.output || JSON.stringify(item.result ?? item.contentItems ?? item.changes ?? item.error ?? item)
        const error = item.status === 'failed' || item.status === 'declined' || item.error != null || item.success === false || (typeof item.exitCode === 'number' && item.exitCode !== 0)
        this.sink.toolEnd(id, output, error)
      }
      return
    }
    if (!completed || turn.assistants.has(id))
      return
    const content: NativeContent[] = []
    switch (item.type) {
      case 'agentMessage':
      case 'plan':
        content.push({ type: 'text', text: typeof item.text === 'string' ? item.text : turn.text.get(id) ?? '' })
        break
      case 'reasoning': {
        const summary = Array.isArray(item.summary) ? item.summary.filter((part): part is string => typeof part === 'string').join('\n') : ''
        const raw = Array.isArray(item.content) ? item.content.filter((part): part is string => typeof part === 'string').join('\n') : ''
        content.push({ type: 'thinking', text: summary || turn.thinking.get(`${id}:summary`) || raw || turn.thinking.get(`${id}:raw`) || '' })
        break
      }
      case 'userMessage': // The official inbox owns user/message exactly once.
      case 'hookPrompt': // Native prompt assembly remains native-owned.
      case 'contextCompaction':
      case 'subAgentActivity':
        return
      case 'enteredReviewMode':
      case 'exitedReviewMode':
        content.push({ type: 'text', text: typeof item.review === 'string' ? item.review : '' })
        break
      default:
        throw new NativeBridgeError('BRIDGE_UNSUPPORTED_EVENT', `Unsupported Codex item type: ${String(item.type)}`)
    }
    turn.assistants.add(id)
    this.sink.assistant(id, content)
  }

  private async answer(id: string | number, method: string, params: Record<string, unknown>): Promise<void> {
    const controller = new AbortController()
    this.approvals.set(id, controller)
    const turn = this.active
    const signal = turn ? AbortSignal.any([turn.signal, controller.signal]) : controller.signal
    const itemId = typeof params.itemId === 'string' ? params.itemId : String(id)
    let result: unknown
    try {
      const belongs = turn && params.threadId === this.id && (turn.id === undefined || params.turnId === turn.id) && !signal.aborted
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        const command = method === 'item/commandExecution/requestApproval'
        const allowed = belongs
          ? await this.sink.approval(itemId, {
              kind: command ? 'command' : 'file',
              title: command && typeof params.command === 'string' ? params.command : command ? 'Codex command execution' : 'Codex file changes',
              details: JSON.stringify(params),
            }, signal)
          : false
        result = { decision: allowed && !signal.aborted ? 'accept' : 'decline' }
      }
      else if (method === 'item/permissions/requestApproval') {
        const allowed = belongs ? await this.sink.approval(itemId, { kind: 'tool', title: 'Codex additional permissions', details: JSON.stringify(params) }, signal) : false
        result = { permissions: allowed && !signal.aborted ? record(params.permissions) : {}, scope: 'turn' }
      }
      else if (method === 'item/tool/requestUserInput') {
        if (!belongs)
          throw new NativeBridgeError('BRIDGE_REQUEST_CLOSED', 'No active turn for the native user-input request')
        if (!Array.isArray(params.questions))
          throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Codex user-input request is missing questions')
        const questions: NativeQuestion[] = params.questions.map((value) => {
          const question = record(value)
          if (question.isSecret === true)
            throw new NativeBridgeError('BRIDGE_UNSUPPORTED_QUESTION', 'Secret native questions cannot be recorded in the official session log')
          return {
            id: stringField(question, 'id'),
            question: stringField(question, 'question'),
            ...Array.isArray(question.options)
              ? { options: question.options.map((value) => {
                  const option = record(value)
                  return { label: stringField(option, 'label'), ...typeof option.description === 'string' ? { description: option.description } : {} }
                }) }
              : {},
          }
        })
        const answers = await this.sink.questions(itemId, questions, signal)
        result = { answers: Object.fromEntries(questions.map(question => [question.id, { answers: Array.isArray(answers[question.id]) ? answers[question.id] : [answers[question.id] ?? ''] }])) }
      }
      else {
        // In particular item/tool/call is not an invitation to run DSH tools.
        this.transport.write({ id, error: { code: -32601, message: `Unsupported native server request: ${method}` } })
        return
      }
      if (!controller.signal.aborted)
        this.transport.write({ id, result })
    }
    catch (error) {
      if (!controller.signal.aborted)
        this.transport.write({ id, error: { code: -32603, message: errorFrom(error).message } })
    }
    finally {
      this.approvals.delete(id)
    }
  }
}

export async function createCodexSession(command: NativeCommand, cwd: string, nativeSessionId: string | null, sink: NativeSink, signal: AbortSignal): Promise<NativeSession> {
  const session = new CodexSession(command, sink, cwd)
  await session.open(cwd, nativeSessionId, signal)
  return session
}
