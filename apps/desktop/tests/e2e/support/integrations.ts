import { readFileSync, realpathSync } from 'node:fs'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, relative } from 'node:path'
import process from 'node:process'

export type ManualIntegration = 'ssh' | 'tunnel'

export function manualIntegrations(env: NodeJS.ProcessEnv = process.env): ManualIntegration[] {
  const value = env.DSH_E2E_INTEGRATIONS?.trim()
  if (!value)
    return []
  if (env.CI || env.GITHUB_ACTIONS)
    throw new Error('人工外部集成禁止在 CI 运行。')
  const kinds = value.split(',')
  if (kinds.some(kind => kind !== 'ssh' && kind !== 'tunnel') || new Set(kinds).size !== kinds.length)
    throw new Error('DSH_E2E_INTEGRATIONS 仅接受 ssh、tunnel 或 ssh,tunnel。')
  return kinds as ManualIntegration[]
}

export function requireManualIntegration(kind: ManualIntegration): void {
  if (!manualIntegrations().includes(kind))
    throw new Error(`请通过 DSH_E2E_INTEGRATIONS=${kind} 显式选择人工外部集成。`)
}

export interface ManualSshFixture {
  host: string
  port: number
  user: string
  remotePort: number
  hostKeySha256: string
  privateKey?: string
  password?: string
  token?: string
}

export function loadManualSshFixture(): ManualSshFixture {
  requireManualIntegration('ssh')
  const configured = process.env.DSH_E2E_SSH_FIXTURE
  if (!configured || !isAbsolute(configured))
    throw new Error('DSH_E2E_SSH_FIXTURE 必须指向系统 Temp/dsh-e2e-ssh-*/fixture.json；不使用用户 SSH 配置。')
  const file = realpathSync(configured)
  const root = dirname(file)
  const temp = realpathSync(tmpdir())
  if (dirname(root) !== temp || !basename(root).startsWith('dsh-e2e-ssh-') || basename(file) !== 'fixture.json')
    throw new Error('SSH fixture 必须位于独占的系统 Temp/dsh-e2e-ssh-* 根内。')
  const within = relative(root, file)
  if (isAbsolute(within) || within.startsWith('..'))
    throw new Error('SSH fixture 不得越出独占根。')
  const fixture: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!fixture || typeof fixture !== 'object')
    throw new Error('SSH fixture 必须是对象。')
  const value = fixture as Record<string, unknown>
  if (typeof value.host !== 'string' || isIP(value.host) === 0
    || typeof value.user !== 'string' || !/^[\w.-]+$/u.test(value.user)
    || ![value.port, value.remotePort].every(port => typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535)
    || typeof value.hostKeySha256 !== 'string' || !/^[A-Za-z0-9+/]{43}=?$/u.test(value.hostKeySha256)
    || ![value.privateKey, value.password].some(secret => typeof secret === 'string' && secret.length > 0)
    || [value.privateKey, value.password, value.token].some(secret => secret !== undefined && typeof secret !== 'string')) {
    throw new Error('SSH fixture 需要 IP、用户名、合法端口、SHA-256 主机指纹及显式测试凭据。')
  }
  return value as unknown as ManualSshFixture
}
