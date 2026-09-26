/* eslint-disable no-console -- the run's console output IS the recorded evidence */
/**
 * arm64 substitute evidence (spec S2 acceptance 6): no arm64 machine exists,
 * so the dry run resolves the REAL linux/arm64 install plan against the live
 * npm registry and proves every download URL answers — without writing any
 * bytes to disk. Gated behind `DSH_SSH_ARM64_DRYRUN=1`:
 *
 *   DSH_SSH_ARM64_DRYRUN=1 pnpm --filter dsh-tauri-ssh exec vitest run \
 *     src/host/service/bootstrap.arm64-dryrun.test.ts
 * @module dsh-tauri-ssh/host/service/bootstrap.arm64-dryrun
 */

import { describe, expect, it } from 'vitest'
import { buildInstallScript, planRemoteInstall } from './bootstrap'

const RUN = process.env.DSH_SSH_ARM64_DRYRUN === '1'

describe.skipIf(!RUN)('arm64 install dry run (real metadata, no disk writes)', () => {
  it('resolves the live arm64 plan and verifies every URL answers a HEAD', async () => {
    const plan = await planRemoteInstall('Linux 6.8.0-45-generic aarch64', {})
    console.log('[arm64-dryrun] plan:', JSON.stringify({
      os: plan.os,
      arch: plan.arch,
      dshKind: plan.dsh.kind,
      dshVersion: plan.dshVersion,
      notes: plan.notes,
    }, null, 2))
    const urls = [
      ...plan.node.urls,
      ...plan.node.shasumUrls,
      ...plan.dsh.urls,
      ...plan.pnpm.urls,
    ]
    for (const url of urls) {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30_000) })
      console.log(`[arm64-dryrun] HEAD ${response.status} ${url}`)
      expect(response.status, url).toBeLessThan(400)
    }
    // The generated script must carry the npm-kind assembly path.
    const script = buildInstallScript(plan)
    expect(script).toContain('install --prod --silent --registry')
    console.log('[arm64-dryrun] script bytes:', script.length)
  }, 120_000)
})
