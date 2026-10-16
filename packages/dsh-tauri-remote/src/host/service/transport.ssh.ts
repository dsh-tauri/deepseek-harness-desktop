import type { Buffer } from 'node:buffer'
import type { AddressInfo, Server, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { CompressionAlgorithm, ConnectConfig } from 'ssh2'
import type { MachineProfile, RemoteAuthMethod, RemoteExecOptions, RemoteExecResult, RemoteSession, RemoteStreamHandle } from '../types/index'
import type { ResolvedSshAuth } from '../utils/ssh-config'
import type { RemoteHostKeyVerifier, RemoteTransport, RemoteTransportOptions } from './transport.types'
import { createServer } from 'node:net'
import process from 'node:process'
import { Client } from 'ssh2'
import { DEFAULT_REMOTE_PORT, DEFAULT_SSH_PORT } from '../../shared/constants'
import { MachineId } from '../types/index'
import { loginShell } from '../utils/shell'
import { classifyConnectFailure, describeConnectFailure } from './transport.utils'

const COMPRESSION_ALGORITHMS: CompressionAlgorithm[] = ['zlib@openssh.com', 'none']
const DEFAULT_KEEPALIVE_INTERVAL_MS = 10_000
const DEFAULT_KEEPALIVE_COUNT_MAX = 3

export const sshTransport: RemoteTransport = {
  capabilities: { exec: true, stream: true },
  async connect(
    profile: MachineProfile,
    hostKeyVerifier: RemoteHostKeyVerifier,
    options: RemoteTransportOptions,
    signal?: AbortSignal,
  ): Promise<RemoteSession> {
    const hops: Ssh2Session[] = []
    try {
      const credentials = await options.resolveProfile(profile)
      const session = await connectTarget(credentials, String(profile.id), hostKeyVerifier, options, signal, hops, new Set())
      session.onClosed(() => {
        for (const hop of hops)
          void hop.close().catch(() => undefined)
      })
      return session
    }
    catch (error) {
      for (const hop of hops)
        void hop.close().catch(() => undefined)
      throw error
    }
  },
}

// --- internal ---

interface ProxyJumpHop {
  alias: string
  user?: string
  port?: number
}

function parseProxyJumpHop(token: string): ProxyJumpHop {
  let rest = token
  let user: string | undefined
  const at = rest.lastIndexOf('@')
  if (at !== -1) {
    user = rest.slice(0, at)
    rest = rest.slice(at + 1)
  }
  let port: number | undefined
  const colon = rest.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/u.test(rest.slice(colon + 1))) {
    port = Number(rest.slice(colon + 1))
    rest = rest.slice(0, colon)
  }
  return { alias: rest, ...user === undefined ? {} : { user }, ...port === undefined ? {} : { port } }
}

async function connectTarget(
  credentials: ResolvedSshAuth,
  label: string,
  hostKeyVerifier: RemoteHostKeyVerifier,
  options: RemoteTransportOptions,
  signal: AbortSignal | undefined,
  hops: Ssh2Session[],
  visited: ReadonlySet<string>,
): Promise<Ssh2Session> {
  const proxyJump = credentials.proxyJump ?? []
  if (proxyJump.length === 0)
    return connectWithAuth(credentials, label, hostKeyVerifier, options, signal, undefined)

  const chain: Array<{ alias: string, auth: ResolvedSshAuth }> = []
  const seen = new Set(visited)
  for (const token of proxyJump) {
    const hop = parseProxyJumpHop(token)
    const key = hop.alias.toLowerCase()
    if (seen.has(key))
      throw new Error(`proxy jump cycle through "${hop.alias}"`)
    seen.add(key)
    const jumpProfile: MachineProfile = {
      id: MachineId(hop.alias),
      name: hop.alias,
      host: hop.alias,
      user: hop.user ?? '',
      port: hop.port ?? DEFAULT_SSH_PORT,
      remotePort: DEFAULT_REMOTE_PORT,
    }
    const jumpAuth = await options.resolveProfile(jumpProfile)
    if ((jumpAuth.proxyJump ?? []).length > 0)
      throw new Error(`nested ProxyJump on "${hop.alias}" is not supported`)
    chain.push({ alias: hop.alias, auth: jumpAuth })
  }

  let sock: Duplex | undefined
  for (const [index, hop] of chain.entries()) {
    const session = await connectWithAuth(hop.auth, hop.alias, hostKeyVerifier, options, signal, sock)
    hops.push(session)
    const next = index + 1 < chain.length ? chain[index + 1]!.auth : credentials
    sock = await session.forwardOutStream(next.host, next.port)
  }
  return connectWithAuth(credentials, label, hostKeyVerifier, options, signal, sock)
}

function connectWithAuth(
  auth: ResolvedSshAuth,
  label: string,
  hostKeyVerifier: RemoteHostKeyVerifier,
  options: RemoteTransportOptions,
  signal: AbortSignal | undefined,
  sock: Duplex | undefined,
): Promise<Ssh2Session> {
  return new Promise<Ssh2Session>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    const client = new Client()
    const onAbort = (): void => {
      client.end()
      reject(abortError(signal as AbortSignal))
    }
    if (signal !== undefined)
      signal.addEventListener('abort', onAbort, { once: true })
    const settle = (fn: () => void): void => {
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    let winningMethod: RemoteAuthMethod | undefined
    let passwordOffered = false
    client.on('ready', () => {
      settle(() => resolve(new Ssh2Session(client, winningMethod)))
    })
    client.on('error', (error) => {
      settle(() => reject(describedConnectFailure(error, passwordOffered)))
    })
    void Promise.resolve().then(() => {
      const agent = process.env.SSH_AUTH_SOCK || undefined
      let agentOffered = false
      let keyIndex = 0
      const authHandler: NonNullable<ConnectConfig['authHandler']> = (_methodsLeft, _partialSuccess, callback) => {
        if (agent !== undefined && !agentOffered) {
          agentOffered = true
          winningMethod = 'agent'
          callback({ type: 'agent', username: auth.username, agent })
        }
        else if (keyIndex < auth.keys.length) {
          const key = auth.keys[keyIndex]!
          keyIndex += 1
          winningMethod = 'key'
          callback({
            type: 'publickey',
            username: auth.username,
            key: key.privateKey,
            ...key.passphrase === undefined ? {} : { passphrase: key.passphrase },
          })
        }
        else if (auth.password !== undefined && !passwordOffered) {
          passwordOffered = true
          winningMethod = 'password'
          callback({ type: 'password', username: auth.username, password: auth.password })
        }
        else {
          callback(false as never)
        }
      }
      client.connect({
        ...sock === undefined ? {} : { sock: sock as NonNullable<ConnectConfig['sock']> },
        host: auth.host,
        port: auth.port,
        username: auth.username,
        readyTimeout: options.readyTimeoutMs,
        keepaliveInterval: options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: options.keepaliveCountMax ?? DEFAULT_KEEPALIVE_COUNT_MAX,
        algorithms: { compress: COMPRESSION_ALGORITHMS },
        authHandler,
        hostVerifier: (key: Buffer, verify: (valid: boolean) => void): void => {
          const verdict = hostKeyVerifier(label, key)
          if (verdict instanceof Promise) {
            void verdict.then(verify, () => verify(false))
          }
          else {
            verify(verdict)
          }
        },
      })
    }, reject)
  })
}

function describedConnectFailure(error: Error, passwordOffered: boolean): Error {
  const kind = classifyConnectFailure(error, passwordOffered)
  const message = describeConnectFailure(kind, error)
  if (message === error.message)
    return error
  return new Error(message)
}

class Ssh2Session implements RemoteSession {
  private readonly closed = new Set<() => void>()
  private closedFired = false

  constructor(
    private readonly client: Client,
    readonly authMethod: RemoteAuthMethod | undefined = undefined,
  ) {
    this.client.on('close', () => {
      if (this.closedFired)
        return
      this.closedFired = true
      for (const callback of this.closed) callback()
      this.closed.clear()
    })
  }

  forwardOutStream(host: string, port: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      this.client.forwardOut('127.0.0.1', 0, host, port, (error, stream) => {
        if (error !== undefined) {
          reject(error)
          return
        }
        resolve(stream)
      })
    })
  }

  exec(command: string, options?: RemoteExecOptions): Promise<RemoteExecResult> {
    return new Promise<RemoteExecResult>((resolve, reject) => {
      let settled = false
      const timer = options?.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
          /* v8 ignore next 3 -- race guard: the timer always loses to close/error, which clear it */
            if (settled)
              return
            settled = true
            this.client.end()
            reject(new Error(`remote command timed out after ${options.timeoutMs} ms`))
          }, options.timeoutMs)
      this.client.exec(loginShell(command), (error, stream) => {
        if (error !== undefined) {
          /* v8 ignore next 3 -- race guard: an exec-open error either settles first or follows a timeout */
          if (!settled) {
            settled = true
            if (timer !== undefined)
              clearTimeout(timer)
            reject(error)
          }
          return
        }
        let stdout = ''
        let stderr = ''
        if (options?.stdinData !== undefined && options.stdinData.length > 0) {
          stream.write(options.stdinData)
          stream.end()
        }
        stream.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8')
          stdout += text
          options?.onData?.(text)
        })
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
        })
        stream.on('close', (code: number | null) => {
          if (settled)
            return
          settled = true
          if (timer !== undefined)
            clearTimeout(timer)
          resolve({ code, stdout, stderr })
        })
        stream.on('error', (streamError: Error) => {
          /* v8 ignore next -- race guard: a stream error either settles first or follows a timeout */
          if (settled)
            return
          settled = true
          if (timer !== undefined)
            clearTimeout(timer)
          reject(streamError)
        })
      })
    })
  }

  stream(remotePort: number, preferredLocalPort?: number): Promise<RemoteStreamHandle> {
    return this.listenTunnel(remotePort, preferredLocalPort, true)
  }

  private listenTunnel(remotePort: number, preferredLocalPort: number | undefined, allowFallback: boolean): Promise<RemoteStreamHandle> {
    return new Promise<RemoteStreamHandle>((resolve, reject) => {
      const sockets = new Set<Socket>()
      const server: Server = createServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        socket.on('error', () => {
          sockets.delete(socket)
          socket.destroy()
        })
        this.client.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, (error, channel) => {
          if (error !== undefined) {
            socket.destroy()
            return
          }
          channel.on('error', () => socket.destroy())
          socket.pipe(channel).pipe(socket)
        })
      })
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (allowFallback && error.code === 'EADDRINUSE' && preferredLocalPort !== undefined) {
          void this.listenTunnel(remotePort, undefined, false).then(resolve, reject)
          return
        }
        reject(error)
      })
      server.listen(preferredLocalPort ?? 0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        resolve({
          localPort: port,
          close: () => new Promise<void>((closeResolve) => {
            server.close(() => closeResolve())
            for (const socket of sockets) socket.destroy()
          }),
        })
      })
    })
  }

  onClosed(callback: () => void): void {
    if (this.closedFired) {
      callback()
      return
    }
    this.closed.add(callback)
  }

  close(): Promise<void> {
    this.client.end()
    return Promise.resolve()
  }
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error)
    return reason
  if (typeof reason === 'string')
    return new Error(reason)
  return new Error('This operation was aborted')
}
