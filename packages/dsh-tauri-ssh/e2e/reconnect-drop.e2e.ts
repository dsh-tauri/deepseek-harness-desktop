/**
 * E2E #1 — drop-driven auto-reconnect on a real linux x64 machine.
 *
 * Flow: connect to `ssh dev` (a python3 HTTP server stands in for the remote
 * `dsh web` instance — the dev host has no Node/dsh and the clone-path
 * install cannot run there; the connection/tunnel/poll surface under test is
 * identical), verify the tunnel serves HTTP, kill exactly the sshd session
 * process serving OUR connection (identified as the one new session worker
 * that appeared while connecting; never the listener, never a global
 * restart), and watch the manager walk connected → reconnecting → connected
 * with the SAME tunnel URL serving HTTP again.
 * @module dsh-tauri-ssh/e2e/reconnect-drop
 */

import type { MachineProfile } from '../src/host/types/index'
import { execSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { bootHarness, id, waitFor } from './helpers'

const REMOTE_PORT = 3100

const profile: MachineProfile = {
  id: id('dev-drop'),
  name: 'dev-drop',
  host: 'dev',
  port: 22,
  user: '',
  // The remote instance stand-in: any loopback HTTP listener exercises the
  // same probe → start → healthy → tunnel path.
  startCommand: `python3 -m http.server ${REMOTE_PORT} --bind 127.0.0.1`,
  remotePort: REMOTE_PORT,
}

/**
 * The dev host's container hides /proc/net from `ss`, so peer-port matching
 * is unavailable. Instead: snapshot the sshd session workers (the
 * `sshd-session: …@notty` processes, excluding the probe's own session via
 * `$PPID` and the privileged parents), and diff around our connect.
 */
function sshdSessionWorkers(): Set<number> {
  const out = execSync(
    `ssh dev 'echo OWN=$PPID; ps -eo pid=,cmd= | grep "[s]shd-session"'`,
    { encoding: 'utf8' },
  )
  const own = Number(out.match(/OWN=(\d+)/u)?.[1] ?? NaN)
  const workers = new Set<number>()
  for (const line of out.split('\n')) {
    const pid = Number(line.trim().match(/^(\d+)\s/u)?.[1] ?? NaN)
    if (!Number.isFinite(pid) || pid === own)
      continue
    if (line.includes('[priv]'))
      continue
    if (line.includes('@'))
      workers.add(pid)
  }
  return workers
}

describe('e2e reconnect (linux x64 dev machine)', () => {
  it('recovers a server-side session kill with the same tunnel URL', async () => {
    const harness = bootHarness({ keepaliveIntervalMs: 3_000, reconnectInitialDelayMs: 1_000, reconnectMaxDelayMs: 5_000, reconnectMaxAttempts: 6 })
    const { manager, log } = harness
    try {
      manager.refreshProfiles(new Map([[profile.id, profile]]))

      // 1. Connect and verify the tunnel serves HTTP (the "polling" probe).
      const beforeSessions = sshdSessionWorkers()
      const link = await manager.connect(profile.id)
      expect(manager.status(profile.id).state).toBe('connected')
      const afterSessions = sshdSessionWorkers()
      const fresh = [...afterSessions].filter(pid => !beforeSessions.has(pid))
      const before = await fetch(link.tunnelBaseUrl)
      expect(before.status).toBe(200)
      log(`tunnel serves HTTP ${before.status} at ${link.tunnelBaseUrl}`)
      // A second URL through the same tunnel proves a real HTTP round trip.
      const deep = await fetch(`${link.tunnelBaseUrl}/definitely-missing`)
      expect(deep.status).toBe(404)

      // 2. Our session worker is exactly the one that appeared during the
      //    connect; verify what we are about to kill before killing it.
      expect(fresh.length).toBe(1)
      const pid = fresh[0]!
      const cmdOfPid = execSync(`ssh dev "ps -p ${pid} -o cmd="`, { encoding: 'utf8' }).trim()
      expect(cmdOfPid, `refusing to kill non-sshd process: ${cmdOfPid}`).toMatch(/sshd-session/iu)
      log(`identified session sshd pid=${pid} (${cmdOfPid}) as the connect-window diff`)

      // 3. Kill exactly that process (targeted single PID, no restarts).
      execSync(`ssh dev "kill ${pid}"`)
      log(`killed session sshd pid=${pid}`)

      // 4. The manager must walk reconnecting → connected on its own.
      await waitFor(() => manager.status(profile.id).state === 'reconnecting', 'reconnecting state')
      log('observed reconnecting state')
      await waitFor(() => manager.status(profile.id).state === 'connected', 'auto-reconnect', 60_000)
      const status = manager.status(profile.id)
      expect(status.state).toBe('connected')
      expect(['agent', 'key']).toContain(status.authMethod)
      log(`auto-reconnected (auth=${status.authMethod})`)

      // 5. Same URL, serving again: tunnel rebuilt on the preferred port.
      expect(manager.link(profile.id)?.tunnelBaseUrl).toBe(link.tunnelBaseUrl)
      const after = await fetch(link.tunnelBaseUrl)
      expect(after.status).toBe(200)
      log(`tunnel serves HTTP ${after.status} again at the SAME ${link.tunnelBaseUrl}`)

      // 6. Clean teardown; a manual disconnect is `disconnected`, not given-up.
      await manager.disconnect(profile.id)
      expect(manager.status(profile.id).state).toBe('disconnected')

      // 7. Leave the dev machine as we found it: stop the stand-in listener
      //    (verify it is our python3 http.server before killing the PID).
      const listenerLine = execSync(
        `ssh dev "ss -tlnp '( sport = :${REMOTE_PORT} )' | grep ':${REMOTE_PORT} '"`,
        { encoding: 'utf8' },
      ).trim()
      const listenerPid = listenerLine.match(/pid=(\d+)/u)?.[1]
      if (listenerPid !== undefined) {
        const listenerCmd = execSync(`ssh dev "ps -p ${listenerPid} -o cmd="`, { encoding: 'utf8' }).trim()
        if (/http\.server/iu.test(listenerCmd)) {
          execSync(`ssh dev "kill ${listenerPid}"`)
          log(`stopped stand-in listener pid=${listenerPid} on remote port ${REMOTE_PORT}`)
        }
        else {
          log(`left remote listener pid=${listenerPid} alone (not our http.server: ${listenerCmd})`)
        }
      }
    }
    finally {
      await harness.dispose()
    }
  }, 240_000)
})
