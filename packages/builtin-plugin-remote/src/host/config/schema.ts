import z from 'schemastery'
import { DEFAULT_REMOTE_PORT } from '../../shared/constants'

export interface Config {
  connectTimeoutMs: number
  healthCheckTimeoutMs: number
  healthPollIntervalMs: number
  healthPollAttempts: number
  knownHostsPath?: string
  statePath?: string
  sshDir?: string
  remotePort?: number
  startCommand?: string
  installRepo?: string
  installRef?: string
  installTimeoutMs?: number
  keepaliveIntervalMs: number
  keepaliveCountMax: number
  reconnectInitialDelayMs: number
  reconnectMaxDelayMs: number
  reconnectMaxAttempts: number
}

export const ConfigSchema: z<Config> = z.object({
  connectTimeoutMs: z.number().default(15_000),
  healthCheckTimeoutMs: z.number().default(3_000),
  healthPollIntervalMs: z.number().default(1_000),
  healthPollAttempts: z.number().default(30),
  knownHostsPath: z.string(),
  statePath: z.string(),
  sshDir: z.string(),
  remotePort: z.number().default(DEFAULT_REMOTE_PORT),
  startCommand: z.string(),
  installRepo: z.string(),
  installRef: z.string(),
  installTimeoutMs: z.number().default(1_800_000),
  keepaliveIntervalMs: z.number().default(10_000),
  keepaliveCountMax: z.number().default(3),
  reconnectInitialDelayMs: z.number().default(1_000),
  reconnectMaxDelayMs: z.number().default(20_000),
  reconnectMaxAttempts: z.number().default(6),
}) as z<Config>
