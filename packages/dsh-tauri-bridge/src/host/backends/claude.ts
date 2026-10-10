import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Deferred } from './transport'
import type { NativeCommand, NativeContent, NativeModelCatalog, NativeModelInfo, NativeQuestion, NativeSession, NativeSessionOpenOptions, NativeSink, NativeTurnOptions } from './types'
import { randomUUID } from 'node:crypto'
import { nativeEnvironment } from '../utils/detection'
import { abortError, deferred, errorFrom, INTERRUPT_TIMEOUT_MS, JsonLinesProcess, NativeBridgeError, PendingRequests, record, REQUEST_TIMEOUT_MS, stringField, textMessages } from './transport'

interface ClaudeBlock {
  type: string
  callId?: string
  final?: string
}

interface ClaudeMessage {
  blocks: Map<number, ClaudeBlock>
  nextFinalIndex: number
}

interface ClaudeRun {
  result: Deferred<void>
  signal: AbortSignal
  messages: Map<string, ClaudeMessage>
  finalFrames: Map<string, string>
  lanes: Map<string, string>
  tools: Set<string>
  endedTools: Set<string>
  tasks: Set<string>
  deferringTasks: Set<string>
  stoppedTasks: Set<string>
  resultReceived: boolean
  state?: string
  inputId: string
  error?: Error
  submitted: boolean
  interruptPending: boolean
  interruptSent: boolean
  interruptTimer?: ReturnType<typeof setTimeout>
}

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'stopped', 'killed'])
const DEFERRING_TASK_TYPES = new Set(['local_agent', 'local_workflow'])
const SESSION_START_HOOK_ID = 'dsh-native-session-identity'

function questionsOf(input: Record<string, unknown>): NativeQuestion[] {
  if (!Array.isArray(input.questions) || input.questions.length === 0)
    throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Claude user-input request is missing questions')
  const ids = new Set<string>()
  return input.questions.map((value) => {
    const question = record(value)
    const id = stringField(question, 'question')
    if (ids.has(id))
      throw new NativeBridgeError('BRIDGE_UNSUPPORTED_QUESTION', 'Claude question text must be unique to preserve answer identities')
    ids.add(id)
    if (question.isSecret === true)
      throw new NativeBridgeError('BRIDGE_UNSUPPORTED_QUESTION', 'Secret native questions cannot be recorded in the official session log')
    return {
      id,
      question: id,
      ...typeof question.multiSelect === 'boolean' ? { multiSelect: question.multiSelect } : {},
      ...Array.isArray(question.options)
        ? { options: question.options.map((value) => {
            const option = record(value)
            return { label: stringField(option, 'label'), ...typeof option.description === 'string' ? { description: option.description } : {} }
          }) }
        : {},
    }
  })
}

function resultText(content: unknown): string {
  if (typeof content === 'string')
    return content
  if (!Array.isArray(content))
    throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Claude tool result is missing content')
  return content.map((value) => {
    const block = record(value)
    return block.type === 'text' && typeof block.text === 'string' ? block.text : JSON.stringify(block)
  }).join('\n')
}

class ClaudeSession implements NativeSession {
  private readonly transport: JsonLinesProcess
  private readonly requests: PendingRequests
  private readonly approvals = new Map<string, AbortController>()
  private nativeId: string
  private active?: ClaudeRun
  private failure?: Error
  private disposed = false
  private opening = true
  private disposePromise?: Promise<void>
  private readonly identity = deferred<void>()
  private identityConfirmed = false
  private identityTimer?: ReturnType<typeof setTimeout>
  private readonly capabilities = new Set<string>()
  private startupModel?: string
  private effectiveModel?: string
  private defaultsPending: boolean
  private catalog?: NativeModelCatalog
  private appliedOptions: NativeTurnOptions = { model: null, reasoningEffort: null }

  constructor(command: NativeCommand, cwd: string, storedId: string | null, private readonly sink: NativeSink, private readonly options?: NativeSessionOpenOptions) {
    this.nativeId = options?.forkFrom ? '' : storedId ?? randomUUID()
    this.defaultsPending = storedId !== null || options?.forkFrom !== undefined
    this.transport = new JsonLinesProcess({ ...command, env: { ...(command.env ?? nativeEnvironment()), CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' } }, [
      '--print',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      ...options?.forkFrom ? [`--resume=${options.forkFrom}`, '--fork-session'] : [storedId === null ? `--session-id=${this.id}` : `--resume=${this.id}`],
    ], cwd)
    this.requests = new PendingRequests(value => this.transport.write(value))
    this.transport.onFailure((error) => {
      this.failure = error
      this.identity.reject(error)
      this.requests.failAll(error)
      this.active?.result.reject(error)
      this.withdrawApprovals(error)
    })
    this.transport.onMessage(message => this.receive(message))
  }

  get id(): string {
    return this.nativeId
  }

  async open(signal: AbortSignal): Promise<void> {
    const aborted = (): void => this.identity.reject(abortError(signal))
    try {
      signal.throwIfAborted()
      signal.addEventListener('abort', aborted, { once: true })
      this.identityTimer = setTimeout(() => {
        const error = new NativeBridgeError('BRIDGE_NATIVE_BIND_UNCONFIRMED', 'Claude did not acknowledge the native session before user input; a reserved UUID is not a running conversation')
        this.identity.reject(error)
        this.requests.failAll(error)
      }, REQUEST_TIMEOUT_MS)
      const initialization = { subtype: 'initialize', hooks: { SessionStart: [{ hookCallbackIds: [SESSION_START_HOOK_ID] }] } }
      const response = record(await this.control(initialization, signal))
      this.checkIdentity(response)
      this.noteCapabilities(response)
      if (response.models !== undefined)
        this.catalog = this.modelCatalog(response.models)
      if (this.failure)
        throw this.failure
      if (!this.identityConfirmed) {
        // Repeated initialize publishes a background-task snapshot even before the first user input.
        const snapshot = record(await this.control(initialization, signal))
        this.checkIdentity(snapshot)
      }
      await this.identity.promise
      if (this.failure)
        throw this.failure
      signal.throwIfAborted()
      this.opening = false
    }
    catch (error) {
      await this.dispose()
      throw error
    }
    finally {
      clearTimeout(this.identityTimer)
      signal.removeEventListener('abort', aborted)
    }
  }

  private modelCatalog(values: unknown): NativeModelCatalog {
    if (!Array.isArray(values))
      throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Claude initialization is missing supported models')
    const models = new Map<string, NativeModelInfo>()
    for (const value of values) {
      const model = record(value)
      const id = stringField(model, 'value')
      const levels = model.supportedEffortLevels
      if (levels !== undefined && (!Array.isArray(levels) || levels.some(value => typeof value !== 'string' || value === '')))
        throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Claude model reasoning capabilities are invalid')
      const efforts = Array.isArray(levels) && model.supportsEffort !== false ? levels.map(id => ({ id: String(id), name: String(id) })) : []
      const info = {
        id,
        name: stringField(model, 'displayName'),
        ...typeof model.description === 'string' ? { description: model.description } : {},
        ...efforts.length > 0 ? { reasoning: { efforts } } : {},
      }
      models.set(id, info)
      if (models.size > 10_000)
        throw new NativeBridgeError('BRIDGE_PROTOCOL_LIMIT', 'Claude model listing exceeded its limit')
    }
    return { models: [...models.values()], ...this.startupModel === undefined ? {} : { defaultModel: this.startupModel } }
  }

  async models(signal: AbortSignal): Promise<NativeModelCatalog> {
    signal.throwIfAborted()
    if (this.disposed || this.failure)
      throw this.failure ?? new NativeBridgeError('BRIDGE_PROCESS_CLOSED', 'Claude session was disposed')
    if (!this.catalog)
      throw new NativeBridgeError('BRIDGE_MODEL_DISCOVERY_UNAVAILABLE', 'Claude did not expose supported models in its public initialize response')
    const models = [...this.catalog.models]
    for (const id of [this.startupModel, this.effectiveModel]) {
      if (id && !models.some(model => model.id === id))
        models.push({ id, name: id })
    }
    return { models, ...this.startupModel === undefined ? {} : { defaultModel: this.startupModel } }
  }

  private async applyOptions(options: NativeTurnOptions, signal: AbortSignal): Promise<void> {
    const modelChanged = this.defaultsPending || options.model !== this.appliedOptions.model
    const effortChanged = this.defaultsPending || options.reasoningEffort !== this.appliedOptions.reasoningEffort
    if (!modelChanged && !effortChanged)
      return
    if (options.model !== null || options.reasoningEffort !== null) {
      const catalog = await this.models(signal)
      const model = options.model ?? (modelChanged ? undefined : this.startupModel)
      if (!model)
        throw new NativeBridgeError('BRIDGE_DEFAULT_UNAVAILABLE', 'Claude did not report a provable default model for reasoning validation')
      const info = catalog.models.find(value => value.id === model)
      if (options.model !== null && !info)
        throw new NativeBridgeError('BRIDGE_MODEL_UNAVAILABLE', `Claude did not advertise model: ${options.model}`)
      if (options.reasoningEffort !== null && !info?.reasoning?.efforts.some(value => value.id === options.reasoningEffort))
        throw new NativeBridgeError('BRIDGE_EFFORT_UNSUPPORTED', `Claude did not advertise reasoning effort ${options.reasoningEffort} for ${model}`)
    }
    try {
      if (modelChanged) {
        await this.control({ subtype: 'set_model', model: options.model }, signal)
        this.effectiveModel = options.model ?? undefined
        if (options.model === null)
          this.startupModel = undefined
      }
      // Public flag-layer null restores the model default, not a settings-file startup effort.
      if (effortChanged || modelChanged)
        await this.control({ subtype: 'apply_flag_settings', settings: { effortLevel: options.reasoningEffort } }, signal)
      this.appliedOptions = options
      this.defaultsPending = false
    }
    catch (error) {
      // A rejected/cancelled control may already have changed the native flag layer.
      // Close rather than reuse a process with an unacknowledged partial selection.
      this.transport.fail(errorFrom(error))
      throw error
    }
  }

  async submit(messages: readonly UserMessage[], signal: AbortSignal, options?: NativeTurnOptions): Promise<void> {
    signal.throwIfAborted()
    if (this.disposed || this.failure)
      throw this.failure ?? new NativeBridgeError('BRIDGE_PROCESS_CLOSED', 'Claude session was disposed')
    if (this.active)
      throw new NativeBridgeError('BRIDGE_BUSY', 'Claude native session already has an active run')
    const texts = textMessages(messages)
    if (texts.length === 0)
      throw new NativeBridgeError('BRIDGE_EMPTY_INPUT', 'Claude native run requires a user message')
    const selection = options ? { ...options } : undefined
    const run: ClaudeRun = {
      result: deferred<void>(),
      signal,
      messages: new Map(),
      finalFrames: new Map(),
      lanes: new Map(),
      tools: new Set(),
      endedTools: new Set(),
      tasks: new Set(),
      deferringTasks: new Set(),
      stoppedTasks: new Set(),
      resultReceived: false,
      inputId: randomUUID(),
      submitted: false,
      interruptPending: false,
      interruptSent: false,
    }
    this.active = run
    const aborted = (): void => {
      if (run.submitted)
        this.interrupt(run)
    }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      if (selection && (this.defaultsPending || selection.model !== this.appliedOptions.model || selection.reasoningEffort !== this.appliedOptions.reasoningEffort))
        await this.applyOptions(selection, signal)
      signal.throwIfAborted()
      run.submitted = true
      this.transport.write({
        type: 'user',
        session_id: this.id,
        uuid: run.inputId,
        parent_tool_use_id: null,
        message: { role: 'user', content: texts.map(text => ({ type: 'text', text })) },
      })
      await run.result.promise
      signal.throwIfAborted()
    }
    catch (error) {
      if (run.submitted && !signal.aborted)
        this.transport.fail(errorFrom(error))
      throw this.failure ?? (signal.aborted ? abortError(signal) : error)
    }
    finally {
      signal.removeEventListener('abort', aborted)
      clearTimeout(run.interruptTimer)
      this.withdrawApprovals(new NativeBridgeError('BRIDGE_REQUEST_CLOSED', 'Native run has ended'))
      this.active = undefined
    }
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.close()
    return this.disposePromise
  }

  private async close(): Promise<void> {
    this.disposed = true
    const error = new NativeBridgeError('BRIDGE_PROCESS_CLOSED', 'Claude native session was disposed')
    this.identity.reject(error)
    clearTimeout(this.identityTimer)
    this.withdrawApprovals(error)
    this.requests.failAll(error)
    this.active?.result.reject(error)
    await this.transport.close(this.active === undefined)
  }

  private control(request: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    const id = randomUUID()
    return this.requests.request(id, { type: 'control_request', request_id: id, request }, signal, timeoutMs)
  }

  private checkIdentity(message: Record<string, unknown>, required = false): void {
    if (required || typeof message.session_id === 'string') {
      const id = stringField(message, 'session_id')
      if (this.opening && this.options?.forkFrom && this.nativeId === '') {
        if (id === this.options.forkFrom)
          throw new NativeBridgeError('BRIDGE_FORK_MISMATCH', 'Claude fork did not acknowledge a new native session')
        this.nativeId = id
      }
      else if (id !== this.id) {
        throw new NativeBridgeError('BRIDGE_RESUME_MISMATCH', 'Claude reported a different native session; refusing to replace the stored binding')
      }
      this.identityConfirmed = true
      this.identity.resolve()
    }
  }

  private noteCapabilities(message: Record<string, unknown>): void {
    if (Array.isArray(message.capabilities)) {
      for (const capability of message.capabilities) {
        if (typeof capability === 'string')
          this.capabilities.add(capability)
      }
    }
  }

  private receive(message: Record<string, unknown>): void {
    const type = stringField(message, 'type')
    if (type === 'control_response') {
      const response = record(message.response)
      const id = stringField(response, 'request_id')
      if (response.subtype === 'success')
        this.requests.settle(id, response.response ?? {})
      else if (response.subtype === 'error')
        this.requests.settle(id, undefined, new NativeBridgeError('BRIDGE_NATIVE_REQUEST', stringField(response, 'error')))
      else
        throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Unsupported Claude control response')
      return
    }
    if (type === 'control_request') {
      const id = stringField(message, 'request_id')
      void this.answer(id, record(message.request)).catch(error => this.transport.fail(errorFrom(error)))
      return
    }
    if (type === 'control_cancel_request') {
      const id = stringField(message, 'request_id')
      this.approvals.get(id)?.abort(new NativeBridgeError('BRIDGE_REQUEST_CLOSED', 'Claude withdrew the control request'))
      this.approvals.delete(id)
      return
    }
    if (type === 'conversation_reset')
      throw new NativeBridgeError('BRIDGE_NATIVE_RESET', 'Claude reset its conversation; the existing official session binding cannot be silently changed')
    const run = this.active
    if (type === 'result') {
      const aborted = message.terminal_reason === 'aborted_streaming' || message.terminal_reason === 'aborted_tools'
      const error = aborted
        ? new NativeBridgeError('BRIDGE_NATIVE_INTERRUPTED', 'Claude interrupted its native turn')
        : message.is_error === true || message.subtype !== 'success'
          ? new NativeBridgeError('BRIDGE_NATIVE_TURN', typeof message.result === 'string' && message.result !== '' ? message.result : JSON.stringify(message.errors ?? message.subtype))
          : undefined
      if (!run && error) {
        this.transport.fail(error)
        return
      }
      this.checkIdentity(message, true)
      if (!run) {
        if (!this.opening)
          throw new NativeBridgeError('BRIDGE_UNEXPECTED_TURN', 'Claude completed a run outside the official agent turn')
        return
      }
      run.resultReceived = true
      run.error = error
      this.finish(run)
      return
    }
    this.checkIdentity(message, type === 'system' && (message.subtype === 'init' || message.subtype === 'background_tasks_changed'))
    if (type === 'system' && message.subtype === 'init') {
      this.noteCapabilities(message)
      if (this.opening && typeof message.model === 'string' && message.model !== '') {
        this.effectiveModel ??= message.model
        if (!this.defaultsPending)
          this.startupModel ??= message.model
      }
    }
    if (!run) {
      if (type === 'assistant' || type === 'stream_event' || (type === 'system' && message.subtype === 'task_started'))
        throw new NativeBridgeError('BRIDGE_UNEXPECTED_TURN', 'Claude produced work outside the official agent turn')
      return
    }
    switch (type) {
      case 'system':
        if (message.subtype === 'session_state_changed') {
          run.state = stringField(message, 'state')
          this.finish(run)
        }
        else if (message.subtype === 'task_started') {
          const id = stringField(message, 'task_id')
          run.tasks.add(id)
          if (typeof message.task_type === 'string' && DEFERRING_TASK_TYPES.has(message.task_type))
            run.deferringTasks.add(id)
          if (run.signal.aborted)
            this.stopTask(run, id)
        }
        else if (message.subtype === 'task_notification' || message.subtype === 'task_updated') {
          const status = message.subtype === 'task_notification' ? message.status : record(message.patch).status
          if (typeof status === 'string' && TERMINAL_TASK_STATUSES.has(status)) {
            const id = stringField(message, 'task_id')
            run.tasks.delete(id)
            run.deferringTasks.delete(id)
            this.finish(run)
          }
        }
        return
      case 'stream_event':
        if (message.parent_tool_use_id == null) {
          run.resultReceived = false
          run.error = undefined
        }
        this.stream(run, message)
        return
      case 'assistant': {
        if (typeof message.uuid === 'string') {
          const body = JSON.stringify(message.message)
          const previous = run.finalFrames.get(message.uuid)
          if (previous !== undefined) {
            if (previous !== body)
              throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Claude changed a previously settled assistant frame')
            return
          }
          run.finalFrames.set(message.uuid, body)
        }
        if (message.parent_tool_use_id == null) {
          run.resultReceived = false
          run.error = undefined
        }
        this.assistant(run, record(message.message))
        return
      }
      case 'user':
        this.toolResults(run, record(message.message))
    }
  }

  private finish(run: ClaudeRun): void {
    if (!run.resultReceived || (run.signal.aborted ? run.tasks.size : run.deferringTasks.size) !== 0 || run.interruptPending || (run.state !== undefined && run.state !== 'idle'))
      return
    if (run.error && !run.signal.aborted)
      run.result.reject(run.error)
    else
      run.result.resolve()
  }

  private stream(run: ClaudeRun, message: Record<string, unknown>): void {
    const event = record(message.event)
    const lane = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : ''
    if (event.type === 'message_start') {
      const id = stringField(record(event.message), 'id')
      run.lanes.set(lane, id)
      if (!run.messages.has(id))
        run.messages.set(id, { blocks: new Map(), nextFinalIndex: 0 })
      return
    }
    const id = run.lanes.get(lane)
    if (!id)
      return
    const state = run.messages.get(id)!
    if (event.type === 'content_block_start') {
      const index = this.blockIndex(event)
      const block = record(event.content_block)
      state.blocks.set(index, { type: stringField(block, 'type'), ...typeof block.id === 'string' ? { callId: block.id } : {} })
      const nativeId = `${id}:block:${index}`
      if (block.type === 'text' && typeof block.text === 'string' && block.text !== '')
        this.sink.text(nativeId, block.text)
      else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking !== '')
        this.sink.thinking(nativeId, block.thinking)
    }
    else if (event.type === 'content_block_delta') {
      const index = this.blockIndex(event)
      const delta = record(event.delta)
      const nativeId = `${id}:block:${index}`
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '')
        this.sink.text(nativeId, delta.text)
      else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '')
        this.sink.thinking(nativeId, delta.thinking)
    }
  }

  private blockIndex(event: Record<string, unknown>): number {
    if (typeof event.index !== 'number' || !Number.isSafeInteger(event.index) || event.index < 0)
      throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Claude stream block index is invalid')
    return event.index
  }

  private assistant(run: ClaudeRun, body: Record<string, unknown>): void {
    const id = stringField(body, 'id')
    if (!Array.isArray(body.content))
      throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Claude assistant message is missing content')
    const state = run.messages.get(id) ?? { blocks: new Map<number, ClaudeBlock>(), nextFinalIndex: 0 }
    run.messages.set(id, state)
    const aggregate = body.content.length > 1
    for (const [position, value] of body.content.entries()) {
      const block = record(value)
      const type = stringField(block, 'type')
      const serialized = JSON.stringify(block)
      const matching = [...state.blocks.entries()].find(([, existing]) => existing.final === undefined && existing.type === type && (type !== 'tool_use' || existing.callId === block.id))
      const aggregateIndex = aggregate && state.blocks.get(position)?.type === type ? position : undefined
      const index = aggregateIndex ?? matching?.[0] ?? state.nextFinalIndex
      const existing = state.blocks.get(index)
      if (existing?.final === serialized)
        continue
      if (existing?.final !== undefined)
        throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Claude changed a previously settled assistant block')
      state.blocks.set(index, { type, final: serialized, ...typeof block.id === 'string' ? { callId: block.id } : {} })
      state.nextFinalIndex = Math.max(state.nextFinalIndex, index + 1)
      let content: NativeContent
      if (type === 'text' && typeof block.text === 'string')
        content = { type: 'text', text: block.text }
      else if (type === 'thinking' && typeof block.thinking === 'string')
        content = { type: 'thinking', text: block.thinking }
      else if (type === 'tool_use')
        content = { type: 'tool-call', id: stringField(block, 'id'), name: stringField(block, 'name'), arguments: JSON.stringify(block.input ?? {}) }
      else if (type === 'redacted_thinking')
        continue
      else
        throw new NativeBridgeError('BRIDGE_UNSUPPORTED_EVENT', `Unsupported Claude assistant content: ${type}`)
      this.sink.assistant(`${id}:block:${index}`, [content])
      if (content.type === 'tool-call' && !run.tools.has(content.id)) {
        run.tools.add(content.id)
        this.sink.toolStart(content.id, content.name, content.arguments)
      }
    }
  }

  private toolResults(run: ClaudeRun, body: Record<string, unknown>): void {
    if (!Array.isArray(body.content))
      return
    for (const value of body.content) {
      const block = record(value)
      if (block.type !== 'tool_result')
        continue
      const id = stringField(block, 'tool_use_id')
      if (run.endedTools.has(id))
        continue
      if (!run.tools.has(id))
        throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Claude tool result has no native tool call in the active run')
      run.endedTools.add(id)
      this.sink.toolEnd(id, resultText(block.content), block.is_error === true)
    }
  }

  private interrupt(run: ClaudeRun): void {
    if (run.interruptSent)
      return
    run.interruptSent = true
    run.interruptTimer = setTimeout(() => {
      this.transport.fail(new NativeBridgeError('BRIDGE_INTERRUPT_TIMEOUT', 'Claude did not settle the interrupted run; its process was closed'))
    }, INTERRUPT_TIMEOUT_MS)
    run.interruptPending = true
    void this.control({ subtype: 'interrupt', ...this.capabilities.has('interrupt_cancel_queued_v1') ? { cancel_queued: true } : {} }, undefined, INTERRUPT_TIMEOUT_MS).then((response) => {
      const receipt = record(response ?? {})
      if (Array.isArray(receipt.still_queued) && receipt.still_queued.includes(run.inputId))
        throw new NativeBridgeError('BRIDGE_INTERRUPT_QUEUED_INPUT', 'Claude retained the cancelled user input in its native queue')
      run.interruptPending = false
      this.finish(run)
    }).catch((error) => {
      if (this.active === run)
        this.transport.fail(errorFrom(error))
    })
    for (const id of run.tasks)
      this.stopTask(run, id)
  }

  private stopTask(run: ClaudeRun, id: string): void {
    if (run.stoppedTasks.has(id))
      return
    run.stoppedTasks.add(id)
    void this.control({ subtype: 'stop_task', task_id: id }, undefined, INTERRUPT_TIMEOUT_MS).catch((error) => {
      if (this.active === run)
        this.transport.fail(errorFrom(error))
    })
  }

  private withdrawApprovals(error: Error): void {
    for (const controller of this.approvals.values())
      controller.abort(error)
    this.approvals.clear()
  }

  private async answer(id: string, request: Record<string, unknown>): Promise<void> {
    const controller = new AbortController()
    this.approvals.set(id, controller)
    const run = this.active
    const signal = run ? AbortSignal.any([run.signal, controller.signal]) : controller.signal
    try {
      if (request.subtype === 'hook_callback') {
        const input = record(request.input)
        if (request.callback_id !== SESSION_START_HOOK_ID || input.hook_event_name !== 'SessionStart')
          throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Claude invoked an unregistered native identity hook')
        this.checkIdentity(input, true)
        if (this.opening && typeof input.model === 'string' && input.model !== '') {
          this.effectiveModel ??= input.model
          if (!this.defaultsPending)
            this.startupModel ??= input.model
        }
        this.transport.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response: {} } })
        return
      }
      if (request.subtype !== 'can_use_tool') {
        this.replyError(id, `Unsupported native control request: ${String(request.subtype)}`)
        return
      }
      const tool = stringField(request, 'tool_name')
      const input = record(request.input)
      const callId = stringField(request, 'tool_use_id')
      let response: Record<string, unknown> = { behavior: 'deny', message: 'Native tool request is unavailable or cancelled' }
      if (run && !signal.aborted && !this.disposed) {
        if (tool === 'AskUserQuestion') {
          const questions = questionsOf(input)
          const received = await this.sink.questions(callId, questions, signal)
          const answers = Object.fromEntries(questions.map((question) => {
            const value = received[question.id]
            if (typeof value !== 'string' && !Array.isArray(value))
              throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Claude question response is missing an answer')
            return [question.id, Array.isArray(value) ? value.join(', ') : value]
          }))
          if (!signal.aborted)
            response = { behavior: 'allow', updatedInput: { ...input, answers } }
        }
        else {
          const allowed = await this.sink.approval(callId, {
            kind: tool === 'Bash' ? 'command' : ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) ? 'file' : 'tool',
            title: typeof request.title === 'string' ? request.title : tool,
            details: JSON.stringify({ tool, input, ...typeof request.description === 'string' ? { description: request.description } : {} }),
          }, signal)
          if (allowed && !signal.aborted)
            response = { behavior: 'allow', updatedInput: input }
        }
      }
      if (!controller.signal.aborted)
        this.transport.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
    }
    catch (error) {
      if (!controller.signal.aborted)
        this.replyError(id, errorFrom(error).message)
      if (request.subtype === 'hook_callback')
        this.transport.fail(errorFrom(error))
    }
    finally {
      this.approvals.delete(id)
    }
  }

  private replyError(id: string, error: string): void {
    this.transport.write({ type: 'control_response', response: { subtype: 'error', request_id: id, error } })
  }
}

export async function createClaudeSession(command: NativeCommand, cwd: string, nativeSessionId: string | null, sink: NativeSink, signal: AbortSignal, options?: NativeSessionOpenOptions): Promise<NativeSession> {
  if (options?.forkFrom !== undefined && (nativeSessionId !== null || options.forkFrom === ''))
    throw new NativeBridgeError('BRIDGE_FORK_INVALID', 'Claude fork requires a source session and no existing native binding')
  const session = new ClaudeSession(command, cwd, nativeSessionId, sink, options)
  await session.open(signal)
  return session
}
