/**
 * Real-machine E2E (linux x64): a fresh remote bootstrap through the REAL
 * transport, planner (live GitHub metadata), install script, launch, and
 * boot-HTML readiness, then a reconnect that skips the install. Gated behind
 * `DSH_SSH_E2E_HOST` so the ordinary test run never needs a remote:
 *
 *   DSH_SSH_E2E_HOST=dev pnpm --filter dsh-tauri-ssh exec vitest run \
 *     src/host/service/bootstrap.e2e.test.ts
 *
 * Shares the machine with parallel nodes: default layout (`~/.dsh-desktop`)
 * and the default port, leftover processes cleaned before and after, and the
 * installed tree deliberately left in place (the shared "already
 * initialized" state other nodes may reuse).
 * @module dsh-tauri-ssh/host/service/bootstrap.e2e
 */

/* eslint-disable no-console -- the run's console output IS the recorded evidence */
import type { MachineProfile, SshLink } from '../types/index'
import type { SshTransport } from './transport'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MachineId } from '../types/index'
import { SshMachineEvents } from './events'
import { KnownHostsStore } from './host-keys'
import { SshManager } from './manager'
import { SshConfigResolver } from './ssh-config'
import { Ssh2Transport } from './transport'

/** The shared dev machine alias from `~/.ssh/config` (key auth). */
const HOST = process.env.DSH_SSH_E2E_HOST

/**
 * The remote instance port. Defaults to 3080; the shared dev machine's 3080
 * is held by caddy (shared infra, never touched), so runs there pass an
 * explicit free port (e.g. `DSH_SSH_E2E_PORT=3082`).
 */
const PORT = Number.parseInt(process.env.DSH_SSH_E2E_PORT ?? '3080', 10)

/** Generous budgets: real downloads (~90 MB) over SSH plus instance start. */
const E2E_CONFIG = {
  connectTimeoutMs: 30_000,
  healthCheckTimeoutMs: 5_000,
  healthPollIntervalMs: 1_000,
  healthPollAttempts: 90,
  installTimeoutMs: 1_800_000,
  keepaliveIntervalMs: 10_000,
  keepaliveCountMax: 3,
  reconnectInitialDelayMs: 1_000,
  reconnectMaxDelayMs: 5_000,
  reconnectMaxAttempts: 6,
}

/** Kill only processes whose command line references the shared layout. */
const CLEANUP_COMMAND = [
  `if [ -f "$HOME/.dsh/.dsh-remote.pid" ]; then kill "$(cat "$HOME/.dsh/.dsh-remote.pid")" 2>/dev/null || true; rm -f "$HOME/.dsh/.dsh-remote.pid"; fi`,
  // No `IFS= read` here: an empty IFS disables word splitting, the whole
  // pgrep line lands in the pid variable, and the kill silently no-ops
  // (verified live — the leftover instance survived the old loop). pgrep
  // without -a prints bare pids; this shell's own pid is skipped so the
  // cleanup does not kill itself mid-script.
  `for _pid in $(pgrep -f '\\.dsh-desktop'); do [ "$_pid" = "$$" ] && continue; kill "$_pid" 2>/dev/null || true; done`,
  `sleep 1`,
  // Escalation pass: anything still alive after SIGTERM gets SIGKILL.
  `for _pid in $(pgrep -f '\\.dsh-desktop'); do [ "$_pid" = "$$" ] && continue; kill -9 "$_pid" 2>/dev/null || true; done`,
  `sleep 1`,
  `pgrep -af '\\.dsh-desktop' | grep -v "^$$ " || true`,
].join('\n')

const profile: MachineProfile = HOST === undefined
  ? {} as MachineProfile
  : {
      id: MachineId('e2e-dev'),
      name: 'dev-e2e',
      host: HOST,
      port: 22,
      user: '',
      remotePort: PORT,
      // The dev machine's home-level user patch pins the webserver row to
      // 3081 (held by its production instance behind caddy), which by design
      // overrides the CLI --port flag. The launch therefore goes through the
      // profile's startCommand override — the product's operator escape
      // hatch for exactly this — with a `--patch` overlay (applied after the
      // user layer, so it wins) restating the webserver row on our port.
      startCommand: `"$HOME/.dsh-desktop/runtime/bin/node" "$HOME/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile web --patch "$HOME/.dsh-e2e-port.yml" --host 127.0.0.1 --port ${PORT} --no-open`,
    }

/** The `--patch` overlay restating the webserver row on the E2E port. */
const PORT_PATCH_COMMAND = `cat > "$HOME/.dsh-e2e-port.yml" <<'EOF'
- id: webserver
  config:
    host: '127.0.0.1'
    port: ${PORT}
EOF
`

describe.skipIf(HOST === undefined)('bootstrap E2E (real linux x64 remote)', () => {
  const roots: string[] = []
  let manager!: SshManager
  let events!: SshMachineEvents
  let transport!: SshTransport

  beforeAll(() => {
    const known = mkdtempSync(join(tmpdir(), 'dsh-ssh-e2e-'))
    roots.push(known)
    events = new SshMachineEvents()
    transport = new Ssh2Transport(E2E_CONFIG.connectTimeoutMs, new SshConfigResolver(join(process.env.HOME ?? '', '.ssh'), process.env.HOME ?? ''))
    manager = new SshManager({
      transport,
      knownHosts: new KnownHostsStore(join(known, 'known-hosts.json')),
      config: E2E_CONFIG,
      events,
      emitStatus: () => {},
    })
    manager.refreshProfiles(new Map([[profile.id, profile]]))
  })

  afterAll(async () => {
    await manager.disconnect(profile.id).catch(() => undefined)
    await manager.dispose().catch(() => undefined)
    // Leave the installed tree for sibling nodes; stop only our processes.
    const session = await transport.connect(profile, () => true).catch(() => undefined)
    if (session !== undefined) {
      const leftovers = await session.exec(`${CLEANUP_COMMAND}\nrm -f "$HOME/.dsh-e2e-port.yml"`).catch(() => undefined)
      const remaining = (leftovers?.stdout ?? '(probe failed)').trim()
      console.log('[e2e] remote cleanup done; remaining layout processes:', JSON.stringify(remaining))
      // The cleanup must actually leave nothing behind — a leftover instance
      // would hold the port and fake the next run's readiness.
      expect(remaining).toBe('')
      await session.close().catch(() => undefined)
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('bootstraps a fresh machine end to end (probe → download → verify → install → launch → ready)', async () => {
    // Fresh start: stop leftover shared-layout processes, wipe the tree, and
    // stage the port overlay the launch's --patch consumes.
    const cleaner = await transport.connect(profile, () => true)
    const wiped = await cleaner.exec(`${CLEANUP_COMMAND}\nrm -rf "$HOME/.dsh-desktop"\n${PORT_PATCH_COMMAND}\n[ -f "$HOME/.dsh-e2e-port.yml" ] && [ ! -e "$HOME/.dsh-desktop" ] && echo wiped`)
    await cleaner.close()
    expect(wiped.stdout).toContain('wiped')

    const startedAt = Date.now()
    let link: SshLink
    try {
      link = await manager.connect(profile.id)
    }
    catch (error) {
      // Surface everything the event channel captured before failing.
      console.log('[e2e] bootstrap FAILED; events:', JSON.stringify(events.since(profile.id), null, 2))
      throw error
    }
    const seconds = (Date.now() - startedAt) / 1000
    const page = events.since(profile.id)
    console.log(`[e2e] bootstrap to ready in ${seconds.toFixed(1)}s over ${page.events.length} events`)
    for (const event of page.events)
      console.log(`[e2e]   #${event.seq} ${event.stage}${event.terminal === undefined ? '' : `(${event.terminal})`}: ${event.line.slice(0, 160)}`)

    expect(link.tunnelBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const stages = page.events.map(event => event.stage)
    expect(stages).toContain('download')
    expect(stages).toContain('verify')
    expect(stages).toContain('install')
    expect(stages).toContain('launch')
    const ready = page.events.find(event => event.stage === 'ready')
    expect(ready?.terminal).toBe('success')
    // A fresh instance serves its auth fence on `/` (401, no boot page), so
    // readiness is judged by the legacy fallback — the designed behavior;
    // instances that serve the SPA manifest take the boot-HTML path instead.
    console.log(`[e2e] readiness judged by: ${ready?.line}`)
    expect(manager.status(profile.id).state).toBe('connected')
  }, 30 * 60_000)

  it('installs the shared default layout with working binaries', async () => {
    const session = await transport.connect(profile, () => true)
    const probe = await session.exec(
      `"$HOME/.dsh-desktop/runtime/bin/node" --version && ls "$HOME/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" >/dev/null && echo entry-ok && ls "$HOME/.dsh-desktop/dependencies/pnpm/bin/pnpm.cjs" >/dev/null && echo pnpm-ok`,
    )
    await session.close()
    console.log('[e2e] layout probe:', JSON.stringify(probe.stdout.trim()), 'stderr:', JSON.stringify(probe.stderr.trim()))
    expect(probe.code).toBe(0)
    expect(probe.stdout).toMatch(/^v\d+\.\d+\.\d+/)
    expect(probe.stdout).toContain('entry-ok')
    expect(probe.stdout).toContain('pnpm-ok')
  })

  it('reconnects without reinstalling and returns to ready', async () => {
    await manager.disconnect(profile.id)
    const page0 = events.since(profile.id)
    const link = await manager.connect(profile.id)
    expect(link.tunnelBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const page1 = events.since(profile.id)
    const fresh = page1.events.filter(event => event.seq > (page0.events.at(-1)?.seq ?? 0))
    for (const event of fresh)
      console.log(`[e2e]   #${event.seq} ${event.stage}${event.terminal === undefined ? '' : `(${event.terminal})`}: ${event.line.slice(0, 160)}`)
    const stages = fresh.map(event => event.stage)
    // Already-initialized remote: no download/verify/install stages, and no
    // launch either when the detached instance survived the disconnect (the
    // still-running path judges readiness immediately).
    expect(stages).not.toContain('download')
    expect(stages).not.toContain('verify')
    expect(stages).not.toContain('install')
    const ready = fresh.find(event => event.stage === 'ready')
    expect(ready?.terminal).toBe('success')
  }, 10 * 60_000)
})
