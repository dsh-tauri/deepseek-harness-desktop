import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRemoteCopies, remoteCopiesProbeCommand } from './core.utils'

const homes: string[] = []

function fixtureHome(): { home: string, deps: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-core-copies-'))
  homes.push(home)
  const deps = join(home, '.dsh-desktop', 'dependencies')
  mkdirSync(deps, { recursive: true })
  return { home, deps }
}

function completeCopy(deps: string, name: string, version: string): void {
  const dir = join(deps, name)
  mkdirSync(join(dir, 'node_modules/@deepseek-ai/dsh/lib'), { recursive: true })
  writeFileSync(join(dir, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '')
  writeFileSync(join(dir, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ version }))
}

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true })
})

describe('remote core copy probe', () => {
  it('skips staging directories and directories without a core entry', () => {
    const { home, deps } = fixtureHome()
    completeCopy(deps, 'dsh', '0.2.2-rc.1')
    completeCopy(deps, 'dsh-0.2.3-1.new', '0.2.3')
    // 安装脚本的暂存与就绪目录带运行级后缀，同样不能被当成一个副本。
    completeCopy(deps, 'dsh-0.2.3-1.new.4242', '0.2.3')
    completeCopy(deps, 'dsh-0.2.3-1.ready.4242', '0.2.3')
    mkdirSync(join(deps, 'dsh-broken'))

    const result = spawnSync('sh', ['-c', remoteCopiesProbeCommand()], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    })

    expect(result.status).toBe(0)
    expect(parseRemoteCopies(result.stdout).map(copy => copy.name)).toEqual(['dsh'])
  })
})
