import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadManualSshFixture, manualIntegrations, requireManualIntegration } from './integrations'

const roots: string[] = []
let root: string

function temp(prefix = 'dsh-e2e-ssh-'): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

function fixture(overrides: Record<string, unknown> = {}): string {
  const path = join(root, 'fixture.json')
  writeFileSync(path, JSON.stringify({
    host: '127.0.0.1',
    port: 2222,
    user: 'test',
    remotePort: 3080,
    hostKeySha256: 'A'.repeat(43),
    password: 'dedicated-test-only',
    ...overrides,
  }))
  vi.stubEnv('DSH_E2E_SSH_FIXTURE', path)
  return path
}

beforeEach(() => {
  root = temp()
  for (const key of ['CI', 'GITHUB_ACTIONS', 'DSH_E2E_INTEGRATIONS', 'DSH_E2E_SSH_FIXTURE'])
    vi.stubEnv(key, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true })
})

describe('人工外部集成必须显式、独占并拒绝 CI', () => {
  it('默认常规门禁不包含外部 SSH 或公网试验，旧环境变量不能偷偷启用', () => {
    expect(manualIntegrations({ DSH_SSH_E2E_HOST: 'dev', DSH_E2E_TUNNEL: '1' }), '旧别名不得隐式启动外部副作用').toEqual([])
    expect(() => requireManualIntegration('ssh'), '未显式选择必须失败而非跳过').toThrow('显式选择')
    expect(() => loadManualSshFixture(), '没有选择时不能读取任何 fixture').toThrow('显式选择')
  })

  it.each(['ssh', 'tunnel', 'ssh,tunnel'])('只接受显式声明的人工入口：%s', (value) => {
    expect(manualIntegrations({ DSH_E2E_INTEGRATIONS: value }), '选择结果必须精确匹配').toEqual(value.split(','))
  })

  it.each(['unknown', 'ssh,ssh', 'ssh,tunnel,', '*'])('无效或重复入口必须失败：%s', (value) => {
    expect(() => manualIntegrations({ DSH_E2E_INTEGRATIONS: value }), '配置错误不能静默忽略').toThrow('仅接受')
  })

  it.each(['CI', 'GITHUB_ACTIONS'])('即使显式选择也拒绝 %s，禁止 CI 触碰外部主机', (key) => {
    expect(() => manualIntegrations({ DSH_E2E_INTEGRATIONS: 'ssh,tunnel', [key]: 'true' }), '人工入口必须拒绝 CI').toThrow('禁止在 CI')
  })

  it('缺少 fixture 或给相对路径时失败，不尝试读取用户 SSH 配置', () => {
    vi.stubEnv('DSH_E2E_INTEGRATIONS', 'ssh')
    expect(() => loadManualSshFixture(), '缺 fixture 必须失败').toThrow('不使用用户 SSH 配置')
    vi.stubEnv('DSH_E2E_SSH_FIXTURE', 'fixture.json')
    expect(() => loadManualSshFixture(), '相对 fixture 必须失败').toThrow('不使用用户 SSH 配置')
  })

  it('没有专用目录标记的 Temp fixture 也必须拒绝', () => {
    vi.stubEnv('DSH_E2E_INTEGRATIONS', 'ssh')
    const outside = join(temp('unowned-ssh-'), 'fixture.json')
    writeFileSync(outside, '{}')
    vi.stubEnv('DSH_E2E_SSH_FIXTURE', outside)
    expect(() => loadManualSshFixture(), '临时目录不是放弃所有权的理由').toThrow('独占的系统 Temp')
  })

  it('目录外链不能把个人凭据伪装成专用 fixture', () => {
    vi.stubEnv('DSH_E2E_INTEGRATIONS', 'ssh')
    const outside = temp('unowned-ssh-')
    writeFileSync(join(outside, 'fixture.json'), '{}')
    const link = join(root, 'dsh-e2e-ssh-linked')
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    vi.stubEnv('DSH_E2E_SSH_FIXTURE', join(link, 'fixture.json'))
    expect(() => loadManualSshFixture(), '必须校验 canonical 根而非用户传入的表面路径').toThrow('独占的系统 Temp')
  })

  it.each([
    { host: 'dev' },
    { port: 0 },
    { remotePort: 65536 },
    { hostKeySha256: undefined },
    { password: undefined },
    { privateKey: {} },
  ])('别名、错误端口或缺明确凭据/指纹均必须失败：%j', (input) => {
    vi.stubEnv('DSH_E2E_INTEGRATIONS', 'ssh')
    fixture(input)
    expect(() => loadManualSshFixture(), '不能回退到用户 alias、agent、密钥或信任全部主机').toThrow('显式测试凭据')
  })

  it('只读取显式测试凭据，不读取或修改 HOME/.ssh，也不改调用进程 HOME', () => {
    vi.stubEnv('DSH_E2E_INTEGRATIONS', 'ssh')
    const home = temp('dsh-readonly-home-')
    mkdirSync(join(home, '.ssh'))
    const config = join(home, '.ssh', 'config')
    writeFileSync(config, 'Host dev\n IdentityFile must-not-read\n')
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    fixture()
    expect(loadManualSshFixture(), '仅允许显式 fixture 凭据').toMatchObject({ host: '127.0.0.1', password: 'dedicated-test-only' })
    expect(process.env.HOME, '加载 fixture 不得改写 HOME').toBe(home)
    expect(readFileSync(config, 'utf8'), '用户 SSH 配置必须完全未变').toBe('Host dev\n IdentityFile must-not-read\n')
  })
})
