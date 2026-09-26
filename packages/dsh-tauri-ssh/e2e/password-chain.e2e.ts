/**
 * E2E #3 — password authentication over a real SSH protocol round trip.
 *
 * Environment note: no OS sshd with password login is reachable from this
 * host (local port 22 closed, no docker, and the shared root dev machine's
 * sshd config must not be touched). The stand-in is a loopback ssh2 protocol
 * server that rejects every publickey attempt and accepts exactly one
 * password — the full agent→key→password chain, the order evidence
 * (server-recorded method sequence), and the three failure classes are all
 * exercised over the wire by the real transport.
 *
 * Downgrade label: OS-sshd password E2E 未验证（环境不可得）；本文件为本地
 * ssh2 协议服务器替代证据。
 * @module dsh-tauri-ssh/e2e/password-chain
 */

import type { Connection, Server as SshServer } from 'ssh2'
import type { MachineProfile } from '../src/host/types/index'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { Server } from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootHarness, id } from './helpers'

const PASSWORD = 'e2e-trustno1'

/** One server-side authentication attempt record. */
interface AuthAttempt {
  method: string
  accepted: boolean
}

/** The recorded auth attempts and the accepted method, per connection. */
const attempts: AuthAttempt[] = []
let server: SshServer
let serverPort = 0
let scratchSshDir: string

/** One freshly generated RSA key in PKCS#1 PEM form (what ssh2 parses natively). */
function freshPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return String(privateKey.export({ format: 'pem', type: 'pkcs1' }))
}

beforeAll(async () => {
  // A fresh host key pair for the server and one for the client's (rejected)
  // identity file.
  const hostKey = freshPem()
  const clientKey = freshPem()
  scratchSshDir = mkdtempSync(join(tmpdir(), 'dsh-ssh-e2e-sshdir-'))
  writeFileSync(join(scratchSshDir, 'id_rsa'), clientKey)

  server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === PASSWORD) {
        attempts.push({ method: ctx.method, accepted: true })
        ctx.accept()
        return
      }
      attempts.push({ method: ctx.method, accepted: false })
      ctx.reject(['publickey', 'password'])
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
      // Client-side hangups during failure cases surface here; expected.
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  serverPort = (server.address() as { port: number }).port
})

afterAll(() => {
  server.close()
  rmSync(scratchSshDir, { recursive: true, force: true })
})

function profileWith(password?: string): MachineProfile {
  return {
    id: id('password-e2e'),
    name: 'password-e2e',
    host: '127.0.0.1',
    port: serverPort,
    user: 'root',
    ...password === undefined ? {} : { password },
    remotePort: 3080,
  }
}

describe('e2e password chain (loopback ssh2 protocol server)', () => {
  it('authenticates with the stored password after agent and keys are refused', async () => {
    attempts.length = 0
    const harness = bootHarness({ sshDir: scratchSshDir, connectTimeoutMs: 5_000 })
    try {
      const profile = profileWith(PASSWORD)
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const result = await harness.manager.test(profile.id)
      expect(result).toEqual({ ok: true, banner: 'Linux x86_64' })

      // Order evidence: every publickey attempt (agent-sourced and the
      // identity file) precedes the accepted password attempt.
      const methods = attempts.map(attempt => attempt.method)
      harness.log(`server saw auth methods: ${methods.join(' -> ')}`)
      expect(methods[methods.length - 1]).toBe('password')
      expect(attempts.at(-1)?.accepted).toBe(true)
      const passwordIndex = methods.indexOf('password')
      expect(methods.slice(0, passwordIndex).every(method => method === 'publickey')).toBe(true)
      expect(passwordIndex).toBeGreaterThan(0)
    }
    finally {
      await harness.dispose()
    }
  })

  it('classifies a wrong stored password as password-rejected', async () => {
    attempts.length = 0
    const harness = bootHarness({ sshDir: scratchSshDir, connectTimeoutMs: 5_000 })
    try {
      const profile = profileWith('wrong-password')
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const result = await harness.manager.test(profile.id)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.message).toMatch(/stored password was rejected/u)
    }
    finally {
      await harness.dispose()
    }
  })

  it('classifies exhausted keys without a password as key-rejected', async () => {
    attempts.length = 0
    const harness = bootHarness({ sshDir: scratchSshDir, connectTimeoutMs: 5_000 })
    try {
      const profile = profileWith()
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const result = await harness.manager.test(profile.id)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.message).toMatch(/no key or ssh-agent was accepted/u)
    }
    finally {
      await harness.dispose()
    }
  })
})
