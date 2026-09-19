import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// 离线安装包（offline bundle）构建元数据：版本号与资产名必须与 Rust 侧
// （src-tauri/src/config/constants.rs、config::runtime 的资产命名）保持同源，
// 因此这里直接解析 constants.rs，而不是在 workflow 里再抄一份常量。

const DSH_PKG_REPO = 'dsh-tauri-desk/deepseek-harness-pkg'
const DSH_PKG_RELEASE_BASE = `https://github.com/${DSH_PKG_REPO}/releases/download`
const NODE_BASE_URL = 'https://nodejs.org/dist'
const PNPM_BASE_URL = 'https://registry.npmjs.org/pnpm/-/'

function bundleError(message, cause) {
  const error = new Error(`BUNDLE_METADATA: ${message}`)
  if (cause !== undefined)
    error.cause = cause
  return error
}

/** 解析 `constants.rs` 里的字符串常量（`pub const NAME: &str = "value";`）。 */
function readRustStringConst(source, name) {
  const pattern = new RegExp(`pub const ${name}:\\s*&str\\s*=\\s*"([^"]*)"`)
  const match = pattern.exec(source)
  if (!match)
    throw bundleError(`constants.rs is missing string const ${name}`)
  return match[1]
}

/** 从 release tag 解析版本号，与 Rust `download::parse_version_from_tag` 等价。 */
function parseVersionFromTag(tag) {
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
function nodeAssetName(platform, arch, version) {
  const os = platform === 'macos' ? 'darwin' : platform === 'windows' ? 'win' : 'linux'
  // 与 Rust 一致：Windows 只提供 x64 发行包（arm64 主机走 x64 模拟）。
  const cpu = platform === 'windows' ? 'x64' : arch
  const ext = platform === 'windows' ? 'zip' : 'tar.gz'
  return `node-v${version}-${os}-${cpu}.${ext}`
}

/** deepseek-harness-pkg 发行资产名（与 `config::runtime::dsh_pkg_asset_filename` 一致）。 */
function dshAssetName(platform, arch) {
  if (platform === 'windows')
    return 'deepseek-harness-pkg-windows.zip'
  if (platform === 'linux')
    return 'deepseek-harness-pkg-linux.zip'
  return arch === 'arm64' ? 'deepseek-harness-pkg-macos-arm64.zip' : 'deepseek-harness-pkg-macos-x64.zip'
}

/** 收集仓库内的构建常量（Node / pnpm）。 */
function readBuildConstants(repo = process.cwd()) {
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
    pnpmVersion: readRustStringConst(source, 'PNPM_VERSION'),
    pnpmSha256: readRustStringConst(source, 'PNPM_SHA256'),
  }
}

/** 读取应用资源中的推荐核心版本。 */
function readRecommendedDshVersion(repo = process.cwd()) {
  const file = path.join(repo, 'src-tauri', 'resources', 'version-recommend.json')
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  }
  catch (error) {
    throw bundleError(`cannot read ${file}`, error)
  }
  const version = typeof parsed?.dsh === 'string' ? parsed.dsh.trim() : ''
  if (!version)
    throw bundleError('version-recommend.json is missing a dsh version')
  return version
}

/**
 * 按平台/架构列出离线包需要下载的全部资产。
 *
 * `sha256Url` 为可选的“摘要来源”：Node 走官方 SHASUMS256.txt，pnpm 走
 * constants.rs 中固定的摘要；dsh 发行版的摘要在构建期通过 GitHub Release API
 * 读取（见 workflow 中的校验步骤）。MinGit 刻意不随包分发（见
 * `src-tauri/src/service/bundle`），因此不在资产列表内。
 */
function bundleAssets({ platform, arch, constants, dshVersion, dshTag }) {
  const nodeName = nodeAssetName(platform, arch, constants.nodeVersion)
  const dshName = dshAssetName(platform, arch)
  return {
    node: {
      name: nodeName,
      url: `${NODE_BASE_URL}/v${constants.nodeVersion}/${nodeName}`,
      sha256Url: `${NODE_BASE_URL}/v${constants.nodeVersion}/SHASUMS256.txt`,
    },
    dsh: {
      name: dshName,
      url: `${DSH_PKG_RELEASE_BASE}/${dshTag}/${dshName}`,
      version: dshVersion,
      tag: dshTag,
    },
    pnpm: {
      name: `pnpm-${constants.pnpmVersion}.tgz`,
      url: `${PNPM_BASE_URL}pnpm-${constants.pnpmVersion}.tgz`,
      sha256: constants.pnpmSha256,
    },
  }
}

/**
 * 把资产表渲染成逐行 `|` 分隔的文本供 composite action 解析。
 *
 * 刻意不用 TAB：bash 的 `read` 在 IFS 只含空白字符时会把连续分隔符折叠成一个、
 * 并剥掉首尾分隔符，空字段（dsh 没有 sha256/sha256Url）会串位。`|` 不属于空白
 * 字符，空字段因此能被如实保留。资产名与 URL 都不会包含 `|`。
 */
function toAssetTable(assets) {
  return ['node', 'dsh', 'pnpm']
    .map((key) => {
      const asset = assets[key]
      return [key, asset.name, asset.url, asset.sha256 ?? '', asset.sha256Url ?? ''].join('|')
    })
    .join('\n')
}

function appendOutputs(outputPath, values) {
  if (!outputPath)
    throw bundleError('GITHUB_OUTPUT is missing')
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`)
  appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8')
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

/** 按推荐版本反查 pkg 仓库的固定 tag 与提交标识。 */
async function resolveDshRelease(version, fetchJson = githubJson) {
  const releases = await fetchJson(
    `https://api.github.com/repos/${DSH_PKG_REPO}/releases?per_page=100`,
  )
  if (!Array.isArray(releases))
    throw bundleError('GitHub releases response is not an array')
  const release = releases.find(item => parseVersionFromTag(item.tag_name) === version)
  if (!release)
    throw bundleError(`no ${DSH_PKG_REPO} release found for version ${version}`)
  const commitish = typeof release.target_commitish === 'string' ? release.target_commitish : ''
  const commit = /^[0-9a-f]{40}$/i.test(commitish)
    ? commitish.toLowerCase()
    : (release.tag_name.match(/-(\d+)$/)?.[1] ?? '')
  return { tag: release.tag_name, commit }
}

function parseArgs(argv) {
  const args = { assets: false, manifest: false, platform: '', arch: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--assets')
      args.assets = true
    else if (arg === '--manifest')
      args.manifest = true
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

function requireDshTag() {
  const tag = process.env.DSH_TAG || ''
  if (!tag)
    throw bundleError('DSH_TAG environment variable is required')
  return tag
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const repo = process.env.GITHUB_WORKSPACE || process.cwd()
  const constants = readBuildConstants(repo)
  const dshVersion = readRecommendedDshVersion(repo)

  if (args.assets) {
    requirePlatformArch(args)
    const dshTag = requireDshTag()
    const assets = bundleAssets({ platform: args.platform, arch: args.arch, constants, dshVersion, dshTag })
    process.stdout.write(`${toAssetTable(assets)}\n`)
    return
  }

  if (args.manifest) {
    requirePlatformArch(args)
    const dshTag = requireDshTag()
    const manifest = {
      node: constants.nodeVersion,
      pnpm: constants.pnpmVersion,
      platform: args.platform,
      arch: args.arch,
      dsh: {
        version: dshVersion,
        tag: dshTag,
        commit: process.env.DSH_COMMIT || null,
      },
    }
    const target = path.join(repo, 'src-tauri', 'resources', 'bundle.json')
    writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    process.stdout.write(`${target}\n`)
    return
  }

  const release = await resolveDshRelease(dshVersion)
  await appendOutputs(process.env.GITHUB_OUTPUT, {
    node_version: constants.nodeVersion,
    pnpm_version: constants.pnpmVersion,
    pnpm_sha256: constants.pnpmSha256,
    mingit_version: constants.mingitVersion,
    dsh_version: dshVersion,
    dsh_tag: release.tag,
    dsh_commit: release.commit,
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
  bundleAssets,
  dshAssetName,
  nodeAssetName,
  parseVersionFromTag,
  readBuildConstants,
  readRecommendedDshVersion,
  resolveDshRelease,
  toAssetTable,
}
