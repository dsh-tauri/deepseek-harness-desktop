import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDispatchExecution, ToolExecution, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { HostContext, NativeExecution } from '../types'
import type { NativeToolResult, OfficialSink, SinkState, StreamTrack, ToolTrack } from './sink.types'
import { Buffer } from 'node:buffer'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { runtime } from '../config/runtime'
import { server } from '../server'
import { loadRuntimeModules } from '../utils/runtime-modules'

const MAX_QUEUED_CHUNKS = 8_192
const MAX_QUEUED_BYTES = 8 * 1_024 * 1_024
const MAX_TURN_BYTES = 64 * 1_024 * 1_024
const MAX_TURN_TOOLS = 1_024

export const sink = defineService({
  async create(input: NativeExecution): Promise<OfficialSink> {
    const ctx = getServerContext<HostContext>(server)
    const modules = await loadRuntimeModules(ctx.loader)
    const { agent, signal } = input
    signal.throwIfAborted()
    runtime.lifetime.signal.throwIfAborted()
    if (runtime.exchanges.has(agent.id))
      throw new Error('BRIDGE_BUSY: 此会话已有原生回合。')
    const controller = new AbortController()
    const state: SinkState = {
      input,
      controller,
      signal: AbortSignal.any([signal, controller.signal, runtime.lifetime.signal]),
      streams: new Map(),
      assistants: new Map(),
      tools: new Map(),
      registrations: new Map(),
      restoreMode: agent.ctx.tools.presentAs('native'),
      queue: [],
      queuedBytes: 0,
      outputBytes: 0,
      segment: 0,
      nextIndex: 0,
      lastStep: input.step,
      active: true,
      done: false,
      finalConsumed: false,
      native: {
        text(id, text): void { delta(id, 'text', text) },
        thinking(id, text): void { delta(id, 'reasoning', text) },
        assistant(id, content): void {
          assertActive()
          const encoded = JSON.stringify(content)
          const committed = state.assistants.get(id)
          if (committed !== undefined) {
            if (committed !== encoded)
              throw new Error('BRIDGE_ASSISTANT_CONFLICT: 原生消息的重复提交不一致。')
            return
          }
          const current = track(id)
          const used = new Set<number>()
          const calls: { index: number, call: Extract<typeof content[number], { type: 'tool-call' }> }[] = []
          for (const block of content) {
            if (block.type === 'tool-call') {
              if (state.tools.has(block.id) || state.tools.size >= MAX_TURN_TOOLS)
                throw new Error('BRIDGE_TOOL_CONFLICT: 原生工具身份重复或超过回合限制。')
              const name = toolName(block.name)
              const tool = createTool(name, block.arguments)
              state.tools.set(block.id, tool)
              register(name)
              calls.push({ index: state.nextIndex++, call: { ...block, name } })
              continue
            }
            const type = block.type === 'thinking' ? 'reasoning' : 'text'
            let index = current.blocks.find(candidate => candidate.type === type && !used.has(candidate.index))?.index
            if (index === undefined) {
              index = startBlock(current, type)
              push({ type: type === 'text' ? 'text-delta' : 'reasoning-delta', index, text: block.text })
            }
            used.add(index)
            push({ type: 'block-end', index, block: { type, text: block.text } })
          }
          for (const block of current.blocks) {
            if (!used.has(block.index))
              push({ type: 'block-end', index: block.index, block: { type: block.type, text: '' } })
          }
          current.content = content
          state.assistants.set(id, encoded)
          account(encoded)
          if (calls.length > 0) {
            if ([...state.streams.values()].some(value => value.segment === state.segment && value.content === undefined))
              throw new Error('BRIDGE_ASSISTANT_UNSETTLED: 原生工具边界前仍有未确认消息。')
            for (const { index, call } of calls) {
              const block = { ...call, id: modules.ToolCallId(call.id) }
              push({ type: 'block-start', index, blockType: 'tool-call' })
              push({ type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments })
              push({ type: 'block-end', index, block })
            }
            push({ type: 'finish', reason: { kind: 'tool-calls' } })
            state.segment++
            state.nextIndex = 0
          }
        },
        toolStart(id, name, arguments_): void {
          assertActive()
          const current = state.tools.get(id)
          if (!current || current.name !== toolName(name) || current.arguments !== arguments_)
            throw new Error('BRIDGE_TOOL_NOT_PRESENTED: 工具开始前没有对应的官方工具消息。')
          current.started = true
        },
        toolEnd(id, output, isError = false): void {
          assertActive()
          const current = state.tools.get(id)
          if (!current?.started)
            throw new Error('BRIDGE_TOOL_NOT_STARTED: 原生工具结果没有对应调用。')
          if (current.result !== undefined) {
            if (current.result.output !== output || current.result.isError !== isError)
              throw new Error('BRIDGE_TOOL_RESULT_CONFLICT: 原生工具的重复结果不一致。')
            return
          }
          account(output)
          current.result = { output, isError }
          current.resolve(current.result)
        },
        async approval(id, request, requestSignal): Promise<boolean> {
          assertActive()
          const current = state.tools.get(id)
          const outcome = await getServerContext<HostContext>(server).approval.request({
            agent,
            toolName: current?.name ?? request.title,
            ...(current === undefined ? {} : { callId: modules.ToolCallId(id) }),
            reason: request.details,
            signal: requestSignal === undefined ? state.signal : AbortSignal.any([state.signal, requestSignal]),
          })
          assertActive()
          requestSignal?.throwIfAborted()
          return outcome === 'allowed-once'
        },
        async questions(id, questions, requestSignal): Promise<Record<string, string | string[]>> {
          assertActive()
          const answer = await getServerContext<HostContext>(server).userQuestions.ask({
            agent,
            questions,
            wait: { callId: modules.ToolCallId(id) },
            signal: requestSignal === undefined ? state.signal : AbortSignal.any([state.signal, requestSignal]),
          })
          assertActive()
          requestSignal?.throwIfAborted()
          const result: Record<string, string | string[]> = {}
          for (const question of questions) {
            const item = answer.answers.find(candidate => candidate.id === question.id)
            if (!item)
              throw new Error('BRIDGE_QUESTION_ANSWER_MISSING: 问题未得到完整回答。')
            const values = [...item.selected, ...(item.custom === undefined ? [] : [item.custom])]
            result[question.id] = question.multiSelect ? values : values.join(', ')
          }
          return result
        },
      },
    }

    function assertActive(): void {
      const host = getServerContext<HostContext>(server)
      if (!state.active || host.agents.get(agent.id) !== agent || host.sessions.get(agent.id) !== agent.session)
        throw new Error('BRIDGE_NOTIFICATION_OUTSIDE_TURN: 原生内核在回合结束后继续输出。')
      state.signal.throwIfAborted()
    }

    function account(text: string): number {
      const bytes = Buffer.byteLength(text)
      state.outputBytes += bytes
      if (state.outputBytes > MAX_TURN_BYTES)
        throw new Error('BRIDGE_STREAM_OVERFLOW: 原生回合超过输出限制。')
      return bytes
    }

    function push(chunk: SinkState['queue'][number]): void {
      state.signal.throwIfAborted()
      const bytes = account(JSON.stringify(chunk))
      if (state.queue.length >= MAX_QUEUED_CHUNKS || state.queuedBytes + bytes > MAX_QUEUED_BYTES)
        throw new Error('BRIDGE_STREAM_OVERFLOW: 原生输出超过缓冲限制。')
      state.queue.push(chunk)
      state.queuedBytes += bytes
      state.wake?.()
      state.wake = undefined
    }

    function track(id: string): StreamTrack {
      assertActive()
      let current = state.streams.get(id)
      if (!current) {
        current = { blocks: [], deltaSlots: new Map(), segment: state.segment }
        state.streams.set(id, current)
      }
      if (current.content !== undefined || current.segment !== state.segment)
        throw new Error('BRIDGE_ASSISTANT_ALREADY_SETTLED: 原生消息已提交或跨越工具边界。')
      return current
    }

    function startBlock(current: StreamTrack, type: 'text' | 'reasoning'): number {
      const index = state.nextIndex++
      current.blocks.push({ index, type })
      push({ type: 'block-start', index, blockType: type })
      return index
    }

    function delta(id: string, type: 'text' | 'reasoning', text: string): void {
      const current = track(id)
      let index = current.deltaSlots.get(type)
      if (index === undefined) {
        index = startBlock(current, type)
        current.deltaSlots.set(type, index)
      }
      push({ type: type === 'text' ? 'text-delta' : 'reasoning-delta', index, text })
    }

    function register(name: string): void {
      if (state.registrations.has(name))
        return
      const dispose = agent.ctx.tools.register({
        name,
        description: '等待本机内核已经发起的工具结果；不执行 DSH 工具。',
        parameters: { type: 'object', additionalProperties: true },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        isConcurrencySafe: () => true,
        async execute(_args, exec): Promise<string> {
          const tool = expectedTool(state, exec)
          if (!tool.dispatched)
            throw new Error('BRIDGE_TOOL_ROUTE_UNAVAILABLE: 原生调用未经过官方工具检查。')
          const abort = (): void => controller.abort(exec.signal.reason)
          exec.signal.addEventListener('abort', abort, { once: true })
          if (exec.signal.aborted)
            abort()
          try {
            const result = await tool.wait
            exec.signal.throwIfAborted()
            if (result.isError) {
              const error = new modules.HarnessError(result.output || 'Native tool failed', 'BRIDGE_NATIVE_TOOL_ERROR')
              error.name = 'NativeToolError'
              throw error
            }
            return result.output
          }
          finally {
            exec.signal.removeEventListener('abort', abort)
            if (state.signal.aborted)
              await state.task
          }
        },
        projectContent(exec, result) {
          const tool = state.tools.get(exec.callId)
          if (tool?.result?.isError && result.isError && result.error.info?.code === 'BRIDGE_NATIVE_TOOL_ERROR')
            return [{ type: 'text', text: tool.result.output }]
          return undefined
        },
      })
      state.registrations.set(name, dispose)
    }

    const official: OfficialSink = {
      state,
      settle(error): void {
        if (!state.active)
          return
        if (error === undefined && !state.signal.aborted) {
          if ([...state.streams.values()].some(current => current.content === undefined))
            error = new Error('BRIDGE_ASSISTANT_UNSETTLED: 原生内核没有确认最终消息。')
          else if ([...state.tools.values()].some(tool => tool.result === undefined))
            error = new Error('BRIDGE_TOOL_UNSETTLED: 原生内核没有确认全部工具结果。')
        }
        state.failure = error ?? (state.signal.aborted ? state.signal.reason : undefined)
        state.active = false
        try {
          if (state.failure === undefined)
            push({ type: 'finish', reason: { kind: 'stop' } })
        }
        catch (failure) {
          state.failure = failure
        }
        finally {
          if (state.failure !== undefined) {
            for (const tool of state.tools.values())
              tool.reject(state.failure)
          }
          state.done = true
          state.wake?.()
          state.wake = undefined
        }
      },
      async dispose(): Promise<void> {
        if (state.disposal)
          return state.disposal
        state.active = false
        controller.abort(new Error('BRIDGE_TURN_CLOSED'))
        for (const tool of state.tools.values())
          tool.reject(state.failure ?? controller.signal.reason)
        state.disposal = (async () => {
          const outcomes = await Promise.allSettled([...state.registrations.values()].map(dispose => Promise.resolve().then(dispose)))
          state.registrations.clear()
          const mode = await Promise.allSettled([Promise.resolve().then(state.restoreMode)])
          if (runtime.exchanges.get(agent.id) === official)
            runtime.exchanges.delete(agent.id)
          const failures = [...outcomes, ...mode].filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
          if (failures.length > 0)
            throw new AggregateError(failures.map(failure => failure.reason), 'BRIDGE_TOOLS_DISPOSE_FAILED')
        })()
        return state.disposal
      },
    }
    runtime.exchanges.set(agent.id, official)
    return official
  },

  async executeTool(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
    const official = exec.agent === undefined ? undefined : runtime.exchanges.get(exec.agent.id)
    if (!official)
      return next()
    try {
      const tool = expectedTool(official.state, exec)
      if (tool.dispatched)
        throw new Error('BRIDGE_TOOL_ALREADY_DISPATCHED: 不能重复派发原生工具调用。')
      tool.dispatched = true
      return await next()
    }
    catch (error) {
      official.state.controller.abort(error)
      await official.state.task
      throw error
    }
  },

  commitTool(value: Session, event: SessionEvent): void {
    if (event.type !== 'tool/result')
      return
    const official = runtime.exchanges.get(value.id)
    if (!official || official.state.input.agent.session !== value || official.state.input.turn !== event.data.turn)
      return
    const state = official.state
    const tool = state.tools.get(event.data.message.toolCallId)
    if (!tool || tool.step !== event.data.step || !tool.accepted || tool.committed || !tool.result || tool.result.isError !== (event.data.message.isError === true) || JSON.stringify(event.data.message.content) !== JSON.stringify([{ type: 'text', text: tool.result.output }]) || (tool.result.isError && event.data.error?.code !== 'BRIDGE_NATIVE_TOOL_ERROR') || event.data.meta !== undefined) {
      state.failure = new Error('BRIDGE_TOOL_RESULT_REJECTED: 官方日志没有完整保留原生工具结果。')
      state.controller.abort(state.failure)
      return
    }
    tool.committed = true
  },

  acceptTool(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined {
    const official = exec.agent === undefined ? undefined : runtime.exchanges.get(exec.agent.id)
    if (!official)
      return undefined
    try {
      const tool = expectedTool(official.state, exec)
      if (!tool.dispatched || !tool.result || result.isError !== tool.result.isError || result.additionalContexts?.length || result.concludesTurn || JSON.stringify(result.content) !== JSON.stringify([{ type: 'text', text: tool.result.output }]) || (!result.isError && result.value !== tool.result.output) || (result.isError && result.error.info?.code !== 'BRIDGE_NATIVE_TOOL_ERROR'))
        throw new Error('BRIDGE_TOOL_RESULT_REJECTED: 官方工具结果与原生结果不一致，不能继续原生回合。')
      tool.accepted = true
    }
    catch (error) {
      official.state.failure = error
      official.state.controller.abort(error)
    }
    return undefined
  },
})

function createTool(name: string, arguments_: string): ToolTrack {
  let resolve!: (result: NativeToolResult) => void
  let reject!: (error: unknown) => void
  const wait = new Promise<NativeToolResult>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  void wait.catch(() => undefined)
  return { name, arguments: arguments_, started: false, dispatched: false, accepted: false, committed: false, wait, resolve, reject }
}

function expectedTool(state: SinkState, exec: Readonly<ToolExecution> | ToolRunContext | ToolDispatchExecution): ToolTrack {
  const tool = state.tools.get(exec.callId)
  if (state.input.agent !== exec.agent || !tool || exec.parent !== undefined || tool.name !== exec.name || !sameArguments(tool.arguments, exec.arguments))
    throw new Error('BRIDGE_TOOL_NOT_PRESENTED: 没有对应的原生工具调用。')
  return tool
}

function sameArguments(raw: string, value: unknown): boolean {
  try {
    return JSON.stringify(raw === '' ? {} : JSON.parse(raw)) === JSON.stringify(value)
  }
  catch {
    return raw === value
  }
}

function toolName(name: string): string {
  if (name === 'AskUserQuestion')
    return 'ask_user_question'
  return name === 'run_code' ? 'native_run_code' : name
}
