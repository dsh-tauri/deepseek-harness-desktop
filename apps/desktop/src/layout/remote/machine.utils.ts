import type { RemoteMachineRow } from '@/hooks/use-remote'

export function remoteMachineStateTextOf(
  machine: Pick<RemoteMachineRow, 'authMethod' | 'nextRetryAt' | 'state'>,
  pending: boolean,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (pending)
    return t('remote.state.connecting')
  let text = t(`remote.state.${machine.state}`)
  if (machine.state === 'reconnecting' && machine.nextRetryAt !== undefined) {
    const seconds = Math.max(0, Math.ceil((machine.nextRetryAt - Date.now()) / 1000))
    text += t('remote.retry_in', { seconds })
  }
  if (machine.authMethod !== undefined)
    text += ` · ${t(`remote.auth.${machine.authMethod}`)}`
  return text
}

export function remoteMachineSubtitleOf(machine: Pick<RemoteMachineRow, 'host' | 'port' | 'user'>): string | undefined {
  if (machine.host === undefined)
    return undefined
  return `${machine.user !== undefined ? `${machine.user}@` : ''}${machine.host}${machine.port !== undefined ? `:${machine.port}` : ''}`
}
