import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const DSH_PKG_REPO = 'dsh-tauri-desk/deepseek-harness-pkg'
const DSH_LATEST_DOWNLOAD_SEGMENT = 'releases/latest/download/'
const RESOURCES_TOKEN = '$Resources'

const BUNDLED_DIRS = { pnpm: 'pnpm', dsh: 'dsh', git: 'git' }

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

function readRustStringConst(source, name) {
  const pattern = new RegExp(`pub const ${name}:\\s*&str\\s*=\\s*"([^"]*)"`)
  const match = pattern.exec(source)
  if (!match)
    throw bundleError(`constants.rs is missing string const ${name}`)
  return match[1]
}

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
  return path.join(repo, 'apps/desktop/src-tauri', 'resources', 'manifest.jsonc')
}

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

export function dshAssetName(platform, arch) {
  if (platform === 'windows')
    return arch === 'arm64' ? 'deepseek-harness-pkg-windows-arm64.asar.zip' : 'deepseek-harness-pkg-windows.asar.zip'
  if (platform === 'linux')
    return arch === 'arm64' ? 'deepseek-harness-pkg-linux-arm64.asar.zip' : 'deepseek-harness-pkg-linux.asar.zip'
  return arch === 'arm64' ? 'deepseek-harness-pkg-macos-arm64.asar.zip' : 'deepseek-harness-pkg-macos-x64.asar.zip'
}

export function dshArchiveName(platform, arch) {
  return dshAssetName(platform, arch).replace(/\.zip$/, '')
}

export function mingitAssetName(arch, version) {
  if (arch === 'arm64')
    return `MinGit-${version}-arm64.zip`
  if (arch === 'x64')
    return `MinGit-${version}-64-bit.zip`
  throw bundleError(`MinGit is not available for windows ${arch}`)
}

export function readBuildConstants(repo = process.cwd()) {
  const constantsPath = path.join(repo, 'apps/desktop/src-tauri', 'src', 'config', 'constants.rs')
  let source
  try {
    source = readFileSync(constantsPath, 'utf8')
  }
  catch (error) {
    throw bundleError(`cannot read ${constantsPath}`, error)
  }
  return {
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

export function bundleTargets(platform, { withGit = false } = {}) {
  const keys = ['pnpm', 'dsh']
  if (platform === 'windows' && withGit)
    keys.push('git')
  return keys
}

export function bundleAssets({ platform, arch, constants, dshTag, withGit = false }) {
  if (!isSupportedDshVersion(parseVersionFromTag(dshTag)))
    throw bundleError(`unsupported core tag ${dshTag}; expected 0.2.2 from rc.1`)
  const dshName = dshAssetName(platform, arch)
  const assets = {
    pnpm: {
      name: `pnpm-${constants.pnpmVersion}.tgz`,
      url: `${constants.pnpmBaseUrl}pnpm-${constants.pnpmVersion}.tgz`,
      sha256: constants.pnpmSha256,
    },
    dsh: {
      name: dshName,
      url: `${constants.dshCoreUrl.replace(DSH_LATEST_DOWNLOAD_SEGMENT, `releases/download/${dshTag}/`)}${dshName}`,
      sha256: '',
    },
  }
  if (platform === 'windows' && withGit) {
    const name = mingitAssetName(arch, constants.mingitVersion)
    assets.git = {
      name,
      url: `${constants.mingitBaseUrl}${name}`,
      sha256: arch === 'arm64' ? constants.mingitArm64Sha256 : constants.mingitX64Sha256,
    }
  }
  return assets
}

export function toAssetTable(assets) {
  return Object.entries(assets)
    .map(([key, asset]) => [key, asset.name, asset.url, asset.sha256 ?? ''].join('|'))
    .join('\n')
}

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

function isSupportedDshVersion(version) {
  return typeof version === 'string' && /^0\.2\.2(?:-rc\.[1-9]\d*)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
}

export async function resolveLatestStableDshTag(fetchJson = githubJson) {
  const releases = await fetchJson(
    `https://api.github.com/repos/${DSH_PKG_REPO}/releases?per_page=100`,
  )
  if (!Array.isArray(releases))
    throw bundleError('GitHub releases response is not an array')
  const requiredAssets = ['windows', 'macos', 'linux']
    .flatMap(platform => ['x64', 'arm64'].map(arch => dshAssetName(platform, arch)))
  const release = releases.find((item) => {
    if (item?.draft === true || item?.prerelease === true)
      return false
    const version = parseVersionFromTag(item?.tag_name)
    return isSupportedDshVersion(version)
      && requiredAssets.every(name => item.assets?.some(asset => asset.name === name
        && asset.state === 'uploaded' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest)))
  })
  if (!release)
    throw bundleError(`no stable 0.2.2 ${DSH_PKG_REPO} release with verified asar assets found`)
  return requireString(release.tag_name, 'release tag_name')
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
  const args = { assets: false, archive: false, manifest: false, platform: '', arch: '', withGit: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--assets')
      args.assets = true
    else if (arg === '--archive-name')
      args.archive = true
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

  if (args.assets) {
    requirePlatformArch(args)
    const dshTag = requireString(process.env.DSH_TAG || '', 'DSH_TAG environment variable')
    process.stdout.write(`${toAssetTable(bundleAssets({ platform: args.platform, arch: args.arch, constants, dshTag, withGit: args.withGit }))}\n`)
    return
  }

  if (args.archive) {
    requirePlatformArch(args)
    process.stdout.write(`${dshArchiveName(args.platform, args.arch)}\n`)
    return
  }

  if (args.manifest) {
    requirePlatformArch(args)
    const { file, applied } = applyBundleManifest({ repo, platform: args.platform, withGit: args.withGit })
    process.stdout.write(`${file}\n${applied.map(line => `  ${line}`).join('\n')}\n`)
    return
  }

  const dshTag = await resolveLatestStableDshTag()
  appendOutputs(process.env.GITHUB_OUTPUT, {
    pnpm_version: constants.pnpmVersion,
    mingit_version: constants.mingitVersion,
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
