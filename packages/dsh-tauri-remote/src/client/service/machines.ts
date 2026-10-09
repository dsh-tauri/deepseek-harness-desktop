import type { MachineBusyOp } from '../store/modules/machines.types'
import type { RemoteMachineEvent, SecretValues, ServiceResult } from '../types/index'
import type { PersistMachinesInput } from './machines.types'
import { uniq } from 'dsh-tauri/client'
import * as api from '../apis/index'
import {
  enabledOf,
  errorMessageOf,
  installResultOf,
  machineEventsOf,
  machineListOf,
  REMOTE_API_EMPTY,
  savePayloadOf,
  sessionRoleOf,
  settingsWarningOf,
  testResultOf,
  tunnelUrlOf,
} from '../apis/parsers'
import { store } from '../store/index'

const NO_SECRETS: SecretValues = {}

export async function loadSettings(): Promise<void> {
  try {
    const settings = await api.getSettings()
    store.machines.setMigrationWarning(settingsWarningOf(settings))
    store.machines.setEnabled(enabledOf(settings) === true, null)
  }
  catch (error) {
    store.machines.setEnabled(false, errorMessageOf(error))
  }
}

export async function loadRole(): Promise<void> {
  try {
    store.machines.setRole(sessionRoleOf(await api.getSessionRole()))
  }
  catch {}
}

export async function load(): Promise<void> {
  if (store.machines.enabled === false)
    return
  store.machines.beginLoad()
  try {
    if (store.machines.role === null)
      await loadRole()
    store.machines.commitList(machineListOf(await api.getMachines()))
  }
  catch (error) {
    store.machines.failList(errorMessageOf(error))
  }
}

export async function setEnabled(enabled: boolean): Promise<ServiceResult> {
  store.machines.beginEnable()
  try {
    store.machines.setEnabled(enabledOf(await api.postSettings({ enabled })) ?? enabled, null)
    if (store.machines.enabled === true)
      await load()
    return { ok: true }
  }
  catch (error) {
    const message = errorMessageOf(error)
    store.machines.fail(message)
    return { ok: false, error: message }
  }
  finally {
    store.machines.endEnable()
  }
}

export async function poll(): Promise<void> {
  try {
    store.machines.commitList(machineListOf(await api.getMachines()))
    await pollEvents()
  }
  catch (error) {
    store.machines.fail(errorMessageOf(error))
  }
}

export async function persist(input: PersistMachinesInput): Promise<ServiceResult> {
  try {
    for (const machine of input.machines)
      await api.postMachines(savePayloadOf(machine, input.secrets[machine.id] ?? NO_SECRETS))
    const kept = input.machines.map(machine => machine.id)
    for (const id of store.machines.machines.map(row => row.id)) {
      if (!kept.includes(id))
        await api.deleteMachines({ machineId: id })
    }
    store.machines.clearError()
    await load()
    return { ok: true }
  }
  catch (error) {
    const message = errorMessageOf(error)
    store.machines.fail(message)
    return { ok: false, error: message }
  }
}

export async function remove(input: { machineId: string }): Promise<ServiceResult> {
  try {
    await api.deleteMachines({ machineId: input.machineId })
    store.machines.clearError()
    await load()
    return { ok: true }
  }
  catch (error) {
    const message = errorMessageOf(error)
    store.machines.fail(message)
    return { ok: false, error: message }
  }
}

export async function test(input: { machineId: string }): Promise<ServiceResult> {
  return withBusy(input.machineId, 'test', async () => {
    const value = testResultOf(await api.postMachinesTest({ machineId: input.machineId }))
    if (value.ok)
      store.machines.commitProbeOk(input.machineId, value.banner)
    else
      store.machines.commitProbeFailed(input.machineId, value.message)
  })
}

export async function connect(input: { machineId: string }): Promise<ServiceResult> {
  return withBusy(input.machineId, 'connect', async () => {
    const tunnelBaseUrl = tunnelUrlOf(await api.postMachinesConnect({ machineId: input.machineId }))
    if (tunnelBaseUrl === '')
      throw new Error(REMOTE_API_EMPTY)
    store.machines.commitConnected(input.machineId, tunnelBaseUrl)
  })
}

export async function disconnect(input: { machineId: string }): Promise<ServiceResult> {
  return withBusy(input.machineId, 'disconnect', async () => {
    await api.postMachinesDisconnect({ machineId: input.machineId })
    store.machines.commitDisconnected(input.machineId)
  })
}

export async function install(input: { machineId: string }): Promise<ServiceResult> {
  return withBusy(input.machineId, 'install', async () => {
    store.machines.commitInstallResult(input.machineId, installResultOf(await api.postMachinesInstall({ machineId: input.machineId })))
    await load()
  })
}

async function withBusy(machineId: string, op: MachineBusyOp, action: () => Promise<void>): Promise<ServiceResult> {
  store.machines.beginOp(machineId, op)
  try {
    await action()
    return { ok: true }
  }
  catch (error) {
    const message = errorMessageOf(error)
    store.machines.fail(message)
    return { ok: false, error: message }
  }
  finally {
    store.machines.endOp(machineId)
  }
}

async function pollEvents(): Promise<void> {
  if (!store.machines.eventsSupported)
    return
  const known = uniq([...store.machines.machines, ...store.machines.discovered].map(row => row.id))
  const lines: Record<string, string[]> = {}
  const cursors: Record<string, number> = {}
  try {
    for (const machineId of known) {
      const cursor = store.machines.eventCursors[machineId]
      const events = machineEventsOf(await api.getMachinesEvents(cursor === undefined ? { machineId } : { machineId, sinceSeq: cursor }))
      if (events.length === 0)
        continue
      cursors[machineId] = Math.max(...events.map(event => event.seq))
      for (const event of events) {
        const line = logLineOf(event)
        if (line === '')
          continue
        lines[event.machineId] = [...(lines[event.machineId] ?? []), line]
      }
    }
  }
  catch {
    store.machines.disableEvents()
    return
  }
  store.machines.advanceEvents(cursors)
  if (Object.keys(lines).length > 0)
    store.machines.appendLogs(lines)
}

function logLineOf(event: RemoteMachineEvent): string {
  if (event.line !== '')
    return event.line
  if (event.terminal === 'failed')
    return event.reason === undefined || event.reason === '' ? '[failed]' : `[failed] ${event.reason}`
  if (event.terminal === 'success')
    return '[success]'
  return ''
}
