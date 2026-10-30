import type { RemoteAuthPolicy, RemoteTunnelProgress } from '../types/index'

export interface TunnelHandlers {
  onLine: (line: string) => void
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
}

export interface TunnelProcess {
  readonly pid: number | undefined
  readonly exited: Promise<void>
  kill: (signal: NodeJS.Signals) => void
}

export type TunnelProgressSink = (progress: RemoteTunnelProgress) => void

export interface TunnelDeps {
  policy: () => RemoteAuthPolicy
  resolveBinary: (onProgress?: TunnelProgressSink) => Promise<string>
  spawn: (binary: string, args: string[], handlers: TunnelHandlers, env?: NodeJS.ProcessEnv) => TunnelProcess
}
