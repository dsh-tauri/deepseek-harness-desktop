import type { IncompatibleVersion, PolicyBlockedVersion } from '../preinstall/types'
import type { BlockedRefusal, Plugin, PluginRef } from './types'
import type { DshPlugin } from '@/types'

export interface NormalizedRef {
  spec: string
  name: string
  version?: string
}

const INCOMPATIBLE_PREFIX = 'PLUGIN_VERSION_INCOMPATIBLE:'
const POLICY_BLOCKED_PREFIX = 'PLUGIN_POLICY_BLOCKED:'
const UPDATE_HOLD_PREFIX = 'PLUGIN_UPDATE_NO_CHANGE:'
const UPDATE_FAILED_PREFIX = 'PLUGIN_UPDATE_FAILED:'
const INCOMPATIBLE_MESSAGE = /PLUGIN_VERSION_INCOMPATIBLE:|is incompatible with dsh/i

/**
 * 取一条载荷：升级的两段（显式安装、隐式 `--latest`）各自的结算会被宿主用换行拼成同一条
 * 错误（见 `update_failure_payload`），因此前缀可能落在任意一行，不能只看首行——否则第二行
 * 之后的结果全部解析不到，整批会退化成「升级插件 X 失败」。
 */
function payloadOf(error: string, prefix: string): string | null {
  const line = error.split('\n').find(item => item.startsWith(prefix))
  return line === undefined ? null : line.slice(prefix.length)
}

export function parseVersions<T>(error: string, prefix: string): T[] | null {
  const payload = payloadOf(error, prefix)
  if (payload === null)
    return null
  try {
    const parsed = JSON.parse(payload) as T[]
    return parsed.length > 0 ? parsed : null
  }
  catch (err) {
    console.error(`[PluginsManager] failed to parse ${prefix} payload:`, err)
    return null
  }
}

interface UpdateHoldEntry {
  name?: unknown
  latest?: unknown
  retryable?: unknown
}

/**
 * 升级没生效的载荷：宿主逐项核验整批插件后合成的结果。
 * 单个 id 时是一份对象，多个 id 时是同样结构的数组 —— 两者都要能解析，否则整批会退化成
 * 「升级插件 X 失败」，把「授权一下就能装上的新版本」说成失败。
 */
export function parseUpdateHold(error: string): BlockedRefusal | null {
  const payload = payloadOf(error, UPDATE_HOLD_PREFIX)
  if (payload === null)
    return null
  try {
    const parsed = JSON.parse(payload) as unknown
    const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
    const versions: PolicyBlockedVersion[] = []
    const retryableNames: string[] = []
    const heldNames: string[] = []
    entries.forEach((entry) => {
      const item = (entry ?? {}) as UpdateHoldEntry
      if (typeof item.name !== 'string')
        return
      const latest = typeof item.latest === 'string' && item.latest !== '' ? item.latest : null
      if (latest === null) {
        heldNames.push(item.name)
        return
      }
      versions.push({ name: item.name, version: latest })
      if (item.retryable === true)
        retryableNames.push(item.name)
    })
    if (versions.length === 0 && heldNames.length === 0)
      return null
    return {
      kind: 'update-hold',
      versions,
      retryable: retryableNames.length > 0,
      retryableNames,
      heldNames,
    }
  }
  catch (err) {
    console.error(`[PluginsManager] failed to parse ${UPDATE_HOLD_PREFIX} payload:`, err)
    return null
  }
}

/** 升级结算里的一条真实失败：宿主把「哪个插件、什么错」逐条带出来（见 `PLUGIN_UPDATE_FAILED`）。 */
export interface UpdateFailureEntry {
  name: string
  message: string
}

/**
 * 升级里除「没有变化」「等待授权」之外的失败，逐条归因到插件。
 *
 * 没有这份归因时前端只能把整条错误盖到本次提交的每个目标上：同一批里已经被宿主核验装上的
 * 目标也会跟着报失败（见 #914）。返回空数组表示这条错误没有逐项证据，调用方应保持原来的
 * 整组归因。
 */
export function parseUpdateFailures(error: string): UpdateFailureEntry[] {
  const payload = payloadOf(error, UPDATE_FAILED_PREFIX)
  if (payload === null)
    return []
  try {
    const parsed = JSON.parse(payload) as unknown
    const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
    return entries.flatMap((entry) => {
      const item = (entry ?? {}) as { name?: unknown, message?: unknown }
      if (typeof item.name !== 'string' || typeof item.message !== 'string')
        return []
      return [{ name: item.name, message: item.message }]
    })
  }
  catch (err) {
    console.error(`[PluginsManager] failed to parse ${UPDATE_FAILED_PREFIX} payload:`, err)
    return []
  }
}

export function parseBlockedRefusal(error: string): BlockedRefusal | null {
  const incompatible = parseVersions<IncompatibleVersion>(error, INCOMPATIBLE_PREFIX)
  if (incompatible)
    return { kind: 'incompatible', versions: incompatible }
  const policy = parseVersions<PolicyBlockedVersion>(error, POLICY_BLOCKED_PREFIX)
  if (policy)
    return { kind: 'policy', versions: policy }
  return parseUpdateHold(error)
}

export function refusalNames(refusal: BlockedRefusal): Set<string> {
  const names = new Set(refusal.versions.map(item => item.name))
  if (refusal.kind === 'update-hold')
    refusal.heldNames.forEach(name => names.add(name))
  return names
}

export function normalizeRef(ref: PluginRef): NormalizedRef {
  const raw = typeof ref === 'string' ? ref : ref?.spec
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`PLUGIN_REF_INVALID: ${JSON.stringify(ref)}`)
  }
  const spec = raw.trim()
  const explicit = typeof ref === 'string' ? undefined : ref.version
  const at = spec.lastIndexOf('@')
  const name = at > 0 ? spec.slice(0, at) : spec
  if (name === '')
    throw new Error(`PLUGIN_REF_INVALID: ${JSON.stringify(ref)}`)
  const declared = at > 0 ? spec.slice(at + 1) : undefined
  const version = explicit ?? declared
  if (version === undefined || version === '')
    return { spec: name, name }
  return { spec: `${name}@${version}`, name, version }
}

export function normalizeRefs(refs: PluginRef | PluginRef[]): NormalizedRef[] {
  const list = Array.isArray(refs) ? refs : [refs]
  if (list.length === 0)
    throw new Error('PLUGIN_REFS_EMPTY: no plugin refs provided')
  return list.map(item => normalizeRef(item))
}

export function enrichInstalled(list: DshPlugin[]): Plugin[] {
  return list.map((item) => {
    const error = item.error ?? null
    const incompatible = error !== null && INCOMPATIBLE_MESSAGE.test(error.message)
    return {
      id: item.id,
      name: item.name === '' ? item.id : item.name,
      version: item.version,
      description: item.description,
      repoUrl: item.repo_url,
      bundled: item.bundled,
      disabled: item.disabled,
      patchDisabled: item.patchDisabled,
      recommended: item.recommended,
      fix: item.fix,
      internal: item.internal,
      hasSnapshot: item.hasSnapshot,
      error,
      latest: item.latestVersion ?? null,
      updateAvailable: item.updateAvailable,
      incompatible,
      latestIncompatible: item.updateAvailable && incompatible,
    }
  })
}
