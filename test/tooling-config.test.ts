import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { resolveConfig } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createVitest } from 'vitest/node'
import rootConfig from '../vitest.config'
import desktopConfig from '../vitest.desktop.config'
import pluginConfig from '../vitest.plugin.config'
import unitConfig from '../vitest.unit.config'

const root = fileURLToPath(new URL('../', import.meta.url))
let runtime: Awaited<ReturnType<typeof createVitest>>

beforeAll(async () => {
  runtime = await createVitest('test', {
    root,
    config: path.join(root, 'vitest.config.ts'),
    watch: false,
  })
})

afterAll(async () => {
  await runtime?.close()
})

describe('tooling configuration contracts', () => {
  it('vite and both Vitest alias consumers resolve @ to the shell source directory', async () => {
    const vite = await resolveConfig({ configFile: path.join(root, 'vite.config.ts') }, 'serve')
    const source = path.join(root, 'src')
    expect(vite.resolve.alias).toContainEqual({ find: '@', replacement: source })
    expect(rootConfig.resolve?.alias).toEqual({ '@': source })
    expect(unitConfig.resolve?.alias).toEqual({
      '@': source,
      'dsh-tauri/client': path.join(root, 'packages/dsh-tauri/src/client/index.ts'),
      'dsh-tauri': path.join(root, 'packages/dsh-tauri/src/index.ts'),
      'dsh-tauri-ui/client': path.join(root, 'packages/dsh-tauri-ui/src/client/index.ts'),
      'dsh-tauri-ui': path.join(root, 'packages/dsh-tauri-ui/src/index.ts'),
    })
    const unit = runtime.projects.find(project => project.name === 'unit')!
    const resolved = await unit.vite.pluginContainer.resolveId('@/config/query-keys')
    expect(resolved?.id.replaceAll('\\', '/')).toBe(`${root.replaceAll('\\', '/')}src/config/query-keys.ts`)
  })

  it('each project retains its distinct setup, scheduling and timeout envelope', () => {
    expect(unitConfig.test).toEqual({
      name: 'unit',
      include: ['packages/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}', 'test/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
      exclude: [
        '**/node_modules/**',
        'test/archive/**',
        'archive/**',
      ],
      setupFiles: ['./test/setup/tauri-runtime.ts'],
      maxWorkers: 4,
      testTimeout: 30_000,
      hookTimeout: 30_000,
    })
    expect(pluginConfig.test).toEqual({
      name: 'plugin',
      include: ['test/e2e/plugins/**/*.e2e.ts'],
      globalSetup: ['./test/e2e/setup-plugin.ts'],
      environment: 'node',
      fileParallelism: false,
      testTimeout: 120_000,
      hookTimeout: 120_000,
    })
    expect(desktopConfig.test).toEqual({
      name: 'desktop',
      include: ['test/e2e/desktop/*.e2e.ts'],
      globalSetup: ['./test/e2e/setup-desktop.ts'],
      environment: 'node',
      fileParallelism: false,
      testTimeout: 180_000,
      hookTimeout: 180_000,
    })
    expect(runtime.projects.map(project => project.name)).toEqual(['unit', 'plugin', 'desktop'])
    expect(runtime.projects.map(project => ({
      name: project.name,
      environment: project.config.environment,
      maxWorkers: project.config.maxWorkers,
      testTimeout: project.config.testTimeout,
      hookTimeout: project.config.hookTimeout,
    }))).toEqual([
      { name: 'unit', environment: 'node', maxWorkers: 4, testTimeout: 30_000, hookTimeout: 30_000 },
      { name: 'plugin', environment: 'node', maxWorkers: 1, testTimeout: 120_000, hookTimeout: 120_000 },
      { name: 'desktop', environment: 'node', maxWorkers: 1, testTimeout: 180_000, hookTimeout: 180_000 },
    ])
  })

  it('runtime collection routes unit and E2E files without admitting excluded paths', async () => {
    const cases = [
      ['test/tooling-config.test.ts', ['unit']],
      ['src/layout/components/nav-bridge.test.ts', ['unit']],
      ['packages/dsh-tauri/src/host/apply.test.ts', ['unit']],
      ['test/e2e/plugins/dsh-tauri.e2e.ts', ['plugin']],
      ['test/e2e/plugins/nested/contract.e2e.ts', ['plugin']],
      ['test/e2e/desktop/boot.e2e.ts', ['desktop']],
      ['test/e2e/desktop/nested/contract.e2e.ts', []],
      ['test/archive/contract.test.ts', []],
      ['archive/contract.test.ts', []],
      ['source/contract.test.ts', []],
      ['packages/dsh-tauri/node_modules/copy/index.test.ts', []],
      ['packages/dsh-tauri-ssh/src/client/components/panel.test.tsx', ['unit']],
      ['packages/dsh-tauri-ssh/src/client/index.test.ts', ['unit']],
      ['src/layout/components/remote-switcher.test.tsx', ['unit']],
      ['src/layout/components/connect-dialog.test.tsx', ['unit']],
    ] as const
    for (const [relative, projects] of cases) {
      expect(runtime.projects.filter(project => project.matchesTestGlob(path.join(root, relative))).map(project => project.name), relative).toEqual(projects)
    }
    const specs = await runtime.globTestSpecifications()
    expect(specs.filter(spec => spec.moduleId.endsWith('/test/tooling-config.test.ts')).map(spec => spec.project.name)).toEqual(['unit'])
    expect(specs.filter(spec => spec.moduleId.endsWith('/test/e2e/desktop/boot.e2e.ts')).map(spec => spec.project.name)).toEqual(['desktop'])
    expect(specs.filter(spec => spec.moduleId.endsWith('/test/e2e/plugins/dsh-tauri.e2e.ts')).map(spec => spec.project.name)).toEqual(['plugin'])
    for (const file of [
      'packages/dsh-tauri-ssh/src/client/components/machines-section.test.tsx',
      'packages/dsh-tauri-ssh/src/client/index.test.ts',
      'src/layout/components/remote-switcher.test.tsx',
      'src/layout/components/connect-dialog.test.tsx',
    ]) {
      expect(specs.filter(spec => spec.moduleId.replaceAll('\\', '/').endsWith(`/${file}`)).map(spec => spec.project.name), file).toEqual(['unit'])
    }
    for (const spec of specs) {
      const relative = path.relative(root, spec.moduleId).replaceAll('\\', '/')
      expect(relative).not.toMatch(/(^|\/)node_modules\//)
      expect(relative).not.toMatch(/^(?:archive|source|test\/archive)\//)
    }
  })

  it('coverage remains root-only with all existing exclusions and no thresholds', () => {
    expect(rootConfig.test?.projects).toEqual(['./vitest.unit.config.ts', './vitest.plugin.config.ts', './vitest.desktop.config.ts'])
    expect(rootConfig.test?.coverage).toEqual({
      provider: 'v8',
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.{idea,git,cache,output,temp}/**',
        '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
        'source/**',
        'archive/**',
        'test/archive/**',
        'src-tauri/**',
      ],
    })
    expect(rootConfig.test).not.toHaveProperty('include')
    for (const config of [unitConfig, pluginConfig, desktopConfig]) {
      expect(config.test).not.toHaveProperty('coverage')
      expect(config.test).not.toHaveProperty('globals')
    }
  })

  it('the folded TypeScript project includes tooling without weakening compiler checks', () => {
    const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
    expect(config.error).toBeUndefined()
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
    expect(parsed.errors).toEqual([])
    expect(parsed.projectReferences).toBeUndefined()
    expect(config.config).not.toHaveProperty('exclude')
    expect(parsed.options).toMatchObject({
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noFallthroughCasesInSwitch: true,
      noEmit: true,
      isolatedModules: true,
      skipLibCheck: true,
    })
    const files = parsed.fileNames.map(file => path.relative(root, file).replaceAll('\\', '/'))
    for (const file of [
      'vite.config.ts',
      'vitest.config.ts',
      'vitest.unit.config.ts',
      'vitest.plugin.config.ts',
      'vitest.desktop.config.ts',
      'tooling.config.ts',
      'bump.config.ts',
      'genapi.config.ts',
      'scripts/build-debug.ts',
      'scripts/build-plugins.ts',
      'scripts/rebuild-macos-icon.ts',
      'packages/.test/test-utils.ts',
    ]) {
      expect(files, file).toContain(file)
    }
  })
})
