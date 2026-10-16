import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectionGate } from './harness'

export * from './harness'

export interface ConnectionHost {
  connection: Partial<ConnectionGate> & {
    admit?: (request: IncomingMessage) => { peer: unknown } | { rejection: 401 | 403 }
    browserPeer?: { readonly signal: AbortSignal }
    readonly disposed?: boolean
    authorizeIndex?: (request: IncomingMessage, response: ServerResponse) => boolean
  }
  logger?: {
    warn?: (message: string, error?: unknown) => void
  }
}
