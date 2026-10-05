import type { RemoteAuthPolicy, RemoteGatewayTokenProvider, RemoteHostContext } from '../types/index'
import type { RemoteAccessBody, RemoteAccessDocument, RemoteAccessEvent, RemoteAccessEventKind, RemoteAccessState, RemoteAccessStatus } from './access.types'
import process from 'node:process'
import { defineService } from 'dsh-tauri'
import { toDataURL } from 'qrcode'
import { messageOf } from '../../shared/error'
import { getCurrentHostInstance } from '../config/runtime'
import { createLinkToken, createSessionSecret } from '../utils/auth'
import { isAuthConfigured } from '../utils/source'
import { addressProblemOf, buildLink, enumerateAddresses, isLoopbackListen, linkHostOf, maskLinkOf, patchAccessDocument, policyOf, readAccessDocument, withoutToken, writeAccessDocument } from './access.utils'
import { gateway } from './gateway'

const ENTRY_ID = 'inbound'

const EVENT_CAPACITY = 50

const NO_LOCAL_PORT = '无法确定本机 DSH 端口（进程缺少 DSH_WEB_PORT），未开启入站暴露'

const SESSION_SECRET = createSessionSecret()

let failure: string | undefined

let sequence = 0

let events: RemoteAccessEvent[] = []

export const access = defineService({
  /** 网关每次判定都重新取用：配置与凭据变更立即生效（S2 §7.4）。 */
  policy(): RemoteAuthPolicy {
    return policyOf(readAccessDocument().document, SESSION_SECRET)
  },

  async status(): Promise<RemoteAccessStatus> {
    const parsed = readAccessDocument()
    const document = parsed.document
    const addresses = enumerateAddresses()
    const entry = gateway.status(ENTRY_ID)
    const listening = entry?.state === 'listening'
    const port = listening ? entry.port : 0
    const problem = failure ?? (document.enabled ? addressProblemOf(document.listen.address, addresses) : undefined)
    const host = listening ? linkHostOf(document.listen.address, addresses) : undefined
    const link = host === undefined || port === 0 ? undefined : buildLink(host, port, document.auth.token)
    const recommended = addresses.find(item => item.recommended)?.address
    const local = localPort()
    const state: RemoteAccessState = problem !== undefined ? 'error' : listening ? 'listening' : 'stopped'
    const status: RemoteAccessStatus = {
      version: document.version,
      enabled: document.enabled,
      state,
      listening,
      listen: document.listen,
      port,
      auth: {
        enabled: document.auth.enabled,
        scope: document.auth.scope,
        hasPassword: document.auth.password !== null,
        hasToken: document.auth.token !== null,
      },
      addresses,
      events: [...events],
      ...recommended === undefined ? {} : { recommended },
      ...link === undefined ? {} : { link },
      ...host === undefined || port === 0 ? {} : { maskLink: maskLinkOf(host, port, document.auth.token !== null) },
      ...Object.keys(document.tunnel).length === 0 ? {} : { tunnel: withoutToken(document.tunnel) },
      ...local === undefined ? {} : { localPort: local },
      ...problem === undefined ? {} : { error: problem },
      ...parsed.warnings.length === 0 ? {} : { warnings: parsed.warnings },
    }
    // 回环监听时链接仅本机可用，扫码无意义：不返回二维码，也不属于错误状态（S4 §7/§8）。
    if (link !== undefined && !isLoopbackListen(document.listen.address))
      status.qr = await toDataURL(link)
    return status
  },

  async apply(body: RemoteAccessBody): Promise<RemoteAccessStatus> {
    const parsed = readAccessDocument()
    for (const warning of parsed.warnings)
      note('state', warning)
    const next = patchAccessDocument(parsed.document, body, enumerateAddresses())
    writeAccessDocument(next)
    await activate(next)
    return await access.status()
  },

  async rotate(): Promise<RemoteAccessStatus> {
    const parsed = readAccessDocument()
    writeAccessDocument({ ...parsed.document, auth: { ...parsed.document.auth, token: createLinkToken() } })
    note('token', '链接 Token 已轮换，旧链接立即失效（已签发的会话不受影响）')
    return await access.status()
  },

  async revoke(): Promise<RemoteAccessStatus> {
    const parsed = readAccessDocument()
    writeAccessDocument({ ...parsed.document, auth: { ...parsed.document.auth, token: null } })
    note('token', '链接 Token 已作废，已签发的会话不受影响')
    return await access.status()
  },

  async restore(): Promise<void> {
    const parsed = readAccessDocument()
    if (parsed.corrupt) {
      failure = parsed.warnings[0]
      note('state', failure ?? 'access.json 解析失败')
      return
    }
    for (const warning of parsed.warnings)
      note('state', warning)
    if (!parsed.document.enabled) {
      failure = undefined
      return
    }
    await activate(parsed.document)
  },

  async dispose(): Promise<void> {
    await gateway.stop(ENTRY_ID)
    failure = undefined
    events = []
  },
})

// --- internal ---
async function activate(document: RemoteAccessDocument): Promise<void> {
  if (!document.enabled) {
    await gateway.stop(ENTRY_ID)
    failure = undefined
    note('state', '入站暴露已关闭')
    return
  }
  const upstream = localUpstream()
  if (upstream === undefined) {
    await fail(NO_LOCAL_PORT)
    return
  }
  const problem = addressProblemOf(document.listen.address, enumerateAddresses())
  if (problem !== undefined) {
    await fail(problem)
    return
  }
  try {
    const entry = await gateway.start({
      id: ENTRY_ID,
      kind: 'inbound',
      upstream,
      port: document.listen.port,
      host: document.listen.address,
      tokenProvider: tokenProvider(),
      auth: () => access.policy(),
    })
    failure = undefined
    note('state', `入站暴露已监听 ${entry.host}:${entry.port}`)
    if (!isLoopbackListen(document.listen.address) && !isAuthConfigured(access.policy()))
      note('auth', '未配置访问密码或链接 Token：公网与隧道来源将被 403 拒绝，私网来源可直连')
  }
  catch (error) {
    await fail(messageOf(error))
  }
}

async function fail(reason: string): Promise<void> {
  failure = reason
  await gateway.stop(ENTRY_ID)
  note('state', `入站暴露未开启：${reason}`)
}

function localPort(): number | undefined {
  const port = Number(process.env.DSH_WEB_PORT)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
}

/** 上游按运行期读取：宿主服务端口上浮后新进程按新的 DSH_WEB_PORT 重建入口，配置不写死端口。 */
function localUpstream(): string | undefined {
  const port = localPort()
  return port === undefined ? undefined : `http://127.0.0.1:${port}`
}

/** 宿主实例可能尚未绑定（或已随插件卸载清空）：此时放弃本次铸造并透传上游响应，不阻断转发（S2 §6）。 */
function tokenProvider(): RemoteGatewayTokenProvider {
  return async (authority) => {
    let connection: RemoteHostContext['connection']
    try {
      connection = getCurrentHostInstance().connection
    }
    catch {
      return undefined
    }
    return connection?.authenticatedUrl(`http://${authority}/`)
  }
}

function note(kind: RemoteAccessEventKind, line: string): void {
  sequence += 1
  events = [...events, { seq: sequence, ts: new Date().toISOString(), kind, line }].slice(-EVENT_CAPACITY)
}
