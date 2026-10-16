// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * AppImage 宿主接口库剔除契约（issue #620）。
 *
 * Tauri 固定使用的 linuxdeploy 会把构建镜像（ubuntu-22.04）的显示栈库一并打进
 * AppImage，而 `AppRun.wrapped` 又把 `$APPDIR/usr/lib` 放在 `LD_LIBRARY_PATH` 首位。
 * 较新发行版（Arch/CachyOS、Fedora 44…）的宿主 Mesa 因此加载到这些旧库、EGL 协商
 * 失败，WebKit 在 `eglGetDisplay` 失败时调用 `abort()`：`WebKitWebProcess` 以 SIGABRT
 * 退出，主窗口从未出现且用户侧没有任何日志。上游 tauri#15976 用同一份最小库集合
 * 复现并验证了「剔除即恢复」。.deb 走系统库，不受影响。
 *
 * 这里锁三件事：
 *   1. 剔除清单不退化（10 个宿主接口库），且不多删渲染栈本体（libEGL/libGL/libgbm/libdrm）；
 *   2. CI 在签名/上传之前对每个 AppImage 跑到本脚本，并带 `--require-removal`——将来
 *      bundler 不再过度打包时构建会明确失败，而不是让 #620 静默回归；
 *   3. 脚本本身仍具备幂等与告警语义（重复执行的输出/退出码契约）。
 */

const fixScriptPath = fileURLToPath(new URL('../scripts/fix-appimage-host-libs.sh', import.meta.url))
const linuxWorkflowPath = fileURLToPath(new URL('../.github/workflows/build-linux.yml', import.meta.url))

/**
 * `bash`（Windows 上是 Git Bash）只认 `C:/…` 或 MSYS 的 `/c/…` 形式，
 * 混合形式 `/c:/…` 会被当成不存在的路径（退出码 127）。非 Windows 平台原样返回。
 */
function toBashPath(filePath: string): string {
  if (process.platform !== 'win32')
    return filePath
  return `/${filePath[0].toLowerCase()}${filePath.slice(2).replace(/\\/g, '/')}`
}

function bashExitCode(args: string[]): number {
  try {
    // `stdio: 'ignore'`：管道捕获子进程输出在受限沙箱下会因命名管道不可用而失败，
    // 这里只需退出码，不需要 stdout/stderr。
    execFileSync('bash', args, { stdio: 'ignore' })
    return 0
  }
  catch (error) {
    return (error as { status?: number }).status ?? -1
  }
}

const fixScript = readFileSync(fixScriptPath, 'utf8')
const linuxWorkflow = readFileSync(linuxWorkflowPath, 'utf8')

/** 必须交给宿主提供的显示/输入栈库（tauri#15976 二分出的最小集合）。 */
const HOST_INTERFACE_LIBS = [
  'libwayland-client.so.0',
  'libwayland-cursor.so.0',
  'libwayland-egl.so.1',
  'libwayland-server.so.0',
  'libxkbcommon.so.0',
  'libxcb-randr.so.0',
  'libxcb-render.so.0',
  'libxcb-shm.so.0',
  'libXau.so.6',
  'libXdmcp.so.6',
]

/**
 * 渲染栈本体：linuxdeploy 自带 excludelist 本就不打包它们，剔除反而破坏渲染。
 * 严格断言「脚本没有把它们放进 EXCLUDED_LIBS 数组」，而不是全文搜字符串——
 * 注释里提到这些名字是合理的，被误删才是 bug。
 */
const RENDER_STACK_LIBS = ['libEGL.so.1', 'libGL.so.1', 'libgbm.so.1', 'libdrm.so.2']

function excludedLibsArray(): string {
  const match = /^readonly EXCLUDED_LIBS=\(\n([\s\S]*?)^\)/m.exec(fixScript)
  if (!match)
    throw new Error('scripts/fix-appimage-host-libs.sh 里找不到 EXCLUDED_LIBS 数组')
  return match[1]
}

describe('appimage host-interface library exclusion (#620)', () => {
  it('drops every lib from the upstream minimal set', () => {
    const array = excludedLibsArray()
    const listed = array
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'))

    for (const lib of HOST_INTERFACE_LIBS)
      expect(listed, `${lib} 必须从 AppImage 中剔除`).toContain(lib)
    expect(listed).toHaveLength(HOST_INTERFACE_LIBS.length)
  })

  it('never removes the render stack the bundler already excludes', () => {
    const array = excludedLibsArray()
    for (const lib of RENDER_STACK_LIBS)
      expect(array, `${lib} 由 linuxdeploy excludelist 负责，剔除会破坏渲染`).not.toContain(lib)
  })

  it('repacks with the same squashfs parameters linuxdeploy produced', () => {
    // 与实测产物对齐（zstd / 128K block）：换压缩器或块大小会让镜像体积与兼容性漂移。
    expect(fixScript).toContain('SQUASHFS_COMPRESSION=zstd')
    expect(fixScript).toContain('SQUASHFS_BLOCK_SIZE=131072')
    expect(fixScript).toContain('-comp "$SQUASHFS_COMPRESSION"')
    expect(fixScript).toContain('-b "$SQUASHFS_BLOCK_SIZE"')
    // 复用原 runtime 前缀，不依赖 appimagetool / 上游 floating tag。
    expect(fixScript).toContain('head -c "$offset"')
  })

  it('verifies the repacked image before overwriting the artifact', () => {
    for (const required of ['AppRun', 'AppRun.wrapped', 'usr/lib/libwebkit2gtk-4.1.so.0'])
      expect(fixScript, `自检必须保留 ${required}`).toContain(required)
    // 交付前在独立目录复核剔除结果，避免只看已被剪过的同一棵树。
    expect(fixScript).toContain('verify="$work/verify"')
  })

  it('supports --require-removal so a silent bundler change fails the build', () => {
    expect(fixScript).toContain('--require-removal')
    expect(fixScript).toContain('require_removal=1')
    expect(fixScript).toContain('is no longer happening, or the bundler changed')
  })

  it('is syntactically valid bash', () => {
    // `bash -n` 只做语法解析，不需要真机 AppImage，因此能在任意平台跑。
    expect(bashExitCode(['-n', toBashPath(fixScriptPath)])).toBe(0)
  })

  it('exits 2 with usage when no AppImage is given', () => {
    expect(bashExitCode([toBashPath(fixScriptPath)])).toBe(2)
  })

  it('fails loudly on a missing AppImage', () => {
    const missing = fileURLToPath(new URL('../scripts/__definitely-missing__.AppImage', import.meta.url))
    expect(bashExitCode([toBashPath(fixScriptPath), toBashPath(missing)])).toBe(1)
  })

  it('requires --require-removal to precede the AppImage argument', () => {
    // 顺序写反会让脚本把 `--require-removal` 当成文件路径并报「no such file」，
    // 这里锁定参数解析形式，避免 CI 里静默失效。
    expect(fixScript).toMatch(/if \[ "\$\{1:-\}" = "--require-removal" \]/)
  })
})

describe('appimage GTK backend selection (#789)', () => {
  it.skipIf(process.platform !== 'linux').each([false, true])('repacks GTK hook (bundled host library: %s), preserves backends, and is idempotent', (bundledHostLibrary) => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-appimage-'))
    try {
      const tree = join(work, 'AppDir')
      mkdirSync(join(tree, 'apprun-hooks'), { recursive: true })
      mkdirSync(join(tree, 'usr/lib'), { recursive: true })
      mkdirSync(join(tree, 'usr/bin'), { recursive: true })
      writeFileSync(join(tree, 'AppRun'), '#!/bin/sh\nexit 0\n')
      writeFileSync(join(tree, 'AppRun.wrapped'), '#!/bin/sh\nexit 0\n')
      writeFileSync(join(tree, 'usr/bin/app'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(tree, 'usr/bin/app'), 0o755)
      writeFileSync(join(tree, 'usr/lib/libwebkit2gtk-4.1.so.0'), 'keep WebKit')
      if (bundledHostLibrary)
        writeFileSync(join(tree, 'usr/lib/libwayland-client.so.0'), 'drop host library')
      writeFileSync(join(tree, 'apprun-hooks/linuxdeploy-plugin-gtk.sh'), 'export GTK_THEME=Adwaita\nexport GDK_BACKEND=x11 # upstream override\nexport GTK_DATA_PREFIX="$APPDIR"\n')
      const image = join(work, 'test.AppImage')
      execFileSync('mksquashfs', [tree, image, '-noappend', '-quiet', '-no-progress'], { stdio: 'inherit' })
      execFileSync('bash', [fixScriptPath, ...(bundledHostLibrary ? ['--require-removal'] : []), image], { stdio: 'inherit' })
      const output = join(work, 'unpacked')
      execFileSync('unsquashfs', ['-d', output, image], { stdio: 'ignore' })
      const hook = join(output, 'apprun-hooks/linuxdeploy-plugin-gtk.sh')
      expect(readFileSync(hook, 'utf8')).toBe('export GTK_THEME=Adwaita\nexport GTK_DATA_PREFIX="$APPDIR"\n')
      for (const backend of ['', 'wayland', 'x11', 'x11,wayland']) {
        execFileSync('bash', ['-c', 'source "$1"; test "$GDK_BACKEND" = "$2" && test "$GTK_THEME" = Adwaita', '_', hook, backend], {
          env: { ...process.env, GDK_BACKEND: backend },
          stdio: 'inherit',
        })
      }
      const fixed = readFileSync(image)
      execFileSync('bash', [fixScriptPath, image], { stdio: 'inherit' })
      expect(readFileSync(image)).toEqual(fixed)
      expect(bashExitCode([fixScriptPath, '--require-removal', image])).toBe(1)
    }
    finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('does not discard explicit GDK_BACKEND values at runtime', () => {
    const startup = readFileSync(fileURLToPath(new URL('../src-tauri/src/lib.rs', import.meta.url)), 'utf8')
    expect(startup).not.toContain('std::env::remove_var("GDK_BACKEND")')
  })
})

describe.each([
  ['release', linuxWorkflow],
  ['unsigned', readFileSync(fileURLToPath(new URL('../.github/workflows/build-test.yml', import.meta.url)), 'utf8').split('  linux:')[1].split('  windows:')[0]],
])('linux %s workflow wires the appimage fix', (_name, workflow) => {
  it('installs squashfs-tools for mksquashfs', () => {
    expect(workflow).toContain('squashfs-tools')
  })

  it('runs the fix with --require-removal for every built AppImage', () => {
    expect(workflow).toContain('scripts/fix-appimage-host-libs.sh --require-removal')
    expect(workflow).toContain('find src-tauri/target/release/bundle/appimage -name \'*.AppImage\'')
  })

  it('runs the fix after the bundle and before uploading artifacts', () => {
    const bundleIndex = workflow.indexOf('pnpm tauri build --bundles appimage,deb')
    const fixIndex = workflow.indexOf('scripts/fix-appimage-host-libs.sh --require-removal')
    const uploadIndex = workflow.indexOf('actions/upload-artifact')

    expect(bundleIndex).toBeGreaterThan(-1)
    expect(fixIndex).toBeGreaterThan(-1)
    expect(uploadIndex).toBeGreaterThan(-1)
    // 重写 AppImage 字节必须在打包之后、上传之前；顺序反了会发布未修复的镜像。
    expect(bundleIndex).toBeLessThan(fixIndex)
    expect(fixIndex).toBeLessThan(uploadIndex)
  })
})
