import type { RemoteAuthPolicy } from '../types/index'

export interface TunnelHandlers {
  onLine: (line: string) => void
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
}

export interface TunnelProcess {
  readonly pid: number | undefined
  readonly exited: Promise<void>
  kill: (signal: NodeJS.Signals) => void
}

export interface TunnelDeps {
  policy: () => RemoteAuthPolicy
  resolveBinary: () => Promise<string>
  spawn: (binary: string, args: string[], handlers: TunnelHandlers) => TunnelProcess
}
