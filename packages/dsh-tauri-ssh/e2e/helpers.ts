/**
 * Shared scaffolding for the E2E suite: a real SshManager over the real
 * ssh2 transport and the host's own `~/.ssh`, with timestamped evidence
 * logging of every status/event emission.
 * @module dsh-tauri-ssh/e2e/helpers
 */

import type { SshMachineStage, SshMachineTerminal } from '../src/host/types/index'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'pathe'
import { SshMachineEvents } from '../src/host/service/events'
import { KnownHostsStore } from '../src/host/service/host-keys'
import { SshManager } from '../src/host/service/manager'
import { SshConfigResolver } from '../src/host/service/ssh-config'
import { Ssh2Transport } from '../src/host/service/transport'
import { MachineId } from '../src/host/types/index'

/**
 * The machine event channel with evidence logging: every appended line is
 * echoed into the harness log (`event <stage>[/<terminal>]: <line>`) before
 * it lands in the ring buffer, so spec files can grep the emitted stream.
 */
class LoggingMachineEvents extends SshMachineEvents {
  constructor(private readonly log: (text: string) => void) {
    super()
  }

  override append(machineId: MachineId, stage: SshMachineStage, line: string, options: { terminal?: SshMachineTerminal, reason?: string } = {}) {
    this.log(`event ${stage}${options.terminal === undefined ? '' : `/${options.terminal}`}: ${line}`)
    return super.append(machineId, stage, line, options)
  }
}

/** One timestamped evidence line. */
export interface EvidenceLine {
  at: number
  text: string
}

/** The E2E harness: manager plus captured evidence. */
export interface Harness {
  manager: SshManager
  evidence: EvidenceLine[]
  log: (text: string) => void
  dispose: () => Promise<void>
}

/** A monotonic-ish wall clock in epoch ms. */
export function now(): number {
  return Date.now()
}

/** One freshly generated RSA key in PKCS#1 PEM form (what ssh2 parses natively). */
export function freshRsaPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return String(privateKey.export({ format: 'pem', type: 'pkcs1' }))
}

/**
 * Boot one real-transport manager with scratch TOFU storage and the given
 * connect/reconnect timing, logging every status and event emission with a
 * timestamp.
 */
export function bootHarness(options: {
  connectTimeoutMs?: number
  keepaliveIntervalMs?: number
  keepaliveCountMax?: number
  reconnectInitialDelayMs?: number
  reconnectMaxDelayMs?: number
  reconnectMaxAttempts?: number
  healthPollIntervalMs?: number
  healthPollAttempts?: number
  sshDir?: string
} = {}): Harness {
  const evidence: EvidenceLine[] = []
  const t0 = now()
  const log = (text: string): void => {
    const line = { at: now(), text }
    evidence.push(line)
    // eslint-disable-next-line no-console -- the E2E evidence log is the point
    console.log(`[+${(line.at - t0).toString().padStart(6)}ms] ${text}`)
  }
  const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-e2e-'))
  const manager = new SshManager({
    transport: new Ssh2Transport(
      options.connectTimeoutMs ?? 15_000,
      // The host's real ~/.ssh: config aliases and identity files, exactly
      // what the plugin in the desktop app would resolve against.
      new SshConfigResolver(options.sshDir ?? join(homedir(), '.ssh'), homedir()),
      {
        keepaliveIntervalMs: options.keepaliveIntervalMs ?? 3_000,
        keepaliveCountMax: options.keepaliveCountMax ?? 3,
      },
    ),
    knownHosts: new KnownHostsStore(join(root, 'known-hosts.json')),
    config: {
      connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
      healthCheckTimeoutMs: 3_000,
      healthPollIntervalMs: options.healthPollIntervalMs ?? 500,
      healthPollAttempts: options.healthPollAttempts ?? 30,
      keepaliveIntervalMs: options.keepaliveIntervalMs ?? 3_000,
      keepaliveCountMax: options.keepaliveCountMax ?? 3,
      reconnectInitialDelayMs: options.reconnectInitialDelayMs ?? 1_000,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs ?? 5_000,
      reconnectMaxAttempts: options.reconnectMaxAttempts ?? 6,
    },
    events: new LoggingMachineEvents(log),
    emitStatus: (id, status) => {
      const hints = [
        status.state,
        ...status.tunnelBaseUrl === undefined ? [] : [`tunnel=${status.tunnelBaseUrl}`],
        ...status.nextRetryAt === undefined ? [] : [`nextRetryAt=+${status.nextRetryAt - now()}ms`],
        ...status.authMethod === undefined ? [] : [`auth=${status.authMethod}`],
        ...status.lastError === undefined ? [] : [`lastError=${status.lastError}`],
      ]
      log(`status ${String(id)}: ${hints.join(' ')}`)
    },
  })
  return {
    manager,
    evidence,
    log,
    dispose: async () => {
      await manager.dispose()
    },
  }
}

/** Wait until the predicate holds or the deadline passes (step-probe wait). */
export async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = now() + timeoutMs
  while (!predicate()) {
    if (now() > deadline)
      throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** Brand a machine id. */
export function id(name: string): ReturnType<typeof MachineId> {
  return MachineId(name)
}
