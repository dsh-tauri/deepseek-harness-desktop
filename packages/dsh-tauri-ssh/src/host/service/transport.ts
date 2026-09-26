/**
 * SSH transport seam and its ssh2 implementation. The manager depends on the
 * narrow interfaces here — connect, exec, tunnel, close — so tests inject a
 * fake transport and never touch the network.
 * @module dsh-tauri-ssh/host/service/transport
 */

import type { AddressInfo, Server } from 'node:net'
import type { Duplex } from 'node:stream'
import type { ConnectConfig } from 'ssh2'
import type { MachineProfile, SshAuthMethod } from '../types/index'
import type { ResolvedSshAuth } from './ssh-config'
import { Buffer } from 'node:buffer'
import { get as httpGet } from 'node:http'
import { createServer } from 'node:net'
import process from 'node:process'
import { Client } from 'ssh2'
import { MachineId } from '../types/index'

/** The credential-resolution face the transport needs (SshConfigResolver implements it). */
export interface SshCredentialsResolver {
  resolve: (profile: MachineProfile) => Promise<ResolvedSshAuth>
}

/** One completed remote command. */
export interface SshExecResult {
  /** Exit code; null when the remote side reported none. */
  code: number | null
  stdout: string
  stderr: string
}

/** Optional exec behavior: a deadline, a streaming stdout tap, and stdin bytes. */
export interface SshExecOptions {
  /** Abort the command after this many milliseconds (closes the connection). */
  timeoutMs?: number
  /** Receive stdout chunks as they arrive (long-running commands, logs). */
  onData?: (chunk: string) => void
  /**
   * Bytes written to the command's stdin, then EOF. Used to stream payloads
   * (a skill tarball) without landing them on the remote command line, whose
   * single-argument length the kernel caps far below a real payload.
   */
  stdinData?: Buffer
}

/**
 * Cookie-injection slot of one tunnel. The remote `dsh web` session cookie is
 * `SameSite=Strict`: an iframe embedding the tunnel URL is a cross-site
 * context and neither stores nor sends it (the shell's remote view showed
 * the bare 401 page even with the launch token in the URL). With a cookie
 * minted at connect time (one local `GET …/?token=…` round-trip, no redirect
 * follow), the tunnel stamps every request head itself — any embedding
 * context (iframe, webview, browser tab) is authenticated transparently.
 * `cookie === undefined` keeps the plain TCP pipe.
 */
export interface TunnelHeaderInjection {
  /** The raw `Cookie` header value (`name=value`); read per accepted connection. */
  cookie: string | undefined
}

/** A local loopback listener forwarding into the SSH tunnel. */
export interface SshTunnelHandle {
  /** The bound loopback port (0 = ephemeral, read from the server). */
  localPort: number
  /** Close the listener; in-flight forwarded connections are aborted. */
  close: () => Promise<void>
}

/** One authenticated SSH session. */
export interface SshSession {
  /**
   * Which credential this session authenticated with (`agent`, `key`, or
   * `password`); absent when the transport cannot tell.
   */
  readonly authMethod?: SshAuthMethod | undefined
  /**
   * Run one command through the remote login shell.
   * @param command - the full command line.
   * @param options - optional deadline and streaming stdout tap.
   * @returns the collected result.
   */
  exec: (command: string, options?: SshExecOptions) => Promise<SshExecResult>
  /**
   * Forward a remote loopback port to a new local loopback listener
   * (`ssh -L` semantics).
   * @param remotePort - the remote 127.0.0.1 port to reach.
   * @param preferredLocalPort - keep the tunnel's published URL stable across
   *   reconnects by re-binding this port when possible (falls back to an
   *   ephemeral port when it is taken).
   * @param injection - mutable cookie-injection slot; when `cookie` is set,
   *   every request head through the tunnel gets it stamped (see
   *   {@link TunnelHeaderInjection}).
   * @returns the local listener handle.
   */
  openTunnel: (remotePort: number, preferredLocalPort?: number, injection?: TunnelHeaderInjection) => Promise<SshTunnelHandle>
  /**
   * Register the session-closed callback (connection dropped, server went
   * away, or {@link close} ran).
   * @param callback - fired exactly once.
   */
  onClosed: (callback: () => void) => void
  /** Close the session; idempotent. */
  close: () => Promise<void>
}

/**
 * TOFU host-key gate, keyed by hop label: the target machine id for the final
 * hop, the `ProxyJump` alias for each jump host (jump keys are remembered
 * under their own alias, so a host used as both jump and machine shares one
 * TOFU record). May be async (the ssh2 callback form waits for the verdict).
 */
export type SshHostKeyVerifier = (label: string, hostKey: Buffer) => boolean | Promise<boolean>

/** Transport factory: authenticate one machine and return its session. */
export interface SshTransport {
  /**
   * @param profile - the machine profile to connect.
   * @param hostKeyVerifier - TOFU host-key gate, per hop label.
   * @param signal - aborts the handshake.
   * @returns the authenticated session.
   */
  connect: (
    profile: MachineProfile,
    hostKeyVerifier: SshHostKeyVerifier,
    signal?: AbortSignal,
  ) => Promise<SshSession>
}

/** One parsed ProxyJump hop: the `[user@]alias[:port]` token, split. */
interface ProxyJumpHop {
  /** The config alias (drives the jump's own Host-block lookup). */
  alias: string
  /** Optional `user@` override. */
  user?: string
  /** Optional `:port` override. */
  port?: number
}

/** Parse one ProxyJump token (`[user@]alias[:port]`). */
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

/** Wrap one string for safe inclusion in a remote shell command line. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/** Build the `sh -lc <command>` wrapper used for every remote command. */
export function loginShell(command: string): string {
  return `sh -lc ${shQuote(command)}`
}

/** The three operator-distinguishable connection failure classes. */
export type SshConnectFailureKind
  = | 'key-rejected'
    | 'password-rejected'
    | 'unreachable'
    | 'other'

/** Network-level error codes that mean "the host cannot be reached at all". */
const UNREACHABLE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
])

/** Whether one raw transport error reads as "host unreachable". */
function isUnreachable(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code
  if (code !== undefined && UNREACHABLE_CODES.has(code))
    return true
  return /timed?\s?out|connection refused|econnrefused|no route to host|name or service not known|getaddrinfo/iu.test(error.message)
}

/**
 * Classify one connection failure into the three operator-distinguishable
 * classes (key/agent rejected → check keys or store a password; password
 * rejected → update the stored password; unreachable → network/host name).
 * @param error - the raw transport failure.
 * @param passwordOffered - whether the stored password was part of the chain.
 * @returns the failure class.
 */
export function classifyConnectFailure(error: unknown, passwordOffered: boolean): SshConnectFailureKind {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = error instanceof Error ? error : new Error(message)
  if (isUnreachable(normalized))
    return 'unreachable'
  if (/all configured authentication methods failed|authentication failed|no supported authentication/iu.test(message)) {
    return passwordOffered ? 'password-rejected' : 'key-rejected'
  }
  return 'other'
}

/** One operator-facing message for a classified connection failure. */
export function describeConnectFailure(kind: SshConnectFailureKind, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  switch (kind) {
    case 'key-rejected':
      return 'authentication failed: no key or ssh-agent was accepted — check your keys or store a password for this machine'
    case 'password-rejected':
      return 'authentication failed: the stored password was rejected — update the stored password'
    case 'unreachable':
      return `host unreachable: ${message === '' ? 'SSH connection failed' : message}`
    default:
      return message === '' ? 'SSH connection failed' : message
  }
}

/** Transport timing/watchdog options; the manager passes the plugin config through. */
export interface Ssh2TransportOptions {
  /** ssh2 keepalive heartbeat interval in milliseconds (default 10 s). */
  keepaliveIntervalMs?: number
  /** Unanswered-heartbeat threshold that declares the connection dead (default 3). */
  keepaliveCountMax?: number
  /**
   * ssh-agent socket path. `undefined` reads `SSH_AUTH_SOCK` per connect
   * (an empty/unset variable disables the agent step); an explicit empty
   * string disables it too.
   */
  agentSocket?: string
}

/**
 * ssh2-backed transport. One `Client` per session; exec and tunnel run over
 * the shared connection. Credentials come from the injected
 * {@link SshCredentialsResolver}: the host's own `~/.ssh` (config aliases,
 * IdentityFiles, default keys) with the profile's stored password/passphrase
 * as fallbacks — the connection behaves like a local `ssh` invocation. The
 * auth chain order is fixed: ssh-agent → private keys → stored password;
 * without an agent or a stored password the chain degrades to exactly the
 * previous behavior.
 */
export class Ssh2Transport implements SshTransport {
  private readonly options: Required<Pick<Ssh2TransportOptions, 'keepaliveIntervalMs' | 'keepaliveCountMax'>> & Pick<Ssh2TransportOptions, 'agentSocket'>

  /**
   * @param readyTimeoutMs - handshake deadline for {@link Client.connect}.
   * @param resolver - the `~/.ssh` credential resolver (host, port, user, keys).
   * @param options - keepalive watchdog timing and the agent socket override;
   *   omitted fields fall back to the 10 s / 3-beat defaults.
   */
  constructor(
    private readonly readyTimeoutMs: number,
    private readonly resolver: SshCredentialsResolver,
    options?: Ssh2TransportOptions,
  ) {
    this.options = {
      keepaliveIntervalMs: options?.keepaliveIntervalMs ?? 10_000,
      keepaliveCountMax: options?.keepaliveCountMax ?? 3,
      ...options?.agentSocket === undefined ? {} : { agentSocket: options.agentSocket },
    }
  }

  async connect(
    profile: MachineProfile,
    hostKeyVerifier: SshHostKeyVerifier,
    signal?: AbortSignal,
  ): Promise<SshSession> {
    const hops: Ssh2Session[] = []
    try {
      const session = await this.connectTarget(profile, String(profile.id), hostKeyVerifier, signal, hops, new Set())
      // 跳板会话与目标会话同生命周期：目标关闭时逐个收掉跳板（反序无必要，
      // 逐跳 close 会连带掐断穿过它的 direct-tcpip 通道）。
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
  }

  /**
   * Connect one target, walking its resolved ProxyJump chain first. The whole
   * chain resolves locally up front (config files only), then hops connect in
   * order: hop i opens a direct-tcpip channel (`ssh -W` semantics) to the
   * next hop's resolved host:port — the last hop points at the real target —
   * and the next handshake rides that stream as its socket. A jump alias
   * whose own config also sets ProxyJump is rejected (nested chains), as is
   * any cycle. Stored secrets do not cross hops: jump auth uses the agent and
   * the alias's identity files, exactly like `ssh -J`.
   */
  private async connectTarget(
    profile: MachineProfile,
    label: string,
    hostKeyVerifier: SshHostKeyVerifier,
    signal: AbortSignal | undefined,
    hops: Ssh2Session[],
    visited: ReadonlySet<string>,
  ): Promise<Ssh2Session> {
    const auth = await this.resolver.resolve(profile)
    // 缺省视直连（兼容不填 proxyJump 的 resolver 实现）
    const proxyJump = auth.proxyJump ?? []
    if (proxyJump.length === 0)
      return this.connectWithAuth(auth, label, hostKeyVerifier, signal, undefined)

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
        port: hop.port ?? 22,
        remotePort: 3080,
      }
      const jumpAuth = await this.resolver.resolve(jumpProfile)
      if ((jumpAuth.proxyJump ?? []).length > 0)
        throw new Error(`nested ProxyJump on "${hop.alias}" is not supported`)
      chain.push({ alias: hop.alias, auth: jumpAuth })
    }

    let sock: Duplex | undefined
    for (const [index, hop] of chain.entries()) {
      const session = await this.connectWithAuth(hop.auth, hop.alias, hostKeyVerifier, signal, sock)
      hops.push(session)
      const next = index + 1 < chain.length ? chain[index + 1]!.auth : auth
      sock = await session.forwardOutStream(next.host, next.port)
    }
    return this.connectWithAuth(auth, label, hostKeyVerifier, signal, sock)
  }

  /** One ssh2 handshake: direct, or over a jump-forwarded stream when `sock` rides a hop. */
  private connectWithAuth(
    auth: ResolvedSshAuth,
    label: string,
    hostKeyVerifier: SshHostKeyVerifier,
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
      // The auth chain's shared bookkeeping: which method won (reported on
      // the session once ready) and whether the stored password participated
      // (drives the failure classification when everything is rejected).
      let winningMethod: SshAuthMethod | undefined
      let passwordOffered = false
      client.on('ready', () => {
        settle(() => resolve(new Ssh2Session(client, winningMethod)))
      })
      client.on('error', (error) => {
        settle(() => reject(describedConnectFailure(error, passwordOffered)))
      })
      void Promise.resolve().then(() => {
        const agentSocket = this.options.agentSocket === undefined
          ? process.env.SSH_AUTH_SOCK
          : this.options.agentSocket
        const agent = agentSocket === undefined || agentSocket === '' ? undefined : agentSocket
        // Try the ssh-agent first, then every resolved identity in order,
        // then the stored password — the same preference order as OpenSSH
        // (agent, publickey, password). ssh2 parses each key itself and
        // skips invalid ones, so a bad or passphrase-locked key never aborts
        // the attempt. Each credential is offered at most once; the handler
        // then gives up.
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
            // `false` signals "no more methods" at runtime; the published
            // NextAuthHandler type omits it.
            callback(false as never)
          }
        }
        client.connect({
          ...sock === undefined ? {} : { sock: sock as NonNullable<ConnectConfig['sock']> },
          host: auth.host,
          port: auth.port,
          username: auth.username,
          readyTimeout: this.readyTimeoutMs,
          // Keepalive watchdog: with these settings ssh2 declares the
          // connection dead after `countMax` unanswered heartbeats and
          // surfaces it as a close — the manager's reconnect trigger.
          keepaliveInterval: this.options.keepaliveIntervalMs,
          keepaliveCountMax: this.options.keepaliveCountMax,
          authHandler,
          // ssh2 accepts a synchronous boolean return OR the verify-callback
          // form; always driving the callback keeps async verifiers uniform.
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
}

/**
 * Wrap one raw ssh2 handshake failure with its classified, operator-facing
 * message (the three-way auth/unreachable distinction rides the message; the
 * raw error's own text never carries secrets).
 */
function describedConnectFailure(error: Error, passwordOffered: boolean): Error {
  const kind = classifyConnectFailure(error, passwordOffered)
  const message = describeConnectFailure(kind, error)
  if (message === error.message)
    return error
  return new Error(message)
}

/** The ssh2 session face over one authenticated `Client`. */
class Ssh2Session implements SshSession {
  private readonly closed = new Set<() => void>()
  private closedFired = false

  constructor(
    private readonly client: Client,
    readonly authMethod: SshAuthMethod | undefined = undefined,
  ) {
    this.client.on('close', () => {
      if (this.closedFired)
        return
      this.closedFired = true
      for (const callback of this.closed) callback()
      this.closed.clear()
    })
  }

  /**
   * Open one direct-tcpip channel (`ssh -W` semantics) through this session.
   * Internal to the ProxyJump chain: the next hop's handshake rides the
   * returned stream as its socket; closing this session kills the stream.
   */
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

  exec(command: string, options?: SshExecOptions): Promise<SshExecResult> {
    return new Promise<SshExecResult>((resolve, reject) => {
      let settled = false
      const timer = options?.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
          /* v8 ignore next 3 -- race guard: the timer always loses to close/error, which clear it */
            if (settled)
              return
            settled = true
            // Closing the connection kills the remote channel (and its process)
            // and settles any in-flight close events.
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
        // Stdin payloads go out first (half-close semantics: EOF lets the
        // remote `tar -xf -` finish while stdout keeps flowing back).
        if (options?.stdinData !== undefined && options.stdinData.length > 0) {
          stream.write(options.stdinData)
          stream.end()
        }
        stream.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8')
          stdout += text
          options?.onData?.(text)
        })
        // ssh2 exposes stderr as a Readable *property* (`stream.stderr`); it
        // never emits a `'stderr'` event, so a listener for one silently drops
        // every remote error message and failures degrade to a bare exit code.
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

  openTunnel(remotePort: number, preferredLocalPort?: number, injection?: TunnelHeaderInjection): Promise<SshTunnelHandle> {
    return this.listenTunnel(remotePort, preferredLocalPort, true, injection)
  }

  /**
   * Bind the loopback forwarder, preferring `preferredLocalPort` so a
   * reconnect can re-publish the same tunnel URL; a taken port falls back
   * to an ephemeral one (only the first, deliberate preference retries).
   */
  private listenTunnel(remotePort: number, preferredLocalPort: number | undefined, allowFallback: boolean, injection?: TunnelHeaderInjection): Promise<SshTunnelHandle> {
    return new Promise<SshTunnelHandle>((resolve, reject) => {
      const sockets = new Set<import('node:net').Socket>()
      const server: Server = createServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        // 对端中止（浏览器取消加载、curl 超时）会给 socket 发 ECONNRESET：
        // 本进程就是整个 dsh（插件寄宿其中），未处理的 'error' 事件会把
        // 整个宿主进程拉崩——socket 与 channel 双侧都必须吞错销毁。
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
          const cookie = injection?.cookie
          if (cookie === undefined) {
            socket.pipe(channel).pipe(socket)
            return
          }
          pipeChannelWithCookie(socket, channel, cookie)
        })
      })
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (allowFallback && error.code === 'EADDRINUSE' && preferredLocalPort !== undefined) {
          // The preferred port was reclaimed while we were away; an
          // ephemeral port keeps the reconnect alive (the URL change rides
          // the status publication).
          void this.listenTunnel(remotePort, undefined, false, injection).then(resolve, reject)
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
            // A half-open forwarded socket must not park the close forever.
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

/** Request-head cap for the cookie injector; a head never completing within it pipes raw (fail-open). */
const TUNNEL_HEAD_CAP = 64 * 1024

/**
 * Stamp one request head with the minted cookie: any existing `Cookie` line
 * is replaced (the browser has none worth keeping in an iframe context) and
 * `Connection` collapses to `close` — one request per connection means the
 * injector only ever parses the FIRST head. Upgrade (websocket) handshakes
 * keep their `Connection: Upgrade` untouched; after the head the stream
 * pipes raw in both directions.
 */
export function injectCookieHead(head: string, cookie: string): string {
  const lines = head.split('\r\n')
  const isUpgrade = lines.some(line => /^connection:\s*upgrade/iu.test(line))
  const kept = lines.filter(line =>
    !/^cookie:/iu.test(line) && (isUpgrade || !/^connection:/iu.test(line)))
  // The request line stays first; the injected headers follow it.
  kept.splice(1, 0, `Cookie: ${cookie}`)
  if (!isUpgrade)
    kept.splice(2, 0, 'Connection: close')
  return kept.join('\r\n')
}

/** Pipe one tunneled connection, stamping the first request head with the cookie. */
function pipeChannelWithCookie(
  socket: import('node:net').Socket,
  channel: Duplex,
  cookie: string,
): void {
  const buffered: Buffer[] = []
  let bufferedLength = 0
  let injected = false
  const writeToChannel = (data: Buffer): void => {
    if (!channel.write(data))
      socket.pause()
  }
  socket.on('data', (chunk: Buffer) => {
    if (injected) {
      writeToChannel(chunk)
      return
    }
    buffered.push(chunk)
    bufferedLength += chunk.length
    const whole = Buffer.concat(buffered)
    const headEnd = whole.indexOf('\r\n\r\n')
    if (headEnd === -1) {
      if (bufferedLength > TUNNEL_HEAD_CAP) {
        injected = true
        writeToChannel(whole)
      }
      return
    }
    injected = true
    const head = whole.subarray(0, headEnd).toString('latin1')
    const rest = whole.subarray(headEnd)
    writeToChannel(Buffer.concat([Buffer.from(injectCookieHead(head, cookie), 'latin1'), rest]))
  })
  socket.on('end', () => channel.end())
  channel.on('drain', () => socket.resume())
  channel.on('end', () => socket.end())
  channel.pipe(socket)
}

/**
 * Mint the tunnel's session cookie: GET the authenticated URL once WITHOUT
 * following the 303 and read the `name=value` pair back from `set-cookie`.
 * Resolves `undefined` on any failure (no token endpoint, timeout, transport
 * error) — the tunnel then stays a plain pipe and the `?token=` URL remains
 * the top-level fallback. The 3 s cap keeps a black-hole remote from
 * stalling the connect; the request itself needs no cookie (the query token
 * is the credential).
 */
export function mintTunnelCookie(authenticatedUrl: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const request = httpGet(authenticatedUrl, (response) => {
      response.resume()
      const raw = response.headers['set-cookie']?.[0]
      const pair = raw === undefined ? undefined : raw.split(';')[0]?.trim()
      resolve(pair === undefined || pair === '' ? undefined : pair)
    })
    request.on('error', () => resolve(undefined))
    request.setTimeout(3_000, () => {
      request.destroy()
      resolve(undefined)
    })
  })
}

/** Mirror fetch's abort rejection: the signal's reason when present, else a DOMException-style AbortError. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error)
    return reason
  if (typeof reason === 'string')
    return new Error(reason)
  return new Error('This operation was aborted')
}
