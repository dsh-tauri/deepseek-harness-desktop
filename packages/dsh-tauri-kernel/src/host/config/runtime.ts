import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BackendDetection } from '../../shared/types'
import type { NativeSink } from '../backends/types'
import type { OfficialSink } from '../service/sink.types'
import type { AdmittedStep, BridgeRecordType, NativeEntry, NativePending, RecordWatermark } from '../types'

export const runtime = {
  detections: new Map<string, BackendDetection>(),
  sessions: new Map<string, NativeEntry>(),
  pending: new Map<string, NativePending>(),
  removals: new Map<string, Promise<void>>(),
  closings: new Map<string, Promise<void>>(),
  controllers: new Map<string, AbortController>(),
  claims: new Map<string, string>(),
  sinks: new Map<string, NativeSink>(),
  exchanges: new Map<string, OfficialSink>(),
  steps: new Map<string, AdmittedStep>(),
  coldRoutes: new Set<Agent>(),
  modelWrites: new Map<Agent, Promise<void>>(),
  checkpoints: new Map<Agent, Promise<void>>(),
  verified: new Map<Agent, Map<BridgeRecordType, RecordWatermark>>(),
  ready: false,
  lifetime: new AbortController(),
}

export async function resetRuntime(): Promise<void> {
  runtime.ready = false
  runtime.lifetime.abort(new Error('BRIDGE_DISPOSED'))
  for (const controller of runtime.controllers.values())
    controller.abort(new Error('BRIDGE_DISPOSED'))
  const exchanges = [...runtime.exchanges.values()]
  for (const exchange of exchanges)
    exchange.state.controller.abort(new Error('BRIDGE_DISPOSED'))
  await Promise.allSettled([
    ...[...runtime.pending.values()].map(pending => pending.task),
    ...runtime.removals.values(),
    ...runtime.closings.values(),
    ...runtime.modelWrites.values(),
    ...runtime.checkpoints.values(),
    ...exchanges.map(exchange => exchange.state.task),
  ])
  const disposed = await Promise.allSettled(exchanges.map(exchange => exchange.dispose()))
  const entries = [...runtime.sessions.values()]
  runtime.sessions.clear()
  runtime.pending.clear()
  runtime.removals.clear()
  runtime.closings.clear()
  runtime.controllers.clear()
  runtime.claims.clear()
  runtime.sinks.clear()
  runtime.exchanges.clear()
  runtime.steps.clear()
  runtime.coldRoutes.clear()
  runtime.modelWrites.clear()
  runtime.checkpoints.clear()
  runtime.verified.clear()
  runtime.detections.clear()
  const outcomes = await Promise.allSettled(entries.map(entry => entry.session.dispose()))
  const failures = [...disposed, ...outcomes].filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
  if (failures.length > 0)
    throw new AggregateError(failures.map(failure => failure.reason), 'BRIDGE_DISPOSE_FAILED')
}
