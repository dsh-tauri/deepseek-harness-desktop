/**
 * E2E #4 — the keepalive watchdog on a hung (silent) connection. A local
 * proxy stops forwarding bytes in both directions (no FIN, no RST — exactly
 * what a NAT/firewall drop looks like); ssh2's keepalive misses its
 * heartbeat budget and must declare the session closed, surfacing through
 * the session's onClosed callback (the manager's reconnect trigger).
 * @module dsh-tauri-ssh/e2e/watchdog
 */

import type { Connection, Server as SshServer } from 'ssh2'
import type { MachineProfile } from '../src/host/types/index'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, connect as tcpConnect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'pathe'
import { Server } from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SshConfigResolver } from '../src/host/service/ssh-config'
import { Ssh2Transport } from '../src/host/service/transport'
import { MachineId } from '../src/host/types/index'
import { freshRsaPem } from './helpers'

const PASSWORD = 'e2e-watchdog'
const KEEPALIVE_INTERVAL_MS = 1_000
const KEEPALIVE_COUNT_MAX = 3

let server: SshServer
let serverPort = 0
let scratchSshDir: string

/** The stalling proxy: pipes traffic until `freeze()` silently drops it. */
function startStallingProxy(): Promise<{ port: number, freeze: () => void, close: () => void }> {
  const sockets = new Set<{ a: import('node:net').Socket, b: import('node:net').Socket }>()
  const proxy = createServer((downstream) => {
    const upstream = tcpConnect(serverPort, '127.0.0.1')
    const pair = { a: downstream, b: upstream }
    sockets.add(pair)
    downstream.on('close', () => sockets.delete(pair))
    upstream.on('close', () => sockets.delete(pair))
    downstream.pipe(upstream)
    upstream.pipe(downstream)
    downstream.on('error', () => downstream.destroy())
    upstream.on('error', () => upstream.destroy())
  })
  return new Promise((resolve) => {
    proxy.listen(0, '127.0.0.1', () => {
      resolve({
        port: (proxy.address() as { port: number }).port,
        freeze: (): void => {
          // Stop forwarding in both directions without closing anything: the
          // client sees a silent, still-open TCP connection.
          for (const { a, b } of sockets) {
            a.unpipe(b)
            b.unpipe(a)
            a.pause()
            b.pause()
          }
        },
        close: (): void => {
          for (const { a, b } of sockets) {
            a.destroy()
            b.destroy()
          }
          proxy.close()
        },
      })
    })
  })
}

beforeAll(async () => {
  server = new Server({ hostKeys: [freshRsaPem()] }, (client: Connection) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === PASSWORD)
        ctx.accept()
      else
        ctx.reject(['password'])
    })
    client.on('session', (accept) => {
      const session = accept()
      session.on('exec', (acceptExec) => {
        const stream = acceptExec()
        stream.write('Linux x86_64\n')
        stream.exit(0)
        stream.end()
      })
    })
    client.on('error', () => {
      // Watchdog teardowns land here on the server side; expected.
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  serverPort = (server.address() as { port: number }).port
  scratchSshDir = mkdtempSync(join(tmpdir(), 'dsh-ssh-e2e-watchdog-'))
  writeFileSync(join(scratchSshDir, 'config'), '')
})

afterAll(() => {
  server.close()
  rmSync(scratchSshDir, { recursive: true, force: true })
})

describe('e2e keepalive watchdog (silent connection freeze)', () => {
  it('declares a hung session closed after the heartbeat budget', async () => {
    const proxy = await startStallingProxy()
    const transport = new Ssh2Transport(
      5_000,
      new SshConfigResolver(scratchSshDir, homedir()),
      { keepaliveIntervalMs: KEEPALIVE_INTERVAL_MS, keepaliveCountMax: KEEPALIVE_COUNT_MAX },
    )
    const profile: MachineProfile = {
      id: MachineId('watchdog'),
      name: 'watchdog',
      host: '127.0.0.1',
      port: proxy.port,
      user: 'root',
      password: PASSWORD,
      remotePort: 3080,
    }
    try {
      const session = await transport.connect(profile, () => true)
      expect(session.authMethod).toBe('password')

      const closedAt = new Promise<number>((resolve) => {
        session.onClosed(() => resolve(Date.now()))
      })
      const frozeAt = Date.now()
      proxy.freeze()

      // ssh2 must give up after ~interval*(countMax) of unanswered
      // heartbeats and surface the close — not hang forever on the silent
      // socket. Assert a generous upper bound so the test stays robust.
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('watchdog never declared the session closed')), 30_000)
      })
      const closed = await Promise.race([closedAt, timeout])
      const elapsed = closed - frozeAt
      // eslint-disable-next-line no-console -- evidence log
      console.log(`[watchdog] silent freeze → close after ${elapsed} ms (interval ${KEEPALIVE_INTERVAL_MS} ms × ${KEEPALIVE_COUNT_MAX} missed)`)
      expect(elapsed).toBeGreaterThan(KEEPALIVE_INTERVAL_MS * KEEPALIVE_COUNT_MAX - 500)
      expect(elapsed).toBeLessThan(20_000)
    }
    finally {
      proxy.close()
    }
  }, 60_000)
})
