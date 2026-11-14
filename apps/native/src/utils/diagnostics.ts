import type { HostHealth } from '@/store/modules/connection'
import type { BridgeAddress } from '@/utils/bridge-protocol'

export interface DiagnosticInput {
  address: BridgeAddress | null
  stage: string
  health: HostHealth | undefined
  loadError: string | null
  notice: string | null
  probe: string | null
  authenticated: boolean
  timedOut: boolean
}

/** 连接失败时给用户的诊断文本：只写令牌有无，绝不写入令牌明文。 */
export function buildDiagnosticLog(input: DiagnosticInput): string {
  const lines = [
    'DSH Mobile connection diagnostics',
    `time: ${new Date().toISOString()}`,
    `stage: ${input.stage}`,
    `health: ${input.health ?? 'unknown'}`,
    `probe: ${input.probe ?? 'none'}`,
    `loadError: ${input.loadError ?? 'none'}`,
    `notice: ${input.notice ?? 'none'}`,
    `loadTimedOut: ${yesNo(input.timedOut)}`,
  ]
  if (input.address === null) {
    lines.push('address: none')
    return lines.join('\n')
  }
  lines.push(
    `address: ${input.address.url}`,
    `host: ${input.address.host}`,
    `port: ${String(input.address.port)}`,
    `remote: ${yesNo(input.address.remote === true)}`,
    `hasToken: ${yesNo(Boolean(input.address.token))}`,
    `hasDeviceSession: ${yesNo(input.authenticated)}`,
  )
  return lines.join('\n')
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}
