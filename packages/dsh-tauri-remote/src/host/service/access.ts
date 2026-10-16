import type { RemoteAuthPolicy } from '../types/index'
import type { RemoteAccessBody, RemoteAccessDocument, RemoteAccessEvent, RemoteAccessEventKind, RemoteAccessState, RemoteAccessStatus } from './access.types'
import { defineService } from 'dsh-tauri'
import { toDataURL } from 'qrcode'
import { messageOf } from '../../shared/error'
import { hostServicePort, localUpstream, mintAuthenticatedUrl } from '../config/runtime'
import { createLinkToken, createSessionSecret } from '../utils/auth'
import { isAuthConfigured } from '../utils/source'
import { addressProblemOf, buildLink, buildTunnelLink, enumerateAddresses, isLoopbackListen, linkHostOf, maskLinkOf, pairingLinksOf, patchAccessDocument, policyOf, readAccessDocument, writeAccessDocument } from './access.utils'
import { gateway } from './gateway'
import { consumePairingCode, pairingCodeOf, resetPairingCode } from './pairing'
import { tunnel } from './tunnel'

const ENTRY_ID = 'inbound'

const EVENT_CAPACITY = 50

const NO_LOCAL_PORT = '无法确定本机 DSH 端口（宿主 webserver 未暴露端口且进程缺少 DSH_WEB_PORT），未开启入站暴露'

const CORRUPT_DOCUMENT = 'access.json 解析失败：已按未配置处理，写操作被拒绝以免覆盖原文件（请先修复或移走该文件）'

let failure: string | undefined

let sequence = 0

let events: RemoteAccessEvent[] = []

export const access = defineService({
  /** 网关每次判定都重新取用：配置与凭据变更立即生效（S2 §7.4）。 */
  policy(): RemoteAuthPolicy {
    return { ...policyOf(readAccessDocument().document), pairingCode: pairingCodeOf().code, consumePairingCode }
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
    const local = hostServicePort()
    const tunnelStatus = await tunnel.status()
    const tunnelLink = tunnelStatus.url === undefined ? undefined : buildTunnelLink(tunnelStatus.url, document.auth.token)
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
        hasToken: document.auth.token !== null,
        ...document.auth.token === null ? {} : { token: document.auth.token },
      },
      addresses,
      events: [...events],
      ...recommended === undefined ? {} : { recommended },
      ...link === undefined ? {} : { link },
      ...host === undefined || port === 0 ? {} : { maskLink: maskLinkOf(host, port, document.auth.token !== null) },
      tunnel: tunnelLink === undefined ? tunnelStatus : { ...tunnelStatus, link: tunnelLink, qr: await toDataURL(tunnelLink) },
      ...local === undefined ? {} : { localPort: local },
      ...problem === undefined ? {} : { error: problem },
      ...parsed.warnings.length === 0 ? {} : { warnings: parsed.warnings },
    }
    if (link !== undefined) {
      status.qr = await toDataURL(link)
      status.linkSource = isLoopbackListen(document.listen.address) ? 'loopback' : 'lan'
    }
    const pairing = pairingCodeOf()
    const pairingLinks = pairingLinksOf({ code: pairing.code, host, port, tunnelUrl: tunnelStatus.url })
    if (pairingLinks.link !== undefined || pairingLinks.tunnelLink !== undefined) {
      status.pairing = {
        ...pairing,
        ...pairingLinks.link === undefined ? {} : { link: pairingLinks.link, qr: await toDataURL(pairingLinks.link) },
        ...pairingLinks.tunnelLink === undefined ? {} : { tunnelLink: pairingLinks.tunnelLink, tunnelQr: await toDataURL(pairingLinks.tunnelLink) },
      }
    }
    return status
  },

  async apply(body: RemoteAccessBody): Promise<RemoteAccessStatus> {
    const parsed = readAccessDocument()
    if (parsed.corrupt)
      throw new Error(CORRUPT_DOCUMENT)
    for (const warning of parsed.warnings)
      note('state', warning)
    const next = patchAccessDocument(parsed.document, body, enumerateAddresses())
    if (body.enabled === true && body.authEnabled === undefined)
      next.auth.enabled = true
    if (next.auth.enabled)
      next.auth.sessionSecret ??= createSessionSecret()
    writeAccessDocument(next)
    await activate(next)
    return await access.status()
  },

  async ensureAuth(): Promise<RemoteAccessStatus> {
    const parsed = readAccessDocument()
    if (parsed.corrupt)
      throw new Error(CORRUPT_DOCUMENT)
    const next = { ...parsed.document, auth: { ...parsed.document.auth, enabled: true, sessionSecret: parsed.document.auth.sessionSecret ?? createSessionSecret() } }
    writeAccessDocument(next)
    await activate(next)
    return await access.status()
  },

  async rotate(): Promise<RemoteAccessStatus> {
    const parsed = readAccessDocument()
    if (parsed.corrupt)
      throw new Error(CORRUPT_DOCUMENT)
    writeAccessDocument({ ...parsed.document, auth: { ...parsed.document.auth, token: createLinkToken() } })
    note('token', '链接 Token 已轮换，旧链接立即失效（已签发的会话不受影响）')
    return await access.status()
  },

  async revoke(): Promise<RemoteAccessStatus> {
    const parsed = readAccessDocument()
    if (parsed.corrupt)
      throw new Error(CORRUPT_DOCUMENT)
    writeAccessDocument({ ...parsed.document, auth: { ...parsed.document.auth, token: null, sessionSecret: createSessionSecret() } })
    gateway.revoke()
    resetPairingCode()
    note('token', '链接 Token、已配对设备与会话授权已撤销')
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
    if (parsed.document.auth.enabled && parsed.document.auth.sessionSecret === undefined) {
      parsed.document.auth.sessionSecret = createSessionSecret()
      writeAccessDocument(parsed.document)
    }
    if (!parsed.document.enabled) {
      failure = undefined
      return
    }
    await activate(parsed.document)
  },

  async dispose(): Promise<void> {
    resetPairingCode()
    await gateway.stop(ENTRY_ID)
    failure = undefined
    events = []
  },
})

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
      tokenProvider: mintAuthenticatedUrl,
      auth: () => access.policy(),
    })
    failure = undefined
    note('state', `入站暴露已监听 ${entry.host}:${entry.port}`)
    if (!isLoopbackListen(document.listen.address) && !isAuthConfigured(access.policy()))
      note('auth', '未开启访问认证：公网与隧道来源将被 403 拒绝，私网来源可直连')
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

function note(kind: RemoteAccessEventKind, line: string): void {
  sequence += 1
  events = [...events, { seq: sequence, ts: new Date().toISOString(), kind, line }].slice(-EVENT_CAPACITY)
}
