import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// 离线安装包（offline bundle）构建元数据。版本号、资产名与下载前缀全部取自
// `src-tauri/src/config/constants.rs` 与 `src-tauri/resources/manifest.jsonc`，
// 不在 workflow 或本脚本里另抄一份常量。

const DSH_PKG_REPO = 'dsh-tauri-desk/deepseek-harness-pkg'
const DSH_LATEST_DOWNLOAD_SEGMENT = 'releases/latest/download/'
const RESOURCES_TOKEN = '$Resources'

/** 随包资源目录名（= `src-tauri/resources/<dir>`，也是清单 `$Resources/<dir>` 的落点）。 */
const BUNDLED_DIRS = { node: 'node', pnpm: 'pnpm', dsh: 'dsh', git: 'git' }

function bundleError(message, cause) {
  const error = new Error(`BUNDLE_METADATA: ${message}`)
  if (cause !== undefined)
    error.cause = cause
  return error
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0)
    throw bundleError(`${label} must be a non-empty string`)
  return value
}

/** 解析 `constants.rs` 里的字符串常量（`pub const NAME: &str = "value";`）。 */
function readRustStringConst(source, name) {
  const pattern = new RegExp(`pub const ${name}:\\s*&str\\s*=\\s*"([^"]*)"`)
  const match = pattern.exec(source)
  if (!match)
    throw bundleError(`constants.rs is missing string const ${name}`)
  return match[1]
}

/**
 * 去 JSONC 注释与尾逗号（与 `config::manifest::strip_jsonc` 等价）。
 *
 * 引号内的 `//`、`/*` 原样保留，转义字符不参与判定。
 */
export function stripJsonc(raw) {
  let out = ''
  let inString = false
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i]
    if (inString) {
      out += char
      if (char === '\\') {
        out += raw[i + 1] ?? ''
        i += 1
      }
      else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n')
        i += 1
      continue
    }
    if (char === '/' && raw[i + 1] === '*') {
      i += 2
      while (i + 1 < raw.length && !(raw[i] === '*' && raw[i + 1] === '/'))
        i += 1
      i += 1
      continue
    }
    if (char === ',') {
      let next = i + 1
      while (next < raw.length && /\s/.test(raw[next]))
        next += 1
      if (raw[next] === '}' || raw[next] === ']')
        continue
    }
    out += char
  }
  return out
}

function manifestPath(repo) {
  return path.join(repo, 'src-tauri', 'resources', 'manifest.jsonc')
}

/** 读取并解析资源清单（JSONC）。 */
export function readManifest(repo = process.cwd()) {
  const file = manifestPath(repo)
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  }
  catch (error) {
    throw bundleError(`cannot read ${file}`, error)
  }
  try {
    return JSON.parse(stripJsonc(raw.replace(/^\uFEFF/, '')))
  }
  catch (error) {
    throw bundleError(`cannot parse ${file}`, error)
  }
}

/** 资源清单中的推荐核心版本（`engines.dsh.recommend`）。 */
export function readRecommendedDshVersion(repo = process.cwd()) {
  const manifest = readManifest(repo)
  const version = typeof manifest?.engines?.dsh?.recommend === 'string'
    ? manifest.engines.dsh.recommend.trim()
    : ''
  if (!version)
    throw bundleError('manifest.jsonc is missing engines.dsh.recommend')
  return version
}

/** 从 release tag 解析版本号，与 Rust `download::parse_version_from_tag` 等价。 */
export function parseVersionFromTag(tag) {
  if (typeof tag !== 'string')
    return null
  const hasDshPrefix = tag.startsWith('dsh-')
  let rest = hasDshPrefix ? tag.slice(4) : tag
  if (rest.startsWith('src-')) {
    rest = rest.slice(4)
    if (hasDshPrefix) {
      const cut = rest.lastIndexOf('-')
      if (cut < 0)
        return null
      rest = rest.slice(0, cut)
    }
    return rest.length > 0 ? rest : null
  }
  if (!hasDshPrefix)
    return null
  const cut = rest.lastIndexOf('-')
  if (cut < 0)
    return null
  rest = rest.slice(0, cut)
  return rest.length > 0 ? rest : null
}

/** Node.js 官方发行包资产名（与 `config::runtime::node_pkg_filename` 一致）。 */
export function nodeAssetName(platform, arch, version) {
  const os = platform === 'macos' ? 'darwin' : platform === 'windows' ? 'win' : 'linux'
  // 与 Rust 一致：Windows 只提供 x64 发行包（arm64 主机走 x64 模拟）。
  const cpu = platform === 'windows' ? 'x64' : arch
  const ext = platform === 'windows' ? 'zip' : 'tar.gz'
  return `node-v${version}-${os}-${cpu}.${ext}`
}

/** deepseek-harness-pkg 发行资产名（与 `config::runtime::dsh_pkg_asset_filename` 一致）。 */
export function dshAssetName(platform, arch) {
  if (platform === 'windows')
    return 'deepseek-harness-pkg-windows.zip'
  if (platform === 'linux')
    return arch === 'arm64' ? 'deepseek-harness-pkg-linux-arm64.zip' : 'deepseek-harness-pkg-linux.zip'
  return arch === 'arm64' ? 'deepseek-harness-pkg-macos-arm64.zip' : 'deepseek-harness-pkg-macos-x64.zip'
}

/** MinGit 免安装发行包资产名（与 `config::runtime::mingit_pkg_filename` 一致）。 */
export function mingitAssetName(arch, version) {
  if (arch === 'arm64')
    return `MinGit-${version}-arm64.zip`
  if (arch === 'x64')
    return `MinGit-${version}-64-bit.zip`
  throw bundleError(`MinGit is not available for windows ${arch}`)
}

/** 收集仓库内的构建常量（Node / pnpm / MinGit 与各自的下载前缀）。 */
export function readBuildConstants(repo = process.cwd()) {
  const constantsPath = path.join(repo, 'src-tauri', 'src', 'config', 'constants.rs')
  let source
  try {
    source = readFileSync(constantsPath, 'utf8')
  }
  catch (error) {
    throw bundleError(`cannot read ${constantsPath}`, error)
  }
  return {
    nodeVersion: readRustStringConst(source, 'NODE_VERSION').replace(/^v/, ''),
    nodeBaseUrl: readRustStringConst(source, 'NODE_BASE_URL'),
    pnpmVersion: readRustStringConst(source, 'PNPM_VERSION'),
    pnpmBaseUrl: readRustStringConst(source, 'PNPM_BASE_URL'),
    pnpmSha256: readRustStringConst(source, 'PNPM_SHA256'),
    mingitVersion: readRustStringConst(source, 'MINGIT_VERSION'),
    mingitBaseUrl: readRustStringConst(source, 'MINGIT_BASE_URL'),
    mingitX64Sha256: readRustStringConst(source, 'MINGIT_X64_SHA256'),
    mingitArm64Sha256: readRustStringConst(source, 'MINGIT_ARM64_SHA256'),
    dshCoreUrl: readRustStringConst(source, 'DSH_CORE_URL'),
  }
}

/**
 * 随包依赖键。
 *
 * 默认只随包 Node / pnpm / 内核三项：MinGit 约 35 MiB，而绝大多数 Windows 机器已有
 * 可用的系统 Git，内网补装又必然失败（应用侧据「随包资源」构建放宽 Git 就绪判定，
 * 见 `config::dependencies::is_bundled_install`）。确有需要时用 `--with-git` 显式开启。
 */
export function bundleTargets(platform, { withGit = false } = {}) {
  const keys = ['node', 'pnpm', 'dsh']
  if (platform === 'windows' && withGit)
    keys.push('git')
  return keys
}

/**
 * 按平台/架构列出离线包需要下载的全部资产。
 *
 * `sha256` 为构建期已知的固定摘要（pnpm / MinGit，取自 constants.rs），`sha256Url`
 * 为需要单独下载的摘要来源（Node 官方 SHASUMS256.txt）；dsh 的摘要在下载后经
 * GitHub Release API 读取（见 workflow）。
 */
export function bundleAssets({ platform, arch, constants, dshTag, withGit = false }) {
  const nodeName = nodeAssetName(platform, arch, constants.nodeVersion)
  const dshName = dshAssetName(platform, arch)
  const assets = {
    node: {
      name: nodeName,
      url: `${constants.nodeBaseUrl}v${constants.nodeVersion}/${nodeName}`,
      sha256: '',
      sha256Url: `${constants.nodeBaseUrl}v${constants.nodeVersion}/SHASUMS256.txt`,
    },
    pnpm: {
      name: `pnpm-${constants.pnpmVersion}.tgz`,
      url: `${constants.pnpmBaseUrl}pnpm-${constants.pnpmVersion}.tgz`,
      sha256: constants.pnpmSha256,
      sha256Url: '',
    },
    dsh: {
      name: dshName,
      url: `${constants.dshCoreUrl.replace(DSH_LATEST_DOWNLOAD_SEGMENT, `releases/download/${dshTag}/`)}${dshName}`,
      sha256: '',
      sha256Url: '',
    },
  }
  if (platform === 'windows' && withGit) {
    const name = mingitAssetName(arch, constants.mingitVersion)
    assets.git = {
      name,
      url: `${constants.mingitBaseUrl}${name}`,
      sha256: arch === 'arm64' ? constants.mingitArm64Sha256 : constants.mingitX64Sha256,
      sha256Url: '',
    }
  }
  return assets
}

/**
 * 把资产表渲染成逐行 `|` 分隔的文本供 composite action 解析。
 *
 * 刻意不用 TAB：bash 的 `read` 在 IFS 只含空白字符时会把连续分隔符折叠成一个、
 * 并剥掉首尾分隔符，空字段（如 Node 没有固定 sha256）会串位。`|` 不属于空白
 * 字符，空字段因此能被如实保留。资产名与 URL 都不会包含 `|`。
 */
export function toAssetTable(assets) {
  return Object.entries(assets)
    .map(([key, asset]) => [key, asset.name, asset.url, asset.sha256 ?? '', asset.sha256Url ?? ''].join('|'))
    .join('\n')
}

/**
 * 把清单里的依赖托管根改写成 `$Resources/<dir>`。
 *
 * 离线包把运行时随安装包分发，`managedRoot` 必须指向安装包资源目录。
 *
 * `overridable` 按依赖区分：
 * - Node / pnpm（以及可选的 MinGit）置 false：它们固定随包，本机既有的
 *   `dependencies.json` 记录（旧的非离线安装留下、可能已被删除）不该盖过随包资源；
 * - 内核保持 true：随包内核是核心面板里置顶的「本地」项，用户要能下载并切换到
 *   AppData 里的其它版本，也能切回来——切换正是通过依赖映射表实现的。
 *
 * 改写结果直接写回 `src-tauri/resources/manifest.jsonc`（构建产物，不提交），
 * 因此注释与缩进按 JSON 重新序列化。未随包的依赖（默认的 MinGit）保持清单原值，
 * 不能指向并不存在的 `$Resources/git`。
 */
export function applyBundleManifest({ repo = process.cwd(), platform, withGit = false } = {}) {
  if (!['windows', 'macos', 'linux'].includes(platform))
    throw bundleError(`platform must be windows|macos|linux, got ${JSON.stringify(platform)}`)
  const manifest = readManifest(repo)
  const dependencies = manifest?.dependencies
  if (!dependencies || typeof dependencies !== 'object')
    throw bundleError('manifest.jsonc is missing the dependencies section')

  const applied = []
  for (const key of bundleTargets(platform, { withGit })) {
    const spec = dependencies[key]
    if (!spec || typeof spec !== 'object')
      throw bundleError(`manifest.jsonc is missing dependencies.${key}`)
    const managedRoot = `${RESOURCES_TOKEN}/${BUNDLED_DIRS[key]}`
    spec.managedRoot = managedRoot
    spec.overridable = key === 'dsh'
    applied.push(`${key} -> ${managedRoot} (overridable: ${spec.overridable})`)
  }

  const file = manifestPath(repo)
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { file, applied }
}

/** 解析 GitHub Release 响应中版本号命中推荐版本的 tag（与 Rust 侧版本解析同源）。 */
export function findReleaseTag(releases, version) {
  if (!Array.isArray(releases))
    throw bundleError('GitHub releases response is not an array')
  const release = releases.find(item => parseVersionFromTag(item?.tag_name) === version)
  if (!release)
    throw bundleError(`no ${DSH_PKG_REPO} release found for version ${version}`)
  return requireString(release.tag_name, 'release tag_name')
}

async function githubJson(url) {
  const headers = {
    'accept': 'application/vnd.github+json',
    'user-agent': 'deepseek-harness-desktop-bundle',
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (token)
    headers.authorization = `Bearer ${token}`
  const response = await fetch(url, { headers })
  if (!response.ok)
    throw bundleError(`GitHub API ${url} responded ${response.status}`)
  return response.json()
}

/** 按推荐版本反查 pkg 仓库的固定 tag。 */
export async function resolveDshTag(version, fetchJson = githubJson) {
  const releases = await fetchJson(
    `https://api.github.com/repos/${DSH_PKG_REPO}/releases?per_page=100`,
  )
  return findReleaseTag(releases, version)
}

function appendOutputs(outputPath, values) {
  if (!outputPath)
    throw bundleError('GITHUB_OUTPUT is missing')
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`)
  appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8')
}

function parseArgs(argv) {
  const args = { assets: false, manifest: false, platform: '', arch: '', withGit: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--assets')
      args.assets = true
    else if (arg === '--manifest')
      args.manifest = true
    else if (arg === '--with-git')
      args.withGit = true
    else if (arg === '--platform')
      args.platform = argv[++i] ?? ''
    else if (arg === '--arch')
      args.arch = argv[++i] ?? ''
    else
      throw bundleError(`unknown argument ${arg}`)
  }
  return args
}

function requirePlatformArch(args) {
  if (!['windows', 'macos', 'linux'].includes(args.platform))
    throw bundleError(`--platform must be windows|macos|linux, got ${JSON.stringify(args.platform)}`)
  if (!['x64', 'arm64'].includes(args.arch))
    throw bundleError(`--arch must be x64|arm64, got ${JSON.stringify(args.arch)}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const repo = process.env.GITHUB_WORKSPACE || process.cwd()
  const constants = readBuildConstants(repo)
  const dshVersion = readRecommendedDshVersion(repo)

  if (args.assets) {
    requirePlatformArch(args)
    const dshTag = requireString(process.env.DSH_TAG || '', 'DSH_TAG environment variable')
    process.stdout.write(`${toAssetTable(bundleAssets({ platform: args.platform, arch: args.arch, constants, dshTag, withGit: args.withGit }))}\n`)
    return
  }

  if (args.manifest) {
    requirePlatformArch(args)
    const { file, applied } = applyBundleManifest({ repo, platform: args.platform, withGit: args.withGit })
    process.stdout.write(`${file}\n${applied.map(line => `  ${line}`).join('\n')}\n`)
    return
  }

  const dshTag = await resolveDshTag(dshVersion)
  appendOutputs(process.env.GITHUB_OUTPUT, {
    node_version: constants.nodeVersion,
    pnpm_version: constants.pnpmVersion,
    mingit_version: constants.mingitVersion,
    dsh_version: dshVersion,
    dsh_tag: dshTag,
  })
}

const entryPoint = process.argv[1]
if (entryPoint && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  try {
    await main()
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message.startsWith('BUNDLE_METADATA:') ? message : `BUNDLE_METADATA: ${message}`)
    process.exitCode = 1
  }
}

export {
  BUNDLED_DIRS,
  DSH_PKG_REPO,
}
