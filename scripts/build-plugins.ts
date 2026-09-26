import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const PACKAGES_ROOT = join(REPO_ROOT, 'packages')
const BUNDLE_PACKAGE = join(PACKAGES_ROOT, 'dsh-tauri-bundle', 'package.json')
const RESOURCE_ROOT = join(REPO_ROOT, 'src-tauri', 'resources')
/** 运行期实际依赖的部署产物：`resources/node_modules/<name>`（Tauri 只捆绑 `resources/**`） */
const DEPLOYED_NODE_MODULES = join(RESOURCE_ROOT, 'node_modules')

function run(args: readonly string[]): void {
  console.log(`[build:plugins] $ pnpm ${args.join(' ')}`)
  const result = spawnSync('pnpm', args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) {
    throw new Error(`PNPM_START_FAILED: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`PNPM_COMMAND_FAILED: pnpm ${args.join(' ')} exited with ${result.status}`)
  }
}

function bundledPackageNames(): string[] {
  if (!existsSync(BUNDLE_PACKAGE)) {
    throw new Error(`PLUGIN_BUNDLE_MANIFEST_MISSING: ${BUNDLE_PACKAGE}`)
  }
  const manifest = JSON.parse(readFileSync(BUNDLE_PACKAGE, 'utf8')) as {
    dependencies?: Record<string, unknown>
  }
  const names = Object.keys(manifest.dependencies ?? {})
  if (names.length === 0) {
    throw new Error('PLUGIN_BUNDLE_EMPTY: dsh-tauri-bundle must depend on plugins')
  }
  return names
}

/**
 * 把 `pnpm deploy` 产物解引用复制到目标目录：pnpm 虚拟仓库（`.pnpm` 下的依赖入口）
 * 全是符号链接，必须逐条按「链接目标」的真实类型落成实体目录/文件。
 *
 * 为什么不用 `fs.cpSync(..., { dereference: true })`：Node 22.17 起该选项失效
 * （regression nodejs/node#59168），符号链接会被原样重建成指向**源目录**的绝对链接。
 * 本脚本的源目录是随后即删的临时目录 `.build-plugins-tmp`，于是产物里留下一堆悬垂
 * 链接；`tauri build` 展开 `bundle.resources` 通配时逐条登记资源，命中悬垂链接即以
 * `resource path ... doesn't exist` 失败（macOS / Linux 复现；Windows 因链接形态不同
 * 未触发，故只挂了两个平台）。
 *
 * `chain` 为当前递归路径上已展开目录的 realpath 集合，用于挡住链接成环的无限递归。
 */
function materializeTree(source: string, target: string, chain: ReadonlySet<string> = new Set()): void {
  const sourceReal = realpathSync(source)
  if (chain.has(sourceReal)) {
    throw new Error(`PLUGIN_DEPLOY_SYMLINK_CYCLE: ${source} -> ${sourceReal}`)
  }
  const nested = new Set(chain).add(sourceReal)
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    // statSync 跟随符号链接：按链接目标的类型决定复制方式，源里是不是链接无关紧要。
    const stats = statSync(from)
    if (stats.isDirectory()) {
      materializeTree(from, to, nested)
      continue
    }
    if (!stats.isFile()) {
      throw new Error(`PLUGIN_DEPLOY_UNSUPPORTED_ENTRY: ${from}`)
    }
    // copyFileSync 读取链接目标的内容，并保留源文件权限位（可执行脚本仍可执行）。
    copyFileSync(from, to)
  }
}

/**
 * 校验产物中不再残留任何符号链接。Tauri 打包会把资源通配展开成逐条路径，悬垂链接
 * 要到 cargo 构建脚本阶段才报错，离根因很远；宁可在这里带 `PLUGIN_DEPLOY_` 前缀早失败。
 */
function verifyMaterialized(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`PLUGIN_DEPLOY_SYMLINK_LEFTOVER: ${join(entry.parentPath, entry.name)}`)
    }
  }
}

/**
 * DSH 运行时自行下发的包：`resources/node_modules` 之外还有一份由 src-tauri 服务层
 * 按 local/npm/global 布局单独准备，插件侧只需 `loader.import()` 动态取用
 * （见 docs/specs/desktop.baisc.md「host 禁止静态引用 @deepseek-ai/*」）。整段排除即可，
 * 不必逐个删——它们只被 @deepseek-ai 自身互相引用。
 */
const RUNTIME_PROVIDED_SCOPES = ['@deepseek-ai'] as const

/** 确认为死枝的嵌套子树：插件只走 `unstorage` 主入口，`server` 子路径与它依赖的 h3 v1 无人引用。 */
const DEAD_SUBTREES = [join('unstorage', 'node_modules', 'h3')] as const

/** 部署工具自身的记账文件，不参与运行期解析。 */
const DEPLOY_METADATA = ['.pnpm', '.bin', '.modules.yaml', '.pnpm-workspace-state-v1.json'] as const

/** 运行期从不加载的文件：sourcemap 与类型声明。 */
const NON_RUNTIME_EXTENSIONS = [/\.map$/, /\.d\.(ts|cts|mts)$/] as const

/** 版权与许可声明必须随包分发，不参与裁剪。 */
const ATTRIBUTION_BASENAMES = /^(?:licen[cs]e|notice|copying)/i

/** 说明性文档与变更记录，运行期不加载。 */
const DOCUMENTATION_BASENAMES = /^(?:readme|changelog|changes|history|authors|contributors)/i
const DOCUMENTATION_EXTENSIONS = /\.md$/i

/** 仅服务开发/测试/浏览器条件的目录段，需配合守护集判断。 */
const PRUNE_SEGMENTS = new Set(['src', 'test', 'tests', '__tests__', 'browser'])

/**
 * Node 侧生效的 exports 条件。同一条件对象内 node / import / require 取并集——不同消费方
 * 可能分别按 ESM 与 CJS 加载；三者都不存在时才回退 default。types 与 browser 不参与。
 */
const RUNTIME_CONDITIONS = ['node', 'import', 'require'] as const
const FALLBACK_CONDITION = 'default'

const RUNTIME_FILE_PATTERN = /\.(?:js|cjs|mjs)$/

export function relativeSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const file = ts.createSourceFile('runtime.js', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  ts.forEachChild(file, visit)
  return specifiers

  function visit(node: ts.Node): void {
    let target: ts.Node | undefined
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      target = node.moduleSpecifier
    }
    else if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
    )) {
      target = node.arguments[0]
    }
    if (target && ts.isStringLiteralLike(target) && target.text.startsWith('.')) {
      specifiers.push(target.text)
    }
    ts.forEachChild(node, visit)
  }
}

interface PackageManifest {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  exports?: unknown
  main?: string
  module?: string
}

interface DeploymentIndex {
  dirs: string[]
  manifests: Map<string, PackageManifest>
  resolveFrom: (fromDir: string, name: string) => string | null
}

/**
 * 枚举产物内所有包目录：只认部署根、作用域目录与各级 `node_modules` 下的包。
 * 包自身子树里的 package.json（如 `yaml/browser/package.json`）不是可解析的包根，
 * 它只随所属包一起受目录段规则约束。
 */
function packageDirs(root: string): string[] {
  const dirs: string[] = []
  const collect = (parent: string): void => {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) {
        continue
      }
      const full = join(parent, entry.name)
      if (entry.name.startsWith('@')) {
        collect(full)
        continue
      }
      if (!existsSync(join(full, 'package.json'))) {
        continue
      }
      dirs.push(full)
      const nested = join(full, 'node_modules')
      if (existsSync(nested)) {
        collect(nested)
      }
    }
  }
  collect(root)
  return dirs
}

/** 按 Node 的嵌套优先、逐级回退规则建模裸说明符解析，用于可达性与闭包校验。 */
function deploymentIndex(root: string): DeploymentIndex {
  const dirs = packageDirs(root)
  const manifests = new Map<string, PackageManifest>()
  for (const dir of dirs) {
    manifests.set(dir, JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageManifest)
  }
  const resolveFrom = (fromDir: string, name: string): string | null => {
    let current = fromDir
    for (;;) {
      const candidate = current === root ? join(root, name) : join(current, 'node_modules', name)
      if (manifests.has(candidate)) {
        return candidate
      }
      if (current === root) {
        return null
      }
      const parent = dirname(current)
      if (parent === current) {
        return null
      }
      current = parent
    }
  }
  return { dirs, manifests, resolveFrom }
}

/** 可达性用宽松口径：可选 peer 也可能被动态 import，一律计入，只裁真正无人声明的包。 */
function reachabilityDependencies(manifest: PackageManifest): string[] {
  return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]
}

/** 校验用严格口径：显式依赖与必需 peer 必须可解析；可选 peer 允许缺席。 */
function requiredDependencies(manifest: PackageManifest): string[] {
  const meta = manifest.peerDependenciesMeta ?? {}
  const peers = Object.keys(manifest.peerDependencies ?? {}).filter(name => meta[name]?.optional !== true)
  return [...Object.keys(manifest.dependencies ?? {}), ...peers]
}

/** package.json 中 Node 侧会命中的入口；跳过类型/浏览器条件与通配模式。 */
function entryTargets(manifest: PackageManifest): string[] {
  const targets: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (!value.includes('*')) {
        targets.push(value.replace(/^\.\//, ''))
      }
      return
    }
    if (value === null || typeof value !== 'object') {
      return
    }
    const entries = Object.entries(value)
    if (entries.some(([key]) => key.startsWith('.'))) {
      for (const [key, child] of entries) {
        if (key.startsWith('.')) {
          walk(child)
        }
      }
      return
    }
    const runtime = entries.filter(([key]) => (RUNTIME_CONDITIONS as readonly string[]).includes(key))
    const selected = runtime.length > 0 ? runtime : entries.filter(([key]) => key === FALLBACK_CONDITION)
    for (const [, child] of selected) {
      walk(child)
    }
  }
  for (const key of ['main', 'module'] as const) {
    const value = manifest[key]
    if (typeof value === 'string' && !value.includes('*')) {
      targets.push(value.replace(/^\.\//, ''))
    }
  }
  walk(manifest.exports)
  return targets
}

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue
    }
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') {
        continue
      }
      collectFiles(full, out)
      continue
    }
    out.push(full)
  }
  return out
}

/** 版权与许可声明必须随包分发，其余说明性文档与 sourcemap、类型声明一律可裁。 */
function isNonRuntimeFile(rel: string): boolean {
  const name = basename(rel)
  if (ATTRIBUTION_BASENAMES.test(name)) {
    return false
  }
  if (DOCUMENTATION_BASENAMES.test(name) || DOCUMENTATION_EXTENSIONS.test(name)) {
    return true
  }
  return NON_RUNTIME_EXTENSIONS.some(pattern => pattern.test(rel))
}

function removeEmptyDirectories(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue
    }
    const full = join(root, entry.name)
    removeEmptyDirectories(full)
    if (readdirSync(full).length === 0) {
      rmSync(full, { recursive: true, force: true })
    }
  }
}

/** 相对说明符的落点：命中的文件本身，或作为目录落点时其整棵子树。 */
function relativeTarget(fromDir: string, specifier: string): string | null {
  const base = resolve(fromDir, specifier)
  if (existsSync(base) && statSync(base).isDirectory()) {
    return base
  }
  for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.json`, join(base, 'index.js'), join(base, 'index.cjs'), join(base, 'index.mjs')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }
  return null
}

/**
 * 裁剪运行期不会加载的文件。守护集必须同时覆盖 package.json 入口与所有相对
 * import/require 的落点——`debug@4` 的 main 就在 `src/` 下，`@kwsites/file-exists`
 * 的 `dist/index.js` 又 `require('./src')`，只看入口清单会把这些目录整片删掉。
 */
function pruneNonRuntimeFiles(root: string): number {
  const index = deploymentIndex(root)
  const inPruneSegment = (rel: string): boolean => {
    const segments = rel.split(sep)
    return segments.some((segment, i) => i < segments.length - 1 && PRUNE_SEGMENTS.has(segment))
  }
  const insideGuardedDir = (dirs: ReadonlySet<string>, rel: string): boolean => {
    const segments = rel.split(sep)
    for (let i = 1; i < segments.length; i++) {
      if (dirs.has(segments.slice(0, i).join(sep))) {
        return true
      }
    }
    return false
  }
  const guardInto = (files: Set<string>, dirs: Set<string>, path: string): void => {
    if (existsSync(path) && statSync(path).isDirectory()) {
      dirs.add(relative(root, path))
    }
    else {
      files.add(relative(root, path))
    }
  }
  const entryFiles = new Set<string>()
  const entryDirs = new Set<string>()
  for (const dir of index.dirs) {
    guardInto(entryFiles, entryDirs, join(dir, 'package.json'))
    for (const target of entryTargets(index.manifests.get(dir) as PackageManifest)) {
      guardInto(entryFiles, entryDirs, relativeTarget(dir, `./${target}`) ?? join(dir, target))
    }
  }
  let guardedFiles = entryFiles
  let guardedDirs = entryDirs
  // 收敛到不动点：守护集只能由「自身会存活」的文件贡献。否则被裁目录内的文件会互相
  // 引用而自我豁免（yaml 的 browser 构建整棵保留）。
  for (;;) {
    const survivors: string[] = []
    for (const dir of index.dirs) {
      for (const file of collectFiles(dir)) {
        if (!RUNTIME_FILE_PATTERN.test(file)) {
          continue
        }
        const rel = relative(root, file)
        if (guardedFiles.has(rel) || insideGuardedDir(guardedDirs, rel) || !inPruneSegment(rel)) {
          survivors.push(file)
        }
      }
    }
    const nextFiles = new Set(entryFiles)
    const nextDirs = new Set(entryDirs)
    for (const file of survivors) {
      for (const specifier of relativeSpecifiers(readFileSync(file, 'utf8'))) {
        const target = relativeTarget(dirname(file), specifier)
        if (target !== null) {
          guardInto(nextFiles, nextDirs, target)
        }
      }
    }
    const stable = nextFiles.size === guardedFiles.size && nextDirs.size === guardedDirs.size
    guardedFiles = nextFiles
    guardedDirs = nextDirs
    if (stable) {
      break
    }
  }
  const removable: string[] = []
  for (const dir of index.dirs) {
    for (const file of collectFiles(dir)) {
      const rel = relative(root, file)
      // 非运行期文件无条件裁剪：即便紧邻被守护的代码（如 require('.') 命中的包根），
      // Node 也不会去加载它们。
      if (isNonRuntimeFile(rel)) {
        removable.push(file)
        continue
      }
      if (inPruneSegment(rel) && !(guardedFiles.has(rel) || insideGuardedDir(guardedDirs, rel))) {
        removable.push(file)
      }
    }
  }
  for (const file of removable) {
    rmSync(file, { force: true })
  }
  removeEmptyDirectories(root)
  return removable.length
}

/**
 * 删除可达闭包之外的包副本。hoisted 布局把嵌套副本的依赖提升到顶层，嵌套副本一旦被
 * 排除就成了孤儿；而声明关系会连锁失效，故反复收敛到不动点。
 */
function pruneOrphanPackages(root: string, pluginNames: readonly string[]): string[] {
  const removed: string[] = []
  for (;;) {
    const index = deploymentIndex(root)
    const reachable = new Set<string>()
    const queue: string[] = []
    for (const name of pluginNames) {
      const dir = join(root, name)
      if (index.manifests.has(dir)) {
        reachable.add(dir)
        queue.push(dir)
      }
    }
    while (queue.length > 0) {
      const dir = queue.pop() as string
      for (const name of reachabilityDependencies(index.manifests.get(dir) as PackageManifest)) {
        const target = index.resolveFrom(dir, name)
        if (target !== null && !reachable.has(target)) {
          reachable.add(target)
          queue.push(target)
        }
      }
    }
    const orphans = index.dirs.filter(dir => !reachable.has(dir))
    if (orphans.length === 0) {
      return removed
    }
    for (const dir of orphans) {
      removed.push(relative(root, dir))
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** 裁剪可能删掉入口之外的内部模块（如 `require('./common')`），逐条验证相对说明符仍可解析。 */
function verifyRelativeSpecifiers(root: string): number {
  const missing: string[] = []
  let checked = 0
  for (const dir of packageDirs(root)) {
    const rel = relative(root, dir)
    if (RUNTIME_PROVIDED_SCOPES.some(scope => rel === scope || rel.startsWith(`${scope}${sep}`))) {
      continue
    }
    for (const file of collectFiles(dir)) {
      if (!RUNTIME_FILE_PATTERN.test(file)) {
        continue
      }
      for (const specifier of relativeSpecifiers(readFileSync(file, 'utf8'))) {
        checked++
        // `.node` 原生绑定是可选加载（ssh2 缺绑定时回退纯 JS，S1 决策显式
        // 阻断其原生构建），文件缺失不代表部署树不完整，跳过存在性校验。
        if (specifier.endsWith('.node'))
          continue
        if (relativeTarget(dirname(file), specifier) === null) {
          missing.push(`${relative(root, file)} -> ${specifier}`)
        }
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`PLUGIN_DEPLOY_RELATIVE_MISSING:\n  ${missing.join('\n  ')}`)
  }
  return checked
}

function verifyDeployedClosure(root: string): void {
  const index = deploymentIndex(root)
  for (const dir of index.dirs) {
    const manifest = index.manifests.get(dir) as PackageManifest
    for (const name of requiredDependencies(manifest)) {
      if (RUNTIME_PROVIDED_SCOPES.some(scope => name === scope || name.startsWith(`${scope}/`))) {
        continue
      }
      if (index.resolveFrom(dir, name) === null) {
        throw new Error(`PLUGIN_DEPLOY_DEPENDENCY_MISSING: ${relative(root, dir)} -> ${name}`)
      }
    }
    for (const target of entryTargets(manifest)) {
      if (relativeTarget(dir, `./${target}`) === null) {
        throw new Error(`PLUGIN_DEPLOY_ENTRY_MISSING: ${relative(root, join(dir, target))}`)
      }
    }
  }
}

/**
 * `pnpm deploy` 产出的是「npm 包原样」，含 sourcemap、类型声明、源码、测试与浏览器分支等
 * 运行期从不加载的内容（实测占产物近七成），而 Tauri 会把整棵树打进安装包。裁剪在
 * verifyMaterialized 之前完成，任一校验失败即中止，绝不留下半成品资源。
 */
function pruneDeployment(root: string, pluginNames: readonly string[]): void {
  for (const scope of RUNTIME_PROVIDED_SCOPES) {
    rmSync(join(root, scope), { recursive: true, force: true })
  }
  for (const subtree of DEAD_SUBTREES) {
    rmSync(join(root, subtree), { recursive: true, force: true })
  }
  const orphans = pruneOrphanPackages(root, pluginNames)
  const files = pruneNonRuntimeFiles(root)
  for (const name of DEPLOY_METADATA) {
    rmSync(join(root, name), { recursive: true, force: true })
  }
  removeEmptyDirectories(root)
  verifyDeployedClosure(root)
  const specifiers = verifyRelativeSpecifiers(root)
  console.log(`[build:plugins] pruned ${orphans.length} orphan packages and ${files} non-runtime files (${specifiers} relative specifiers verified)`)
}

function main(): void {
  const names = bundledPackageNames()
  // 先生成最新 dist，再打包 production 闭包。部署到独立临时目录并校验通过后，
  // 才把自包含的 node_modules 落到 `resources/node_modules`：任一环节失败即中止，
  // 绝不留下半成品资源。
  run([
    '--filter',
    './packages/*',
    '--filter',
    '!dsh-tauri-bundle',
    '--filter',
    '!dsh-tauri-tsdown',
    '-r',
    'run',
    'build',
  ])

  // pnpm v10 的 deploy 默认命中「legacy」算法：把产物链接到全局共享存储，导致部署出
  // 来的 node_modules 混入整个 workspace 的生产依赖（桌面壳的 React/UI 栈全部冗余）。
  // 改为现代「注入式」deploy（`--config.inject-workspace-packages=true`），只把 bundle 的
  // workspace 依赖及其真实生产闭包注入产物，得到紧凑可移植的 node_modules。
  // 但注入式默认仍是 isolated 布局：第三方依赖收进 `.pnpm/<dep>@<ver>/` 虚拟仓库，
  // 各插件靠虚拟仓库条目内的同级链接解析。materializeTree 把顶层插件符号链接解引用成
  // 实体目录时会丢掉这些同级依赖链接，产物里插件 `dist/index.js` 的裸 import（pathe /
  // unstorage 等）随之解析失败。改用 hoisted 布局（`--config.node-linker=hoisted`）让依赖
  // 平铺到顶层 node_modules，产物即自包含可解析，也彻底绕开符号链接。
  // 目标必须是空目录（src-tauri/resources 内含下发清单，不能直接部署）且为相对路径，
  // 因此先部署到仓库内相对临时目录，再把自包含的 node_modules 落入 resources/node_modules。
  const deployTarget = '.build-plugins-tmp'
  const temp = join(REPO_ROOT, deployTarget)
  rmSync(temp, { recursive: true, force: true })
  rmSync(DEPLOYED_NODE_MODULES, { recursive: true, force: true })
  try {
    run([
      '--filter',
      'dsh-tauri-bundle',
      'deploy',
      '--prod',
      '--config.inject-workspace-packages=true',
      '--config.node-linker=hoisted',
      deployTarget,
    ])
    const deployed = join(temp, 'node_modules')
    if (!existsSync(deployed)) {
      throw new Error(`PLUGIN_DEPLOY_EMPTY: pnpm deploy did not produce node_modules at ${deployed}`)
    }
    materializeTree(deployed, DEPLOYED_NODE_MODULES)
    pruneDeployment(DEPLOYED_NODE_MODULES, names)
    verifyMaterialized(DEPLOYED_NODE_MODULES)
    console.log(`[build:plugins] deployed ${names.length} plugins to ${RESOURCE_ROOT}`)
  }
  catch (error) {
    // 部署失败则清理半成品，避免残留误导；成功时保留供 Tauri 打包。
    rmSync(DEPLOYED_NODE_MODULES, { recursive: true, force: true })
    throw error
  }
  finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

const entryPoint = process.argv[1]
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  try {
    main()
  }
  catch (error) {
    console.error(`[build:plugins] ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  }
}
