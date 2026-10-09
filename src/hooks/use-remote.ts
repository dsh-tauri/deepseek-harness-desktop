import type { GetApiTauriSshMachinesResponse } from '@/apis/remote.types'
import { useEventListener, useUnmount, useWatch } from '@reause/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useRef, useState } from 'react'
import { getMachines, getMachinesEvents, postMachinesConnect, postMachinesDisconnect } from '@/apis/remote'
import { queryKeys } from '@/config/query-keys'

type SshMachineListItem = NonNullable<GetApiTauriSshMachinesResponse['items']>[number]
type SshConnectionState = NonNullable<SshMachineListItem['state']>
type SshProgress = NonNullable<SshMachineListItem['progress']>
type SshProgressPhase = SshProgress['phase']

export type SshMachineRow = { id: string, name: string, state: SshConnectionState } & Pick<SshMachineListItem, 'color' | 'tintBorder' | 'host' | 'port' | 'user' | 'tunnelBaseUrl' | 'lastError' | 'nextRetryAt' | 'authMethod'> & { progress?: Pick<SshProgress, 'phase'> }

interface SwitcherTargets {
  activeId: string | null
  pendingId: string | null
  activeTunnelUrl: string
}

function initialMachineId(): string | null {
  if (!('__TAURI_INTERNALS__' in window))
    return null
  const label = getCurrentWindow().label
  return label.startsWith('remote-') ? label.slice('remote-'.length) || null : null
}

export function useRemote() {
  const queryClient = useQueryClient()
  const [targets, setTargets] = useState<SwitcherTargets>({ activeId: null, pendingId: null, activeTunnelUrl: '' })
  const [bootId, setBootId] = useState(initialMachineId)
  const [connectTrail, setConnectTrail] = useState<SshProgressPhase[]>([])
  const [connectDismissed, setConnectDismissed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const epochRef = useRef(0)
  const outageLoggedRef = useRef(false)
  const machinesQuery = useQuery({
    queryKey: queryKeys.remoteMachines,
    queryFn: async () => {
      try {
        return machineRowsOf(await getMachines())
      }
      catch (error) {
        if (String(error).startsWith('REMOTE_API_MISSING:'))
          return { enabled: false, machines: [] as SshMachineRow[] }
        throw error
      }
    },
    refetchInterval: 2000,
  })
  const machines = machinesQuery.data?.enabled ? machinesQuery.data.machines : []
  const available = !machinesQuery.isError
  const enabled = machinesQuery.data?.enabled === true

  function refresh() {
    return machinesQuery.refetch({ cancelRefetch: false })
  }

  function invalidate() {
    return queryClient.invalidateQueries({ queryKey: queryKeys.remoteMachines })
  }

  const connect = useMutation({
    mutationFn: ({ id }: { id: string, epoch: number }) => postMachinesConnect({ machineId: id }),
    onSuccess: async (_link, variables) => {
      if (variables.epoch === epochRef.current)
        await invalidate()
    },
    onError: (_error, variables) => {
      if (variables.epoch !== epochRef.current)
        return
      setTargets(previous => ({ ...previous, pendingId: null }))
      setConnectDismissed(false)
      void invalidate()
    },
  })
  const disconnect = useMutation({
    mutationFn: (machineId: string) => postMachinesDisconnect({ machineId }),
    onSettled: invalidate,
  })
  const connectFailed = connect.isError && connect.variables.epoch === epochRef.current
    ? { id: connect.variables.id, error: connect.error instanceof Error ? connect.error.message : String(connect.error) }
    : null
  const trackedId = targets.pendingId ?? connectFailed?.id ?? null
  const events = useQuery({
    queryKey: [...queryKeys.remoteEvents, trackedId, attempt],
    enabled: trackedId !== null && !connectDismissed,
    queryFn: async () => {
      const key = [...queryKeys.remoteEvents, trackedId, attempt]
      const previous = queryClient.getQueryData<{ seq: number, line: string }[]>(key) ?? []
      const sinceSeq = previous.reduce((next, item) => Math.max(next, item.seq + 1), 0)
      const items = eventEntriesOf(await getMachinesEvents({ machineId: trackedId!, sinceSeq }))
      return [...previous, ...items.filter(item => item.seq >= sinceSeq)]
    },
    refetchInterval: 2000,
    gcTime: 0,
  })

  useWatch([machinesQuery.data], () => {
    if (machinesQuery.data === undefined)
      return
    if (!enabled) {
      epochRef.current += 1
      setTargets({ activeId: null, pendingId: null, activeTunnelUrl: '' })
      connect.reset()
      setConnectTrail([])
      return
    }
    setTargets(previous => reconcileSwitcher(previous, machines))
  }, { immediate: true })

  const phase = machines.find(machine => machine.id === trackedId)?.progress?.phase
  useWatch([phase, trackedId], () => {
    if (phase !== undefined)
      setConnectTrail(previous => previous.at(-1) === phase ? previous : [...previous, phase])
    if (trackedId === null)
      setConnectTrail([])
  })

  useWatch([bootId, machinesQuery.data, available], () => {
    if (bootId !== null && available && enabled && machines.some(machine => machine.id === bootId))
      switchTo(bootId)
  }, { immediate: true })

  useEventListener('focus', () => {
    if (!document.hidden)
      void refresh()
  })
  useWatch([machinesQuery.isError, machinesQuery.isSuccess], () => {
    // 失败查询在下一轮 2 秒轮询落回 error 前可能短暂经过 pending；这仍是同一次
    // 故障，只有真正成功的响应才能重新开放告警。若直接监听 `available = !isError`，
    // 本地服务尚未启动时就会每轮轮询都写一次相同警告。
    if (machinesQuery.isSuccess) {
      outageLoggedRef.current = false
    }
    else if (machinesQuery.isError && !outageLoggedRef.current) {
      outageLoggedRef.current = true
      console.warn('[remote] ssh api unreachable:', String(machinesQuery.error))
    }
  })
  useUnmount(() => {
    epochRef.current += 1
  })

  function switchTo(machineId: string) {
    setBootId(null)
    if (!available)
      return
    const machine = machines.find(item => item.id === machineId)
    if (machine === undefined)
      return
    epochRef.current += 1
    setAttempt(previous => previous + 1)
    connect.reset()
    setConnectTrail([])
    setConnectDismissed(false)
    if (machine.state === 'connected' && machine.tunnelBaseUrl !== undefined) {
      setTargets({ activeId: machineId, pendingId: null, activeTunnelUrl: machine.tunnelBaseUrl })
      return
    }
    setTargets(previous => ({ ...previous, pendingId: machineId }))
    if (machine.state === 'disconnected' || machine.state === 'given-up')
      connect.mutate({ id: machineId, epoch: epochRef.current })
  }

  function dismissConnect() {
    if (targets.pendingId === null)
      connect.reset()
    setConnectTrail([])
    setConnectDismissed(true)
    setAttempt(previous => previous + 1)
  }

  function backToLocal() {
    epochRef.current += 1
    setBootId(null)
    setTargets({ activeId: null, pendingId: null, activeTunnelUrl: '' })
    connect.reset()
    dismissConnect()
  }

  function disconnectMachine(machineId: string) {
    if (targets.activeId === machineId || targets.pendingId === machineId)
      backToLocal()
    disconnect.mutate(machineId)
  }

  return {
    machines,
    enabled,
    available,
    ...targets,
    connectTrail,
    connectLog: connectDismissed ? [] : (events.data ?? []).map(item => item.line),
    connectFailed,
    connectDismissed,
    switchTo,
    backToLocal,
    disconnect: disconnectMachine,
    dismissConnect,
    refresh,
  }
}

export type Remote = ReturnType<typeof useRemote>

export function dotClassOf(machine: Pick<SshMachineRow, 'color' | 'state'>): string {
  if (machine.color !== undefined)
    return ''
  switch (machine.state) {
    case 'connected':
      return 'bg-success'
    case 'reconnecting':
    case 'connecting':
    case 'testing':
      return 'bg-warning'
    case 'given-up':
      return 'bg-danger'
    default:
      return 'bg-line-strong'
  }
}

export function reconcileSwitcher(prev: SwitcherTargets, machines: readonly SshMachineRow[]): SwitcherTargets {
  let { activeId, pendingId, activeTunnelUrl } = prev
  const active = machines.find(machine => machine.id === activeId)
  if (active === undefined || active.state === 'disconnected' || active.state === 'given-up') {
    activeId = null
    activeTunnelUrl = ''
  }
  else if (active.state === 'connected' && active.tunnelBaseUrl !== undefined) {
    activeTunnelUrl = active.tunnelBaseUrl
  }
  const pending = machines.find(machine => machine.id === pendingId)
  if (pending === undefined || pending.state === 'given-up') {
    pendingId = null
  }
  else if (pending.state === 'connected' && pending.tunnelBaseUrl !== undefined) {
    activeId = pending.id
    activeTunnelUrl = pending.tunnelBaseUrl
    pendingId = null
  }
  return { activeId, pendingId, activeTunnelUrl }
}

export function machineRowsOf(value?: { enabled?: boolean, items?: readonly unknown[], discovered?: readonly unknown[] }): { enabled: boolean, machines: SshMachineRow[] } {
  const machines = [...(value?.items ?? []), ...(value?.discovered ?? [])]
    .map(machineRowOf)
    .filter((row): row is SshMachineRow => row !== undefined)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { enabled: value?.enabled === true, machines }
}

export function eventEntriesOf(value?: { items?: readonly unknown[] }): { seq: number, line: string }[] {
  return (value?.items ?? []).flatMap((raw) => {
    if (typeof raw !== 'object' || raw === null)
      return []
    const item = raw as Record<string, unknown>
    if (typeof item.seq !== 'number' || typeof item.line !== 'string')
      return []
    return [{ seq: item.seq, line: item.line }]
  })
}

function machineRowOf(raw: unknown): SshMachineRow | undefined {
  if (typeof raw !== 'object' || raw === null)
    return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || value.id === '' || typeof value.name !== 'string' || value.name === '')
    return undefined
  if (!['disconnected', 'testing', 'connecting', 'connected', 'reconnecting', 'given-up'].includes(String(value.state)))
    return undefined
  return {
    id: value.id,
    name: value.name,
    ...typeof value.color === 'string' && value.color !== '' ? { color: value.color } : {},
    ...value.tintBorder === true ? { tintBorder: true } : {},
    ...typeof value.host === 'string' && value.host !== '' ? { host: value.host } : {},
    ...typeof value.port === 'number' ? { port: value.port } : {},
    ...typeof value.user === 'string' && value.user !== '' ? { user: value.user } : {},
    state: value.state as SshConnectionState,
    ...typeof value.tunnelBaseUrl === 'string' ? { tunnelBaseUrl: value.tunnelBaseUrl } : {},
    ...typeof value.lastError === 'string' ? { lastError: value.lastError } : {},
    ...typeof value.nextRetryAt === 'number' ? { nextRetryAt: value.nextRetryAt } : {},
    ...value.authMethod === 'agent' || value.authMethod === 'key' || value.authMethod === 'password' ? { authMethod: value.authMethod } : {},
    ...progressOf(value.progress),
  }
}

function progressOf(raw: unknown): { progress?: Pick<SshProgress, 'phase'> } {
  if (typeof raw !== 'object' || raw === null)
    return {}
  const value = raw as Record<string, unknown>
  if (!['handshake', 'installing', 'starting', 'probing', 'syncing'].includes(String(value.phase)))
    return {}
  return { progress: { phase: value.phase as SshProgressPhase } }
}
