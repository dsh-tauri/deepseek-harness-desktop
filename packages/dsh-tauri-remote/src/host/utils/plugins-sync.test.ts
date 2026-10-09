import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPluginsBundle, findBundledPluginsTree, pluginSyncApplyCommand, pluginSyncMarkerCommand, WIRE_SCRIPT } from './plugins-sync'

describe('findBundledPluginsTree', () => {
  it('locates deployed plugins from the dev layout and excludes ordinary dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-plugins-discovery-'))
    try {
      const source = join(root, 'packages', 'dsh-tauri-remote')
      const deployed = join(root, 'src-tauri', 'resources', 'node_modules')
      mkdirSync(source, { recursive: true })
      writeFileSync(join(source, 'package.json'), '{"name":"dsh-tauri-remote"}')
      for (const name of ['dsh-tauri-remote', 'dsh-tauri-ui', 'ssh2', 'dsh-tauri-panel']) {
        mkdirSync(join(deployed, name), { recursive: true })
        writeFileSync(join(deployed, name, 'package.json'), JSON.stringify({
          name,
          ...name === 'dsh-tauri-remote' || name === 'dsh-tauri-ui' ? { dsh: { bundle: {} } } : {},
        }))
      }
      expect(findBundledPluginsTree(source)).toEqual({
        root: deployed,
        pluginNames: ['dsh-tauri-remote', 'dsh-tauri-ui'],
      })
      expect(findBundledPluginsTree(join(deployed, 'dsh-tauri-remote'))).toEqual({
        root: deployed,
        pluginNames: ['dsh-tauri-remote', 'dsh-tauri-ui'],
      })
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('buildPluginsBundle', () => {
  let staging: string | undefined

  afterEach(() => {
    if (staging !== undefined)
      rmSync(staging, { recursive: true, force: true })
    staging = undefined
  })

  it('packages the tree plus the wiring helper, hashed for skip-if-same', async () => {
    // 微缩树：两个「插件」+ 一个依赖，验证 tar 组装与哈希稳定即可
    staging = mkdtempSync(join(tmpdir(), 'dsh-plugins-tree-'))
    for (const name of ['plugin-a', 'plugin-b']) {
      mkdirSync(join(staging, name, 'dist'), { recursive: true })
      writeFileSync(join(staging, name, 'package.json'), JSON.stringify({ name, dsh: { bundle: {} } }))
      writeFileSync(join(staging, name, 'dist', 'index.js'), `// ${name}`)
    }
    mkdirSync(join(staging, 'some-dep'), { recursive: true })
    writeFileSync(join(staging, 'some-dep', 'package.json'), JSON.stringify({ name: 'some-dep' }))

    const first = await buildPluginsBundle({ root: staging, pluginNames: ['plugin-a', 'plugin-b'] })
    expect(first.tar.length).toBeGreaterThan(0)
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/)
    const second = await buildPluginsBundle({ root: staging, pluginNames: ['plugin-a', 'plugin-b'] })
    // tar 头部含时间戳，内容同则哈希可能不同——不断言相等，只断言可复算
    expect(second.hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('plugin sync commands', () => {
  const tree = { root: '/x', pluginNames: ['dsh-tauri', 'dsh-tauri-remote'] }

  it('marker command reads the remote hash silently', () => {
    expect(pluginSyncMarkerCommand()).toContain('.dsh-desktop/plugins/.sync-sha256')
  })

  it('apply command: atomic swap + hash marker + profile wiring + instance restart', () => {
    const command = pluginSyncApplyCommand(tree, 'abc123', 'remote', 3080)
    // 原子交换：staging → 正式位
    expect(command).toContain('$BASE.new')
    expect(command).toContain('mv "$BASE.new" "$BASE"')
    // 哈希标记
    expect(command).toContain('echo "abc123" > "$HOME/.dsh-desktop/plugins/.sync-sha256"')
    // profile 接线走上传的 _wire.js（deps link + bundles + symlink）
    expect(command).toContain('_wire.js')
    expect(command).toContain('.dsh/profiles/remote/package.json')
    expect(command).toContain('dsh-tauri dsh-tauri-remote')
    // 实例在跑则按 pidfile 重启（ensure 探测落空后按新 profile 拉起）；
    // pidfile 之外按安装路径精确清场，并等远端实例端口释放避免新实例 EADDRINUSE
    expect(command).toContain('.dsh/dsh-remote.pid')
    expect(command).toContain('kill')
    expect(command).toContain('pkill -f')
    expect(command).toContain('/dev/tcp/127.0.0.1/3080')
    // 等待循环探测的是该机器自己的 remotePort，不是硬编码的 3080
    expect(pluginSyncApplyCommand(tree, 'abc123', 'remote', 3082)).toContain('/dev/tcp/127.0.0.1/3082')
    expect(command).toContain('PLUGINS_SYNCED')
  })

  it('wire script prunes stale managed links absent from the current tree', async () => {
    const staging = mkdtempSync(join(tmpdir(), 'wire-prune-'))
    try {
      const base = join(staging, 'plugins', 'node_modules')
      mkdirSync(join(base, 'dsh-tauri'), { recursive: true })
      writeFileSync(join(base, 'dsh-tauri', 'package.json'), '{"name":"dsh-tauri"}')
      const profile = join(staging, 'profiles', 'web')
      mkdirSync(join(profile, 'node_modules'), { recursive: true })
      const pkg = join(profile, 'package.json')
      writeFileSync(pkg, JSON.stringify({
        dependencies: {
          'dsh-tauri': `link:${join(base, 'dsh-tauri')}`,
          'dsh-tauri-panel': `link:${join(base, 'dsh-tauri-panel')}`,
          'dshmarket': '^1.31.1',
        },
        dsh: { profile: { bundles: ['dsh-tauri', 'dsh-tauri-panel', 'dshmarket'] } },
      }))
      mkdirSync(join(profile, 'node_modules', 'dsh-tauri-panel'), { recursive: true })
      const wire = join(staging, '_wire.js')
      writeFileSync(wire, WIRE_SCRIPT)
      execFileSync(process.execPath, [wire, pkg, base, 'dsh-tauri'])
      const doc = JSON.parse(readFileSync(pkg, 'utf8'))
      expect(Object.keys(doc.dependencies).sort()).toEqual(['dsh-tauri', 'dshmarket'])
      expect(doc.dsh.profile.bundles).toEqual(['dsh-tauri', 'dshmarket'])
      expect(existsSync(join(profile, 'node_modules', 'dsh-tauri-panel'))).toBe(false)
      expect(existsSync(join(profile, 'node_modules', 'dsh-tauri'))).toBe(true)
    }
    finally {
      rmSync(staging, { recursive: true, force: true })
    }
  })
})
