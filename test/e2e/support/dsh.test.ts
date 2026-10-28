import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isolatedDshEnv, patchCoreClients, resolveDshCommand, startDshProcess } from './dsh'

let root: string

function cli(version: string): string {
  const packageRoot = join(root, 'cli', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ version }))
  const entry = join(packageRoot, 'lib', 'bin.js')
  writeFileSync(entry, '')
  return entry
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-e2e-isolation-test-'))
  vi.stubEnv('DSH_E2E_DSH_BIN', undefined)
  vi.stubEnv('DSH_E2E_CORE_VERSION', undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('独立 CLI 与用户目录隔离', () => {
  it('缺少显式 CLI 直接失败，禁止用户运行时回退', () => {
    expect(() => resolveDshCommand(), '缺环境不得使用真实用户安装').toThrow('请设置 DSH_E2E_DSH_BIN')
  })

  it('相对入口和不存在入口直接失败', () => {
    vi.stubEnv('DSH_E2E_DSH_BIN', 'lib/bin.js')
    expect(() => resolveDshCommand(), '相对路径不得隐式解析到仓库').toThrow('绝对路径')
    vi.stubEnv('DSH_E2E_DSH_BIN', join(root, 'missing.js'))
    expect(() => resolveDshCommand(), '缺入口不得回退到其他核心').toThrow('绝对路径')
  })

  it.each(['0.1.7-rc.1', '0.2.1-rc.3', 'unknown'])('拒绝最低基线之前或非法的版本：%s', (version) => {
    vi.stubEnv('DSH_E2E_DSH_BIN', cli(version))
    expect(() => resolveDshCommand(), '老核心不得继续作为适配基线').toThrow('最低版本为 0.2.1-rc.4')
  })

  it.each(['0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-alpha.2'])('独立实物 CLI 精确匹配时放行：%s', (version) => {
    const entry = cli(version)
    vi.stubEnv('DSH_E2E_DSH_BIN', entry)
    vi.stubEnv('DSH_E2E_CORE_VERSION', version)
    expect(resolveDshCommand(), '必须解析到实际隔离安装，而不是另一版本').toEqual([realpathSync(entry)])
  })

  it('声明版本与实际包不一致必须失败', () => {
    vi.stubEnv('DSH_E2E_DSH_BIN', cli('0.2.1-rc.4'))
    vi.stubEnv('DSH_E2E_CORE_VERSION', '0.2.1-rc.5')
    expect(() => resolveDshCommand(), '错误版本 lane 不得被当成已验证').toThrow('要求 0.2.1-rc.5，实际 0.2.1-rc.4')
  })

  it.each(['package', 'file', 'ancestor'])('补丁目标经 %s 外链越界时必须在读取前拒绝', (layout) => {
    const entry = cli('0.2.1-rc.4')
    vi.stubEnv('DSH_E2E_DSH_BIN', entry)
    const outside = join(root, 'outside', 'node_modules', '@deepseek-ai', 'dsh-client-ui-renderer')
    mkdirSync(join(outside, 'lib'), { recursive: true })
    const target = join(outside, 'lib', 'client.js')
    const source = 'return module.exports;\n'
    writeFileSync(target, source)
    const scoped = join(root, 'cli', 'node_modules', '@deepseek-ai')
    if (layout === 'package') {
      symlinkSync(outside, join(scoped, 'dsh-client-ui-renderer'), process.platform === 'win32' ? 'junction' : 'dir')
    }
    else if (layout === 'file') {
      const nested = join(scoped, 'dsh-client-ui-renderer')
      mkdirSync(nested, { recursive: true })
      symlinkSync(join(outside, 'lib'), join(nested, 'lib'), process.platform === 'win32' ? 'junction' : 'dir')
    }
    else {
      mkdirSync(join(root, 'node_modules', '@deepseek-ai'), { recursive: true })
      symlinkSync(outside, join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-renderer'), process.platform === 'win32' ? 'junction' : 'dir')
      writeFileSync(join(outside, 'package.json'), JSON.stringify({ exports: { './client': './lib/client.js' } }))
    }
    expect(() => patchCoreClients(entry), '包链接、文件链接与祖先解析都不得越出安装根').toThrow('补丁目标越出独立安装根')
    expect(readFileSync(target, 'utf8'), '外部客户端内容必须完全未被写入').toBe(source)
  })

  it('真实无效 Node 命令立即失败并清理 profile，不等待就绪超时', async () => {
    const entry = cli('0.2.1-rc.4')
    vi.stubEnv('DSH_E2E_DSH_BIN', entry)
    vi.stubEnv('DSH_E2E_NODE_BIN', join(root, 'missing-node'))
    const scoped = join(root, 'cli', 'node_modules', '@deepseek-ai')
    for (const [pkg, source] of [
      ['dsh-client-ui-renderer', 'exports.SlotOutlet = SlotOutlet;\nreturn module.exports;\n'],
      ['dsh-client-ui-conversation', 'dsh-tauri: composer stays usable for a session outside every workspace\n'],
    ]) {
      const lib = join(scoped, pkg, 'lib')
      mkdirSync(lib, { recursive: true })
      writeFileSync(join(lib, 'client.js'), source)
    }
    const home = join(root, 'dsh-e2e-process-failure')
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    const started = Date.now()
    await expect(startDshProcess({ home, profileDir, packages: [] }, entry), 'spawn ENOENT 必须以可诊断拒绝返回').rejects.toThrow(/dsh web 启动失败.*ENOENT/)
    expect(Date.now() - started, '错误不能变成 120 秒超时').toBeLessThan(10_000)
    expect(existsSync(home), 'spawn 失败必须回收独占 profile 与日志句柄').toBe(false)
  })

  it('构造子进程环境时隔离全部用户根并去除冒充桌面标记', () => {
    vi.stubEnv('DSH_TAURI_EMBEDDED', '1')
    vi.stubEnv('DSH_E2E_HOME', 'parent-scratch')
    vi.stubEnv('HOME', 'real-user-sentinel')
    vi.stubEnv('USERPROFILE', 'real-user-sentinel')
    const env = isolatedDshEnv(root)
    expect(env.DSH_HOME, '核心状态只能写本次 scratch').toBe(root)
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'PNPM_HOME', 'COREPACK_HOME', 'npm_config_userconfig', 'npm_config_cache']) {
      const path = env[key]!
      expect(relative(root, path).startsWith('..'), `${key} 必须位于 scratch 内`).toBe(false)
    }
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'PNPM_HOME'])
      expect(existsSync(env[key]!), `${key} 目录必须已实际创建`).toBe(true)
    expect(readFileSync(env.npm_config_userconfig!, 'utf8'), '不得继承用户 npm 凭据').toBe('')
    expect(env.NPM_CONFIG_USERCONFIG, '大小写配置必须指向同一隔离文件').toBe(env.npm_config_userconfig)
    expect(env.DSH_TAURI_EMBEDDED, '普通 web 不得继承桌面 admission').toBeUndefined()
    expect(env.DSH_E2E_HOME, '子核心不得继承另一原生测试隔离根').toBeUndefined()
    expect(process.env.HOME, '环境生成不得改写调用方进程').toBe('real-user-sentinel')
    expect(process.env.DSH_TAURI_EMBEDDED, '不得影响调用方 admission 状态').toBe('1')
  })
})
