import type { PlatformLoader, RuntimeModules } from '../types'

export async function loadRuntimeModules(loader: PlatformLoader): Promise<RuntimeModules> {
  const [llm, session] = await Promise.all([loader.import('@deepseek-ai/dsh-llm'), loader.import('@deepseek-ai/dsh-session')])
  return {
    ToolCallId: resolveExport(loader, llm, 'ToolCallId'),
    HarnessError: resolveExport(loader, llm, 'HarnessError'),
    LlmAdapter: resolveExport(loader, llm, 'LlmAdapter'),
    isAgentLoopRequest: resolveExport(loader, llm, 'isAgentLoopRequest'),
    appendPluginRecord: optionalExport(loader, session, 'appendPluginRecord'),
    pluginRecordOf: optionalExport(loader, session, 'pluginRecordOf'),
  }
}

function optionalExport<K extends keyof RuntimeModules>(loader: PlatformLoader, value: unknown, key: K): RuntimeModules[K] | undefined {
  const direct = (value as Partial<RuntimeModules> | null)?.[key]
  if (typeof direct === 'function')
    return direct as RuntimeModules[K]
  const fallback = (loader.unwrapExports(value) as Partial<RuntimeModules> | null)?.[key]
  return typeof fallback === 'function' ? fallback as RuntimeModules[K] : undefined
}

function resolveExport<K extends keyof RuntimeModules>(loader: PlatformLoader, value: unknown, key: K): NonNullable<RuntimeModules[K]> {
  const value_ = optionalExport(loader, value, key)
  if (value_ === undefined)
    throw new TypeError(`BRIDGE_RUNTIME_EXPORT_MISSING: ${key}`)
  return value_ as NonNullable<RuntimeModules[K]>
}
