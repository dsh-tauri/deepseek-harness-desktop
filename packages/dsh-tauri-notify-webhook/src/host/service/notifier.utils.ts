import type { Socket } from 'node:net'
import type { NotifyEmailSettings } from '../../shared/settings'
import { Buffer } from 'node:buffer'
import { connect } from 'node:net'
import { hostname } from 'node:os'
import { connect as connectTls } from 'node:tls'
import { NOTIFY_SMTP_STARTTLS, NOTIFY_SMTP_TLS } from '../../shared/constants'

export interface SmtpDelivery {
  settings: NotifyEmailSettings
  subject: string
  body: string
  timeoutMs: number
}

const EHLO_NAME = hostname().replace(/[^a-z0-9.-]/gi, '-') || 'localhost'

/** SMTP 续行以 `250-` 开头、末行以 `250 ` 收尾，只看首个换行会把多行应答截成半句。 */
function replyLength(buffer: string): number {
  let offset = 0
  while (offset < buffer.length) {
    const end = buffer.indexOf('\n', offset)
    if (end < 0)
      return -1
    const line = buffer.slice(offset, end).replace(/\r$/, '')
    offset = end + 1
    if (line.length === 3 || line[3] === ' ')
      return offset
  }
  return -1
}

function expectReply(reply: string, codes: readonly number[]): string {
  const code = Number.parseInt(reply.slice(0, 3), 10)
  if (!codes.includes(code))
    throw new Error(`NOTIFY_REMOTE: ${reply.replace(/\s+/g, ' ').trim()}`)
  return reply
}

/** `名字 <a@b>` 里 SMTP 命令只吃尖括号那一截。 */
function addressOf(value: string): string {
  return (/<([^>]+)>/.exec(value)?.[1] ?? value).trim()
}

/** 中文主题必须走 RFC 2047，否则收信端乱码。 */
function encodeSubject(value: string): string {
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/** 正文 base64 传输，一次绕开行长限制、8bit 与点转义三件事。 */
function encodeBody(value: string): string {
  return (Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n')
}

interface SmtpSession {
  read: () => Promise<string>
  command: (line: string, codes: readonly number[]) => Promise<string>
  close: () => void
  detach: () => void
}

/**
 * 裸 socket → 会话：应答按块排队，命令按「写一行、读一次应答」推进。
 * 超时与断开都记进 `failure` 并由下一次 `read` 抛出，失败点始终落在 await 上。
 */
function openSession(socket: Socket, timeoutMs: number): SmtpSession {
  socket.setTimeout(timeoutMs)

  let buffer = ''
  const queue: string[] = []
  let resolveNext: ((reply: string) => void) | null = null
  let rejectNext: ((error: Error) => void) | null = null
  let failure: Error | null = null

  const settle = (reply: string): void => {
    const resolve = resolveNext
    resolveNext = null
    rejectNext = null
    if (resolve === null)
      queue.push(reply)
    else
      resolve(reply)
  }

  const fail = (error: Error): void => {
    failure = error
    const reject = rejectNext
    resolveNext = null
    rejectNext = null
    reject?.(error)
  }

  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const length = replyLength(buffer)
      if (length < 0)
        return
      const reply = buffer.slice(0, length)
      buffer = buffer.slice(length)
      settle(reply)
    }
  }
  const onError = (error: Error): void => fail(error)
  const onTimeout = (): void => fail(new Error('NOTIFY_TIMEOUT'))
  const onClose = (): void => fail(new Error('NOTIFY_REMOTE: 连接被对端关闭'))

  socket.on('data', onData)
  socket.on('error', onError)
  socket.on('timeout', onTimeout)
  socket.on('close', onClose)

  const read = (): Promise<string> => {
    const reply = queue.shift()
    if (reply !== undefined)
      return Promise.resolve(reply)
    if (failure !== null)
      return Promise.reject(failure)
    return new Promise<string>((resolve, reject) => {
      resolveNext = resolve
      rejectNext = reject
    })
  }

  return {
    read,
    async command(line, codes) {
      socket.write(`${line}\r\n`)
      return expectReply(await read(), codes)
    },
    close() {
      socket.destroy()
    },
    detach() {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('timeout', onTimeout)
      socket.off('close', onClose)
      socket.setTimeout(0)
    },
  }
}

/** 隐式 TLS 等 `secureConnect`，明文与 STARTTLS 等 `connect`。 */
function connectSocket(host: string, port: number, security: string, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const secure = security === NOTIFY_SMTP_TLS
    const socket = secure ? connectTls({ host, port, servername: host }) : connect({ host, port })
    const fail = (error: Error): void => {
      socket.destroy()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error('NOTIFY_TIMEOUT')), timeoutMs)
    socket.once('error', fail)
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer)
      socket.off('error', fail)
      resolve(socket)
    })
  })
}

function upgradeSocket(socket: Socket, host: string, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const secured = connectTls({ socket, servername: host })
    const fail = (error: Error): void => {
      secured.destroy()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error('NOTIFY_TIMEOUT')), timeoutMs)
    secured.once('error', fail)
    secured.once('secureConnect', () => {
      clearTimeout(timer)
      secured.off('error', fail)
      resolve(secured)
    })
  })
}

/** 失败抛出的 `message` 已是 `NOTIFY_*` 错误码，调用方直接透传。 */
export async function sendMail(delivery: SmtpDelivery): Promise<void> {
  const { settings, subject, body, timeoutMs } = delivery
  let socket = await connectSocket(settings.host, settings.port, settings.security, timeoutMs)
  let session = openSession(socket, timeoutMs)

  try {
    expectReply(await session.read(), [220])
    await session.command(`EHLO ${EHLO_NAME}`, [250])

    if (settings.security === NOTIFY_SMTP_STARTTLS) {
      await session.command('STARTTLS', [220])
      session.detach()
      socket = await upgradeSocket(socket, settings.host, timeoutMs)
      session = openSession(socket, timeoutMs)
      await session.command(`EHLO ${EHLO_NAME}`, [250])
    }

    if (settings.username !== '') {
      await session.command('AUTH LOGIN', [334])
      await session.command(Buffer.from(settings.username, 'utf8').toString('base64'), [334])
      await session.command(Buffer.from(settings.password, 'utf8').toString('base64'), [235])
    }

    await session.command(`MAIL FROM:<${addressOf(settings.from)}>`, [250])
    await session.command(`RCPT TO:<${addressOf(settings.to)}>`, [250, 251])
    await session.command('DATA', [354])

    socket.write([
      `From: ${settings.from}`,
      `To: ${settings.to}`,
      `Subject: ${encodeSubject(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeBody(body),
      '.',
      '',
    ].join('\r\n'))

    expectReply(await session.read(), [250])
  }
  finally {
    session.close()
  }
}
