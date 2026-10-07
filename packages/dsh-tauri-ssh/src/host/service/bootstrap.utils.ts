import type { Config } from '../config/schema'
import type { MachineProfile, SshMachineStage, SshSession } from '../types/index'
import type { BootstrapHooks, BootstrapLogLine, EnvCredentials, RemoteInstallPlan } from './bootstrap.types'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { messageOf } from '../../shared/error'
import { DEFAULT_REMOTE_PROFILE, REMOTE_ROOT } from '../config/constants'
import { assetMatrixFor, dshNpmTarballUrls, dshZipDownloadUrls, NODE_SHASUMS256_SHA256, NODE_VERSION, nodeDownloadUrls, nodeShasumUrls, parsePlatform, PNPM_SHA256, PNPM_VERSION, pnpmDownloadUrls } from '../utils/assets'
import { clientUrlsFromBootHtml, looksLikePluginBundle } from '../utils/boot-html'
import { shQuote } from '../utils/shell'
import { listGithubAssets, listGithubReleases, npmDistMetadata, parseGitHubRepo, pickReleaseTag, pkgRepoOf } from '../utils/version'

export const REMOTE_WEB_LOG = '.dsh/dsh-remote-web.log'

export const BOOTSTRAP_LOG_PREFIX = '::dsh '

const DSH_ZIP_ENTRY = 'node_modules/@deepseek-ai/dsh/lib/bin.js'

const DSH_NPM_ENTRY = 'lib/bin.js'

const PNPM_ENTRY = 'bin/pnpm.cjs'

const BOOTSTRAP_STAGES: Record<SshMachineStage, true> = {
  probe: true,
  download: true,
  verify: true,
  install: true,
  launch: true,
  ready: true,
  failed: true,
  auth: true,
  reconnect: true,
}

function isBootstrapStage(value: string): value is SshMachineStage {
  return (BOOTSTRAP_STAGES as Record<string, true | undefined>)[value] === true
}

export function parseBootstrapLine(chunk: string): BootstrapLogLine {
  const match = /^::dsh (\w+) (.*)$/u.exec(chunk)
  const stage = match?.[1]
  if (match === null || stage === undefined || !isBootstrapStage(stage))
    return { stage: 'install', line: chunk }
  return { stage, line: match[2] ?? '' }
}

export function createBootstrapLineDispatcher(onLine: (line: string) => void): { push: (chunk: string) => void, flush: () => void } {
  let pending = ''
  return {
    push(chunk: string): void {
      pending = `${pending}${chunk}`
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (line !== '')
          onLine(line)
      }
    },
    flush(): void {
      const line = pending
      pending = ''
      if (line !== '')
        onLine(line)
    },
  }
}

export function skippedVerificationSummary(notes: string[], skipLines: string[]): string {
  const items = [...new Set([...notes, ...skipLines].filter(item => item.includes('跳过')))]
  return items.length === 0 ? '' : `；跳过校验项: ${items.join('；')}`
}

export function normalizeNpmIntegrity(integrity: string | undefined): string | undefined {
  if (integrity === undefined)
    return undefined
  const sri = /^sha(256|512)-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity)
  if (sri !== null)
    return `sha${sri[1]}:${Buffer.from(sri[2] ?? '', 'base64').toString('hex')}`
  return integrity.startsWith('sha256:') || integrity.startsWith('sha512:') ? integrity : undefined
}

export async function planRemoteInstall(
  unameOut: string,
  config: Pick<Config, 'installRepo' | 'installRef'>,
  fetchers: {
    listReleases?: (repo: string) => Promise<{ tag: string, prerelease: boolean }[]>
    listAssets?: (repo: string, tag: string) => Promise<Array<{ name: string, url: string, digest?: string }>>
    npmDist?: (packageName: string, version: string) => Promise<{ url: string, mirrorUrl: string, integrity?: string }>
  } = {},
): Promise<RemoteInstallPlan> {
  const { os, arch } = parsePlatform(unameOut)
  const matrix = assetMatrixFor(os, arch)
  const repo = pkgRepoOf(config.installRepo)
  const notes: string[] = []
  const configuredRepo = config.installRepo?.trim()
  if (configuredRepo !== undefined && configuredRepo !== '' && parseGitHubRepo(configuredRepo) === undefined)
    notes.push(`installRepo "${configuredRepo}" 无法解析为 GitHub 仓库，回退官方发行仓 ${repo}`)
  const listReleases = fetchers.listReleases ?? listGithubReleases
  const listAssets = fetchers.listAssets ?? listGithubAssets
  const npmDist = fetchers.npmDist ?? npmDistMetadata
  let metas
  try {
    metas = await listReleases(repo)
  }
  catch (error) {
    notes.push(`release 列表获取失败（${messageOf(error)}）`)
  }
  const resolved = pickReleaseTag(metas, { ref: config.installRef })
  notes.push(...resolved.notes.map(note => `版本选择: ${note}`))
  const node = {
    urls: nodeDownloadUrls(os, arch),
    shasumUrls: nodeShasumUrls(),
    shasumSha256: NODE_SHASUMS256_SHA256,
    filename: matrix.nodeFilename,
    version: NODE_VERSION,
  }
  const pnpm = { urls: pnpmDownloadUrls(), sha256: PNPM_SHA256, version: PNPM_VERSION }
  if (matrix.dshKind === 'pkg-zip') {
    const zipName = matrix.dshZipName ?? ''
    let urls: string[] | undefined
    let digest: string | undefined
    try {
      const assets = await listAssets(repo, resolved.tag)
      const asset = assets.find(candidate => candidate.name === zipName)
      if (asset !== undefined) {
        urls = [asset.url, ...dshZipDownloadUrls(repo, resolved.tag, zipName).slice(1)]
        digest = asset.digest
      }
    }
    catch (error) {
      notes.push(`release 资产元数据获取失败（${messageOf(error)}）`)
    }
    if (digest === undefined)
      notes.push(`未取得 ${zipName} 的可信摘要，将跳过 SHA-256 校验；校验不了就不启用镜像`)
    const dshUrls = urls ?? dshZipDownloadUrls(repo, resolved.tag, zipName)
    return {
      os,
      arch,
      matrix,
      repo,
      dshEntry: DSH_ZIP_ENTRY,
      dshVersion: resolved.version,
      node,
      // 摘要缺失时脚本会跳过 SHA-256 校验：此时只留官方源，绝不额外放大可写入口。
      dsh: { kind: 'pkg-zip', urls: digest === undefined ? dshUrls.slice(0, 1) : dshUrls, ...digest === undefined ? {} : { digest }, zipName, tag: resolved.tag },
      pnpm,
      notes,
    }
  }
  const packageName = matrix.dshNpmPackage ?? '@deepseek-ai/dsh'
  if (resolved.version === '')
    throw new Error(`cannot resolve a DSH npm version from tag "${resolved.tag}"`)
  let urls: string[] | undefined
  let integrity: string | undefined
  try {
    const dist = await npmDist(packageName, resolved.version)
    urls = [...new Set([dist.url, dist.mirrorUrl])]
    integrity = normalizeNpmIntegrity(dist.integrity)
  }
  catch (error) {
    notes.push(`npm 元数据获取失败（${messageOf(error)}），回退确定性 URL`)
  }
  if (integrity === undefined)
    notes.push(`未取得 ${packageName}@${resolved.version} 的可校验完整性摘要，将跳过校验`)
  return {
    os,
    arch,
    matrix,
    repo,
    dshEntry: DSH_NPM_ENTRY,
    dshVersion: resolved.version,
    node,
    dsh: { kind: 'npm-tgz', urls: urls ?? dshNpmTarballUrls(packageName, resolved.version), ...integrity === undefined ? {} : { integrity }, packageName, version: resolved.version },
    pnpm,
    notes,
  }
}

function quoteUrls(urls: string[]): string {
  return urls.map(shQuote).join(' ')
}

export function buildInstallScript(plan: RemoteInstallPlan): string {
  const dshSection = plan.dsh.kind === 'pkg-zip'
    ? [
        `if [ -f "$ROOT/dependencies/dsh/${DSH_ZIP_ENTRY}" ]; then`,
        `  log install "dsh 已就绪"`,
        `else`,
        `  log download "dsh ${plan.dsh.tag}"`,
        `  fetch_verified "$TMP/dsh-pkg.zip" "${plan.dsh.digest ?? ''}" "${plan.dsh.zipName}" ${quoteUrls(plan.dsh.urls)}`,
        `  extract_zip "$TMP/dsh-pkg.zip" "$ROOT/dependencies/dsh.new"`,
        `  flatten_move "$ROOT/dependencies/dsh.new" "$ROOT/dependencies/dsh"`,
        `  log install "dsh 安装完成 (${plan.dsh.tag})"`,
        `fi`,
      ].join('\n')
    : [
        `install_dsh_deps() {`,
        `  for _reg in ${quoteUrls(['https://registry.npmjs.org', 'https://registry.npmmirror.com'])}; do`,
        `    if ( cd "$ROOT/dependencies/dsh" && "$ROOT/runtime/bin/node" "$ROOT/dependencies/pnpm/${PNPM_ENTRY}" install --prod --silent --registry="$_reg" >"$TMP/pnpm.log" 2>&1 ); then`,
        `      log install "dsh 依赖安装完成 (registry $_reg)"`,
        `      return 0`,
        `    fi`,
        `  done`,
        `  log failed "pnpm install 失败: $(tail -n 5 "$TMP/pnpm.log" 2>/dev/null | tr '\n' ' ')"`,
        `  return 1`,
        `}`,
        `if [ -f "$ROOT/dependencies/dsh/${DSH_NPM_ENTRY}" ]; then`,
        `  log install "dsh 已就绪"`,
        `else`,
        `  log download "dsh ${plan.dsh.packageName}@${plan.dsh.version} (npm)"`,
        `  fetch_verified "$TMP/dsh.tgz" "${plan.dsh.integrity ?? ''}" "${plan.dsh.packageName}-${plan.dsh.version}.tgz" ${quoteUrls(plan.dsh.urls)}`,
        `  rm -rf "$ROOT/dependencies/dsh.new"`,
        `  mkdir -p "$ROOT/dependencies/dsh.new"`,
        `  tar -xzf "$TMP/dsh.tgz" -C "$ROOT/dependencies/dsh.new" --strip-components=1`,
        `  flatten_move "$ROOT/dependencies/dsh.new" "$ROOT/dependencies/dsh"`,
        `  install_dsh_deps || exit 13`,
        `  log install "dsh 安装完成 (${plan.dsh.packageName}@${plan.dsh.version})"`,
        `fi`,
      ].join('\n')
  return [
    'set -eu',
    'ROOT="$HOME/.dsh-desktop"',
    'TMP="$ROOT/tmp"',
    'mkdir -p "$ROOT/dependencies" "$TMP"',
    'cleanup() { rm -rf "$TMP" "$ROOT/runtime.new" "$ROOT/dependencies/pnpm.new" "$ROOT/dependencies/dsh.new"; }',
    'trap cleanup EXIT',
    `log() { printf '${BOOTSTRAP_LOG_PREFIX}%s %s\\n' "$1" "$2"; }`,
    'fetch_one() {',
    '  _dst="$1"; _url="$2"',
    '  if command -v curl >/dev/null 2>&1; then',
    '    log download "$_url"',
    '    if curl -fsSL --retry 3 --connect-timeout 15 -o "$_dst" "$_url" 2>"$TMP/fetch.err"; then return 0; fi',
    '    _errs="$_errs | $_url: $(head -n 1 "$TMP/fetch.err" 2>/dev/null || echo download failed)"',
    '    return 1',
    '  fi',
    '  if command -v wget >/dev/null 2>&1; then',
    '    log download "$_url"',
    '    if wget -q --tries=3 -O "$_dst" "$_url" 2>/dev/null; then return 0; fi',
    '    _errs="$_errs | $_url: wget download failed"',
    '    return 1',
    '  fi',
    '  log failed "REMOTE_INSTALL_NO_DOWNLOADER: 远端缺少 curl 或 wget，请先安装其一"',
    '  exit 9',
    '}',
    'fetch() {',
    '  _dst="$1"; shift',
    '  _errs=""',
    '  for _url in "$@"; do',
    '    if fetch_one "$_dst" "$_url"; then return 0; fi',
    '  done',
    '  log failed "所有下载源均失败:$_errs"',
    '  exit 10',
    '}',
    'fetch_verified() {',
    '  _dst="$1"; _want="$2"; _name="$3"; shift 3',
    '  _errs=""',
    '  _mismatch=0',
    '  for _url in "$@"; do',
    '    if fetch_one "$_dst" "$_url"; then',
    '      if verify "$_dst" "$_want" "$_name"; then return 0; fi',
    '      _mismatch=1',
    '      log verify "改用下一个下载源: $_url"',
    '    fi',
    '  done',
    '  if [ "$_mismatch" = 0 ]; then',
    '    log failed "所有下载源均失败:$_errs"',
    '    exit 10',
    '  fi',
    '  log failed "checksum mismatch: $_name (want sha$_algo:$_hex, got $_got)"',
    '  exit 11',
    '}',
    'verify() {',
    '  _file="$1"; _want="$2"; _name="$3"',
    '  case "$_want" in',
    '    sha256:*) _algo=256; _hex="$(printf \'%s\' "$_want" | sed \'s/^sha256://\')" ;;',
    '    sha512:*) _algo=512; _hex="$(printf \'%s\' "$_want" | sed \'s/^sha512://\')" ;;',
    '    "") log verify "警告: 未取得可信摘要，跳过校验 $_name"; return 0 ;;',
    '    *) _algo=256; _hex="$_want" ;;',
    '  esac',
    '  _got=""',
    `  if [ "\$_algo" = 256 ]; then`,
    '    if command -v sha256sum >/dev/null 2>&1; then _got="$(sha256sum "$_file" | cut -d\' \' -f1)"',
    '    elif command -v shasum >/dev/null 2>&1; then _got="$(shasum -a 256 "$_file" | cut -d\' \' -f1)"',
    '    fi',
    '  else',
    '    if command -v sha512sum >/dev/null 2>&1; then _got="$(sha512sum "$_file" | cut -d\' \' -f1)"',
    '    elif command -v shasum >/dev/null 2>&1; then _got="$(shasum -a 512 "$_file" | cut -d\' \' -f1)"',
    '    fi',
    '  fi',
    '  if [ -z "$_got" ]; then',
    '    log verify "警告: 远端缺少摘要工具，跳过校验 $_name"',
    '    return 0',
    '  fi',
    '  if [ "$_got" != "$_hex" ]; then',
    '    log verify "校验不通过: $_name (want sha$_algo:$_hex, got $_got)"',
    '    return 1',
    '  fi',
    `  log verify "$_name 校验通过 (sha$_algo)"`,
    '}',
    'extract_zip() {',
    '  _zip="$1"; _dir="$2"',
    '  mkdir -p "$_dir"',
    '  if command -v unzip >/dev/null 2>&1; then unzip -q -o "$_zip" -d "$_dir"',
    '  elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e "$_zip" "$_dir"',
    '  else',
    '    log failed "REMOTE_INSTALL_NO_UNZIP: 远端缺少 unzip 或 python3，无法解压发行包"',
    '    exit 12',
    '  fi',
    '}',
    'flatten_move() {',
    '  _src="$1"; _dst="$2"',
    '  _count=0; _top=""',
    '  for _e in "$_src"/*; do',
    '    if [ -e "$_e" ]; then _count=$((_count + 1)); _top="$_e"; fi',
    '  done',
    '  rm -rf "$_dst"',
    '  if [ "$_count" -eq 1 ] && [ -d "$_top" ]; then',
    '    mkdir -p "$_dst"',
    '    for _e in "$_top"/* "$_top"/.[!.]* "$_top"/..?*; do',
    '      if [ -e "$_e" ]; then mv -f "$_e" "$_dst/"; fi',
    '    done',
    '    rmdir "$_top" 2>/dev/null || true',
    '    rmdir "$_src" 2>/dev/null || true',
    '  else',
    '    mv -f "$_src" "$_dst"',
    '  fi',
    '}',
    'if [ -x "$ROOT/runtime/bin/node" ]; then',
    '  log install "node 已就绪: $("$ROOT/runtime/bin/node" --version 2>/dev/null || echo installed)"',
    'else',
    `  log download "node ${plan.node.version}"`,
    `  fetch_verified "$TMP/SHASUMS256.txt" "sha256:${plan.node.shasumSha256}" "SHASUMS256.txt" ${quoteUrls(plan.node.shasumUrls)}`,
    `  _want="$(grep " ${plan.node.filename}\$" "$TMP/SHASUMS256.txt" | head -n 1 | tr -d '\\r' | sed 's/^ *//' | cut -d' ' -f1)"`,
    `  fetch_verified "$TMP/node.tar.gz" "\$_want" "${plan.node.filename}" ${quoteUrls(plan.node.urls)}`,
    '  rm -rf "$ROOT/runtime.new"',
    '  mkdir -p "$ROOT/runtime.new"',
    '  tar -xzf "$TMP/node.tar.gz" -C "$ROOT/runtime.new" --strip-components=1',
    '  flatten_move "$ROOT/runtime.new" "$ROOT/runtime"',
    `  log install "node 安装完成: $("$ROOT/runtime/bin/node" --version 2>/dev/null || echo ok)"`,
    'fi',
    `if [ -f "$ROOT/dependencies/pnpm/${PNPM_ENTRY}" ]; then`,
    '  log install "pnpm 已就绪"',
    'else',
    `  log download "pnpm ${plan.pnpm.version}"`,
    `  fetch_verified "$TMP/pnpm.tgz" "sha256:${plan.pnpm.sha256}" "pnpm-${plan.pnpm.version}.tgz" ${quoteUrls(plan.pnpm.urls)}`,
    '  rm -rf "$ROOT/dependencies/pnpm.new"',
    '  mkdir -p "$ROOT/dependencies/pnpm.new"',
    '  tar -xzf "$TMP/pnpm.tgz" -C "$ROOT/dependencies/pnpm.new" --strip-components=1',
    '  flatten_move "$ROOT/dependencies/pnpm.new" "$ROOT/dependencies/pnpm"',
    `  log install "pnpm 安装完成: ${plan.pnpm.version}"`,
    'fi',
    dshSection,
    'log install "远端初始化完成"',
  ].join('\n')
}

export function checkMissingCommand(): string {
  return [
    `ROOT="$HOME/${REMOTE_ROOT}"`,
    `[ -x "$ROOT/runtime/bin/node" ] || echo node`,
    `[ -f "$ROOT/dependencies/pnpm/${PNPM_ENTRY}" ] || echo pnpm`,
    `if [ ! -f "$ROOT/dependencies/dsh/${DSH_ZIP_ENTRY}" ] && [ ! -f "$ROOT/dependencies/dsh/${DSH_NPM_ENTRY}" ]; then echo dsh; fi`,
    'true',
  ].join('\n')
}

export function missingComponentsOf(stdout: string): string[] {
  return stdout.split('\n').map(line => line.trim()).filter(line => line !== '' && ['node', 'dsh', 'pnpm'].includes(line))
}

export function layoutDshEntry(plan?: RemoteInstallPlan): string {
  return `$HOME/${REMOTE_ROOT}/dependencies/dsh/${plan?.dshEntry ?? DSH_ZIP_ENTRY}`
}

export function layoutNodeBinary(): string {
  return `"$HOME/${REMOTE_ROOT}/runtime/bin/node"`
}

export function layoutBinDir(): string {
  return `$HOME/${REMOTE_ROOT}/runtime/bin`
}

export function ensurePnpmCommand(): string {
  const shim = `#!/bin/sh\nexec "$HOME/${REMOTE_ROOT}/runtime/bin/node" "$HOME/${REMOTE_ROOT}/dependencies/pnpm/${PNPM_ENTRY}" "$@"\n`
  return `B="${layoutBinDir()}"; [ -x "$B/pnpm" ] || { mkdir -p "$B" && printf %s ${shQuote(shim)} > "$B/pnpm" && chmod +x "$B/pnpm"; }`
}

export function dshEntryProbeCommand(): string {
  return [
    `ROOT="$HOME/${REMOTE_ROOT}"`,
    `if [ -f "$ROOT/dependencies/dsh/${DSH_ZIP_ENTRY}" ]; then printf '%s\\n' "$ROOT/dependencies/dsh/${DSH_ZIP_ENTRY}"`,
    `elif [ -f "$ROOT/dependencies/dsh/${DSH_NPM_ENTRY}" ]; then printf '%s\\n' "$ROOT/dependencies/dsh/${DSH_NPM_ENTRY}"`,
    'fi',
    'true',
  ].join('\n')
}

export function remoteWebTokenCommand(): string {
  return `grep -oE 'token=[A-Za-z0-9._~-]+' "$HOME/${REMOTE_WEB_LOG}" 2>/dev/null | tail -n 1 | cut -d= -f2`
}

export function safeProfileName(raw: string | undefined): string {
  return raw !== undefined && /^[\w-]+$/.test(raw) ? raw : DEFAULT_REMOTE_PROFILE
}

export function startCommandFor(profile: MachineProfile, plan?: RemoteInstallPlan): string {
  if (profile.startCommand !== undefined)
    return `mkdir -p "$HOME/.dsh" && ( ${profile.startCommand} >>"$HOME/${REMOTE_WEB_LOG}" 2>&1 < /dev/null & ) &`
  const node = `$HOME/${REMOTE_ROOT}/runtime/bin/node`
  const dshBin = layoutDshEntry(plan)
  const profileName = safeProfileName(profile.profileName)
  return [
    `ROOT="$HOME/${REMOTE_ROOT}"`,
    `NODE=${node}`,
    `DSH_BIN=${dshBin}`,
    `LOG_DIR="$HOME/.dsh"`,
    `LOG="$LOG_DIR/dsh-remote-web.log"`,
    `if [ ! -x "$NODE" ] || [ ! -f "$DSH_BIN" ]; then echo "REMOTE_NOT_INSTALLED: 远端三件套未安装完整"; exit 1; fi`,
    `mkdir -p "$LOG_DIR"`,
    `export PATH="$ROOT/runtime/bin:$PATH"`,
    `export DSH_TELEMETRY_DISABLED=1 NO_COLOR=1 DSH_WEB_PORT=${profile.remotePort}`,
    `export DSH_REMOTE_SESSION_ORIGIN=${shQuote(profile.name)}`,
    `( sh -c 'echo $$ > "$1/.dsh-remote.pid"; exec "$2" "$3" --profile "$5" --host 127.0.0.1 --port "$4" --no-open' dsh-remote "$LOG_DIR" "$NODE" "$DSH_BIN" ${profile.remotePort} ${profileName} </dev/null >>"$LOG" 2>&1 & )`,
    `echo "远端实例已拉起（档案: ${profileName}, 日志: $LOG）"`,
  ].join('\n')
}

export function readEnvCredentials(path: string): EnvCredentials {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  }
  catch {
    return {}
  }
  const out: EnvCredentials = {}
  const apiKey = envValueOf(text, 'DEEPSEEK_API_KEY')
  /* v8 ignore next -- attribution artifact: both arms are exercised by the credentials tests */
  if (apiKey !== undefined)
    out.apiKey = apiKey
  const baseUrl = envValueOf(text, 'DEEPSEEK_BASE_URL')
  if (baseUrl !== undefined)
    out.baseUrl = baseUrl
  return out
}

export function credentialsCopyCommand(credentials: EnvCredentials & { apiKey: string }): string {
  const managed = ['DEEPSEEK_API_KEY', ...(credentials.baseUrl === undefined ? [] : ['DEEPSEEK_BASE_URL'])]
  const writes = [`printf 'DEEPSEEK_API_KEY=%s\\n' ${shQuote(credentials.apiKey)}`]
  if (credentials.baseUrl !== undefined)
    writes.push(`printf 'DEEPSEEK_BASE_URL=%s\\n' ${shQuote(credentials.baseUrl)}`)
  const filter = managed.map(key => `^${key}=`).join('|')
  return [
    `mkdir -p "$HOME/.dsh"`,
    `if grep -q '^DEEPSEEK_API_KEY=' "$HOME/.dsh/.env" 2>/dev/null; then echo existing; else umask 077 && { grep -v -E '${filter}' "$HOME/.dsh/.env" 2>/dev/null || true; ${writes.join('; ')}; } > "$HOME/.dsh/.env.new" && mv -f "$HOME/.dsh/.env.new" "$HOME/.dsh/.env" && echo copied; fi`,
  ].join(' && ')
}

function envValueOf(text: string, key: string): string | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${key}=`))
      continue
    const value = line.slice(key.length + 1).trim().replace(/^"(.*)"$/u, '$1')
    return value === '' ? undefined : value
  }
  return undefined
}

export function firstLineOf(stdout: string): string {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '')
      return trimmed
  }
  return ''
}

export const REMOTE_PROBE_NO_DOWNLOADER = 'REMOTE_PROBE_NO_DOWNLOADER'

function withDownloaderFallback(curlArm: string, wgetArm: string): string {
  return [
    `if [ -n "$(command -v curl)" ]; then ${curlArm}`,
    `elif [ -n "$(command -v wget)" ]; then ${wgetArm}`,
    `else echo "${REMOTE_PROBE_NO_DOWNLOADER}: 远端缺少 curl 与 wget，无法探测就绪状态" >&2; exit 1; fi`,
  ].join('; ')
}

export function rootProbeCommand(remotePort: number, timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  return withDownloaderFallback(
    `curl -s -m ${seconds} http://127.0.0.1:${remotePort}/`,
    `wget -q -T ${seconds} -O - http://127.0.0.1:${remotePort}/; case $? in 0|6|8) ;; *) exit 1 ;; esac`,
  )
}

export function bundleProbeCommand(url: string, timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  return withDownloaderFallback(
    `curl -s -m ${seconds} -w '\\n%{http_code}' ${shQuote(url)}`,
    `wget -q -T ${seconds} -O - ${shQuote(url)} && printf '\\n200\\n' || printf '\\n0\\n'`,
  )
}

export function splitBundleProbeStdout(stdout: string): { body: string, status: number } {
  const trimmed = stdout.replace(/\n$/u, '')
  const index = trimmed.lastIndexOf('\n')
  if (index < 0) {
    const status = Number.parseInt(trimmed, 10)
    return Number.isNaN(status) ? { body: trimmed, status: 0 } : { body: '', status }
  }
  const status = Number.parseInt(trimmed.slice(index + 1).trim(), 10)
  return Number.isNaN(status) ? { body: trimmed, status: 0 } : { body: trimmed.slice(0, index), status }
}

export function logTailCommand(): string {
  return `tail -n 20 "$HOME/${REMOTE_WEB_LOG}" 2>/dev/null || true`
}

export function describeExecFailure(code: number | null, stderr: string): string {
  const tail = stderr.trim().split('\n').slice(-3).join(' | ')
  return `exit ${code ?? '?'}${tail === '' ? '' : `: ${tail}`}`
}

export async function ensureRemoteInstance(
  session: SshSession,
  profile: MachineProfile,
  config: Config,
  hooks: BootstrapHooks = {},
): Promise<string> {
  const { onEvent, onProgress } = hooks
  const target = `${profile.host}:${profile.remotePort}`
  const readyFromHtml = await judgeReadiness(session, profile, config)
  if (readyFromHtml !== undefined) {
    emitReady(onEvent, target, readyFromHtml)
    return target
  }
  onEvent?.('probe', '探测远端平台 (uname -srm)')
  const uname = await session.exec('uname -srm')
  if (uname.code !== 0) {
    return failBootstrap(onEvent, `无法探测远端平台: ${describeExecFailure(uname.code, uname.stderr)}`)
  }
  let plan: RemoteInstallPlan
  try {
    plan = await planRemoteInstall(uname.stdout, config)
  }
  catch (error) {
    return failBootstrap(onEvent, messageOf(error))
  }
  onEvent?.('probe', `远端平台 ${plan.os}/${plan.arch}，安装源 ${plan.repo}${plan.dsh.kind === 'pkg-zip' ? ` tag ${plan.dsh.tag}` : ` npm ${plan.dsh.version}`}`)
  for (const note of plan.notes)
    onEvent?.('probe', note)
  const missing = missingComponentsOf((await session.exec(checkMissingCommand())).stdout)
  let skips: string[] = []
  if (missing.length > 0) {
    onEvent?.('probe', `缺失组件: ${missing.join(', ')}`)
    skips = await runInstallScript(session, plan, config.installTimeoutMs!, hooks)
  }
  else {
    onEvent?.('probe', '三件套已就绪，跳过安装')
  }
  const skipSummary = skippedVerificationSummary(plan.notes, skips)
  onProgress?.({ phase: 'starting' })
  onEvent?.('launch', `拉起远端实例 (端口 ${profile.remotePort})`)
  const started = await session.exec(startCommandFor(profile, plan))
  if (started.code !== 0) {
    const message = started.stdout.includes('REMOTE_NOT_INSTALLED')
      ? `remote runtime incomplete on "${profile.host}" (REMOTE_NOT_INSTALLED)`
      : `remote instance start failed on "${profile.host}": ${describeExecFailure(started.code, started.stderr)}`
    return failBootstrap(onEvent, message)
  }
  for (let attempt = 0; attempt < config.healthPollAttempts; attempt++) {
    onProgress?.({ phase: 'probing', attempt: attempt + 1, total: config.healthPollAttempts })
    await sleep(config.healthPollIntervalMs)
    const verdict = await judgeReadiness(session, profile, config)
    if (verdict !== undefined) {
      emitReady(onEvent, target, verdict, skipSummary)
      return target
    }
  }
  const tail = await logTail(session)
  return failBootstrap(
    onEvent,
    `remote dsh web did not become ready on "${target}" within ${config.healthPollAttempts} polls; `
    + `fallback probe: root ${await legacyRootVerdict(session, profile, config)}; `
    + `remote log tail: ${tail}`,
  )
}

async function judgeReadiness(session: SshSession, profile: MachineProfile, config: Config): Promise<string | undefined> {
  const root = await session.exec(rootProbeCommand(profile.remotePort, config.healthCheckTimeoutMs))
  if (root.code !== 0)
    return undefined
  const urls = clientUrlsFromBootHtml(profile.remotePort, root.stdout)
  if (urls === undefined) {
    return await legacyRootVerdict(session, profile, config)
  }
  const first = urls[0]
  if (first === undefined)
    return undefined
  const probe = await session.exec(bundleProbeCommand(first, config.healthCheckTimeoutMs))
  const { body, status } = splitBundleProbeStdout(probe.stdout)
  if (probe.code === 0 && status >= 200 && status < 300 && looksLikePluginBundle(true, body))
    return `boot manifest (${urls.length} bundles)`
  return undefined
}

export function legacyProbeCommand(remotePort: number, timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  return [
    `if [ -n "$(command -v curl)" ]; then curl -s -o /dev/null -m ${seconds} -w '%{http_code}' http://127.0.0.1:${remotePort}/`,
    `elif [ -n "$(command -v wget)" ]; then wget -q -T ${seconds} -O /dev/null http://127.0.0.1:${remotePort}/; case $? in 0) echo 200 ;; 6|8) echo 4xx/5xx ;; *) exit 1 ;; esac`,
    `else echo ${REMOTE_PROBE_NO_DOWNLOADER}; fi`,
  ].join('; ')
}

async function legacyRootVerdict(session: SshSession, profile: MachineProfile, config: Config): Promise<string> {
  const probe = await session.exec(legacyProbeCommand(profile.remotePort, config.healthCheckTimeoutMs))
  if (probe.stdout.includes(REMOTE_PROBE_NO_DOWNLOADER))
    return `no downloader (${REMOTE_PROBE_NO_DOWNLOADER}: 远端缺少 curl 与 wget，无法探测就绪状态)`
  return probe.code === 0 ? `root answered ${probe.stdout.trim() || '?'}` : 'no answer'
}

export async function runInstallScript(
  session: SshSession,
  plan: RemoteInstallPlan,
  installTimeoutMs: number,
  hooks: BootstrapHooks,
  failureLine = 'bootstrap 失败',
): Promise<string[]> {
  const { onEvent, onProgress } = hooks
  let log = ''
  const skips: string[] = []
  const dispatch = createBootstrapLineDispatcher((line) => {
    const parsed = parseBootstrapLine(line)
    if (parsed.stage === 'verify' && parsed.line.includes('跳过'))
      skips.push(parsed.line)
    onEvent?.(parsed.stage, parsed.line)
  })
  const result = await session.exec(buildInstallScript(plan), {
    timeoutMs: installTimeoutMs,
    onData: (chunk) => {
      log = `${log}${chunk}`.slice(-2000)
      dispatch.push(chunk)
      onProgress?.({ phase: 'installing', log })
    },
  })
  dispatch.flush()
  if (result.code !== 0) {
    const streamed = log.trim()
    const collected = streamed !== '' ? streamed : result.stdout.trim()
    const stream = collected !== '' ? collected : result.stderr.trim()
    const tail = stream === '' ? '(no output captured)' : stream.split('\n').slice(-5).join(' | ')
    failBootstrap(onEvent, `install failed on remote (exit ${result.code ?? '?'}): ${tail}`, failureLine)
  }
  return skips
}

function emitReady(
  onEvent: BootstrapHooks['onEvent'],
  target: string,
  verdict: string,
  skipSummary = '',
): void {
  const base = verdict.startsWith('boot')
    ? `远端实例已就绪 (${target})`
    : `远端实例已就绪（旧探测兜底: ${verdict}）`
  onEvent?.('ready', `${base}${skipSummary}`, { terminal: 'success' })
}

function failBootstrap(onEvent: BootstrapHooks['onEvent'], reason: string, line = 'bootstrap 失败'): never {
  onEvent?.('failed', line, { terminal: 'failed', reason })
  throw new Error(reason)
}

async function logTail(session: SshSession): Promise<string> {
  try {
    const result = await session.exec(logTailCommand())
    const tail = result.stdout.trim()
    return tail === '' ? '(log is empty)' : tail.split('\n').slice(-5).join(' | ')
  }
  catch {
    return '(log unreadable)'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
