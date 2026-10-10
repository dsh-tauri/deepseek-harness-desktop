import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BridgeRecordType, HostContext, RecordWatermark } from '../types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { z } from 'zod'
import { KERNEL_RECORD_TYPE, MODEL_RECORD_TYPE } from '../config/constants'
import { runtime } from '../config/runtime'
import { server } from '../server'
import { waitFor } from '../utils/abort'

const watermarkSchema = z.object({
  type: z.enum([KERNEL_RECORD_TYPE, MODEL_RECORD_TYPE]),
  seq: z.number().int().nonnegative(),
  encodedData: z.string(),
}).strict().readonly().nullable()

export const checkpoint = defineService({
  register(): () => void {
    const ctx = getServerContext<HostContext>(server)
    return ctx.sessionProjections.register({
      key: 'bridgeCheckpoint',
      stateSchema: z.object({
        ownerSessionId: z.string().min(1),
        inheritedEventCount: z.number().int().nonnegative(),
        binding: watermarkSchema,
        model: watermarkSchema,
      }).strict().readonly(),
      init: (header, inheritedEventCount) => Object.freeze({ ownerSessionId: header.id, inheritedEventCount, binding: null, model: null }),
      apply(state, event) {
        const type: string = event.type
        if (event.ignorable !== true || (type !== MODEL_RECORD_TYPE && type !== KERNEL_RECORD_TYPE))
          return state
        if (type === KERNEL_RECORD_TYPE && event.seq < state.inheritedEventCount)
          return state
        const watermark = Object.freeze({ type, seq: event.seq, encodedData: encode(event.data) })
        return Object.freeze({ ...state, [type === MODEL_RECORD_TYPE ? 'model' : 'binding']: watermark })
      },
      stateVersion: 1,
    })
  },

  mark(agent: Agent, type: BridgeRecordType, seq: number, data: unknown): void {
    const watermark = watermarks(agent).find(record => record.type === type)
    if (watermark?.seq !== seq || watermark.encodedData !== encode(data))
      throw new Error('BRIDGE_RECORD_NOT_COMMITTED: 官方记录的持久化水位不一致。')
    runtime.verified.get(agent)?.delete(type)
  },

  isVerified(agent: Agent): boolean {
    return watermarks(agent).every(record => sameWatermark(record, runtime.verified.get(agent)?.get(record.type)))
  },

  async flush(agent: Agent, signal: AbortSignal, force = false): Promise<void> {
    const lifetime = runtime.lifetime
    const scoped = AbortSignal.any([signal, lifetime.signal])
    while (true) {
      assertLive(agent, lifetime, scoped)
      const previous = runtime.checkpoints.get(agent)
      if (previous) {
        await waitFor(previous.catch(() => undefined), scoped)
        continue
      }
      const records = watermarks(agent).filter(record => !sameWatermark(record, runtime.verified.get(agent)?.get(record.type)))
      if (records.length === 0 && !force)
        return
      const task = persist(agent, records, lifetime, scoped)
      runtime.checkpoints.set(agent, task)
      void task.finally(() => {
        if (runtime.checkpoints.get(agent) === task)
          runtime.checkpoints.delete(agent)
      }).catch(() => undefined)
      await waitFor(task, scoped)
      force = false
    }
  },
})

function watermarks(agent: Agent): RecordWatermark[] {
  const ctx = getServerContext<HostContext>(server)
  const state = ctx.sessionProjections.stateOf(agent.session, 'bridgeCheckpoint')
  if (!state || state.ownerSessionId !== agent.id || state.inheritedEventCount !== agent.session.inheritedEventCount)
    throw new Error('BRIDGE_CORE_UNAVAILABLE: 官方会话记录的持久化投影不可用。')
  return [state.model, agent.session.header.isSeeded ? state.binding : null].filter((value): value is RecordWatermark => value !== null)
}

async function persist(agent: Agent, records: RecordWatermark[], lifetime: AbortController, signal: AbortSignal): Promise<void> {
  const ctx = getServerContext<HostContext>(server)
  const persistence = ctx.get('sessionPersistence')
  const refusal = records.length === 0 || records.some(record => record.type === MODEL_RECORD_TYPE) ? 'BRIDGE_MODEL_NOT_PERSISTED' : 'BRIDGE_BINDING_NOT_PERSISTED'
  if (typeof persistence?.open !== 'function' || typeof persistence.flush !== 'function' || !await ctx.sessions.flush(agent.session))
    throw new Error(`${refusal}: 官方会话记录无法持久保存。`)
  assertLive(agent, lifetime, signal)
  await persistence.flush()
  assertLive(agent, lifetime, signal)
  const reader = await persistence.open(agent.id, 'read', { signal })
  try {
    assertLive(agent, lifetime, signal)
    const header = agent.session.header
    if (reader.id !== agent.id || reader.header.id !== header.id || reader.header.cwd !== header.cwd || reader.header.agentPreset !== header.agentPreset || reader.header.parentSession !== header.parentSession || reader.header.isSeeded !== header.isSeeded || reader.inheritedEventCount !== agent.session.inheritedEventCount)
      throw new Error(`${refusal}: 官方持久会话与当前会话身份不一致。`)
    for (const record of records) {
      const { events } = await reader.read(record.seq, 1, { signal })
      assertLive(agent, lifetime, signal)
      const event = events[0]
      if (events.length !== 1 || event?.seq !== record.seq || (event.type as string) !== record.type || event.ignorable !== true || encode(event.data) !== record.encodedData)
        throw new Error(`${refusal}: 官方持久记录未包含当前选择或原生绑定。`)
    }
  }
  finally {
    await reader.close()
  }
  assertLive(agent, lifetime, signal)
  let verified = runtime.verified.get(agent)
  if (!verified) {
    verified = new Map()
    runtime.verified.set(agent, verified)
  }
  for (const record of records) {
    if (watermarks(agent).some(current => sameWatermark(current, record)))
      verified.set(record.type, record)
  }
}

function sameWatermark(left: RecordWatermark, right: RecordWatermark | undefined): boolean {
  return right !== undefined && left.type === right.type && left.seq === right.seq && left.encodedData === right.encodedData
}

function encode(data: unknown): string {
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    throw new Error('BRIDGE_RECORD_NOT_COMMITTED: 官方桥接记录必须是完整对象。')
  return JSON.stringify(data, Object.keys(data).sort())
}

function assertLive(agent: Agent, lifetime: AbortController, signal: AbortSignal): void {
  signal.throwIfAborted()
  const ctx = getServerContext<HostContext>(server)
  if (!runtime.ready || runtime.lifetime !== lifetime || ctx.agents.get(agent.id) !== agent || ctx.sessions.get(agent.id) !== agent.session)
    throw new Error('BRIDGE_AGENT_REPLACED: 官方会话已关闭或被替换。')
}
