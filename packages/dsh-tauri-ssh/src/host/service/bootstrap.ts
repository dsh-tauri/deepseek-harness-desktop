/**
 * Remote-instance assurance, v2: binary distribution. Connect-time flow =
 * probe the remote platform (`uname -srm`), download/verify/install the
 * three-part runtime (Node + DSH + pnpm) under the remote-exclusive
 * `~/.dsh-desktop` layout when components are missing, launch the instance,
 * and judge readiness by parsing the served boot HTML's `__DSH_BOOT__`
 * client manifest (the legacy any-response port probe stays as fallback).
 * Ported from the retired Rust engine's `service/remote/bootstrap.rs`
 * (official → mirror download fallback, SHA verification, single-top-level
 * flattening, detached launch) with the stage-tagged event stream this spec
 * adds. Commands remain pure functions of the profile/plan so the manager
 * drives them through any transport.
 * @module dsh-tauri-ssh/host/service/bootstrap
 */

import type { Config } from '../storage/index'
import type { MachineProfile, SshMachineStage, SshMachineTerminal, SshProgress } from '../types/index'
import type { RemoteArch, RemoteAssetMatrix, RemoteOs } from './assets'
import type { SshSession } from './transport'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { DEFAULT_REMOTE_PROFILE } from '../storage/index'
import { assetMatrixFor, dshNpmTarballUrls, dshZipDownloadUrls, nodeDownloadUrls, nodeFilenameFor, nodeShasumUrls, parsePlatform, PNPM_SHA256, PNPM_VERSION, pnpmDownloadUrls } from './assets'
import { clientUrlsFromBootHtml, looksLikePluginBundle } from './boot-html'
import { shQuote } from './transport'
import { listGithubAssets, listGithubReleases, npmDistMetadata, parseGitHubRepo, pickReleaseTag, pkgRepoOf } from './version'

/** Log file of the auto-started remote instance, under the remote home. */
export const REMOTE_WEB_LOG = '.dsh/dsh-remote-web.log'

/** The remote-exclusive install root, relative to the remote home. */
export const REMOTE_ROOT = '.dsh-desktop'

/** The packaged-zip DSH entry, relative to the dsh install directory. */
const DSH_ZIP_ENTRY = 'node_modules/@deepseek-ai/dsh/lib/bin.js'

/** The npm-tarball DSH entry, relative to the dsh install directory. */
const DSH_NPM_ENTRY = 'lib/bin.js'

/** The pnpm entry, relative to the pnpm install directory. */
const PNPM_ENTRY = 'bin/pnpm.cjs'

/** Marker prefix the install script tags its stage lines with. */
export const BOOTSTRAP_LOG_PREFIX = '::dsh '

/** One parsed stage line of the install script's output stream. */
export interface BootstrapLogLine {
  stage: SshMachineStage
  line: string
}

/**
 * The install script's stage vocabulary as a runtime set. Keyed by every
 * {@link SshMachineStage} member so the compiler flags drift (S3 adds the
 * connection-lifecycle stages here too).
 */
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

/** Whether a parsed marker word is one of the known stage tags. */
function isBootstrapStage(value: string): value is SshMachineStage {
  return (BOOTSTRAP_STAGES as Record<string, true | undefined>)[value] === true
}

/**
 * Parse one output line of the install script into its stage tag; lines
 * without a known marker are unexpected tool output and report stage
 * `install` with the raw line kept.
 * @param chunk - one raw output line.
 */
export function parseBootstrapLine(chunk: string): BootstrapLogLine {
  const match = /^::dsh (\w+) (.*)$/u.exec(chunk)
  const stage = match?.[1]
  if (match === null || stage === undefined || !isBootstrapStage(stage))
    return { stage: 'install', line: chunk }
  return { stage, line: match[2] ?? '' }
}

/**
 * Line-buffered dispatcher for a bootstrap script's streamed output: SSH
 * data arrives in arbitrary chunk boundaries, so a half-received line is
 * held back until its newline (or the final flush) completes it.
 * @param onLine - one complete output line.
 */
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

/**
 * The skipped-verification summary terminal events carry: plan-level notes
 * ("no trusted digest") plus the install script's live skip warnings,
 * deduplicated. Empty when every artifact was actually verified — the
 * fail-open skips stay impossible to miss on the settling event.
 * @param notes - the install plan's resolution notes.
 * @param skipLines - streamed verify lines that recorded a skipped check.
 */
export function skippedVerificationSummary(notes: string[], skipLines: string[]): string {
  const items = [...new Set([...notes, ...skipLines].filter(item => item.includes('跳过')))]
  return items.length === 0 ? '' : `；跳过校验项: ${items.join('；')}`
}

/** The npm-registry DSH kind's resolved asset. */
interface DshNpmPlan {
  kind: 'npm-tgz'
  urls: string[]
  /**
   * Trusted digest in the install script's `sha512:<hex>` form (normalized
   * from the packument's SRI `sha512-<base64>`), when available.
   */
  integrity?: string
  packageName: string
  version: string
}

/**
 * Normalize an npm packument integrity into the `shaNNN:<hex>` form the
 * install script's `verify` understands. npm carries SRI (`sha512-<base64>`),
 * which the script would otherwise compare against a hex digest — a
 * guaranteed mismatch. Already-colonformed or unshaped values pass through
 * unchanged (colon forms verify; unshaped ones mismatch loudly) — except
 * unparseable ones, which report undefined so the plan notes the skip.
 * @param integrity - the packument's `dist.integrity`, when present.
 * @returns the `shaNNN:<hex>` digest, or undefined when unusable.
 */
export function normalizeNpmIntegrity(integrity: string | undefined): string | undefined {
  if (integrity === undefined)
    return undefined
  const sri = /^sha(256|512)-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity)
  if (sri !== null)
    return `sha${sri[1]}:${Buffer.from(sri[2] ?? '', 'base64').toString('hex')}`
  return integrity.startsWith('sha256:') || integrity.startsWith('sha512:') ? integrity : undefined
}

/** The packaged-zip DSH kind's resolved asset. */
interface DshZipPlan {
  kind: 'pkg-zip'
  urls: string[]
  /** Trusted `sha256:<hex>` digest from the GitHub release, when available. */
  digest?: string
  zipName: string
  tag: string
}

/** The fully resolved install plan for one remote. */
export interface RemoteInstallPlan {
  os: RemoteOs
  arch: RemoteArch
  matrix: RemoteAssetMatrix
  /** The GitHub `owner/name` the DSH asset downloads from. */
  repo: string
  /** The DSH entry path relative to `$HOME/.dsh-desktop/dependencies/dsh`. */
  dshEntry: string
  /** The resolved DSH semver (empty when the tag carries none). */
  dshVersion: string
  node: { urls: string[], shasumUrls: string[], filename: string, version: string }
  dsh: DshNpmPlan | DshZipPlan
  pnpm: { urls: string[], sha256: string, version: string }
  /** Resolution notes (fallbacks, skipped verification) worth surfacing. */
  notes: string[]
}

/**
 * Plan one remote's install: platform → asset matrix → pinned release tag →
 * per-asset URLs and trusted digests. Pure orchestration over the injectable
 * network functions, so tests cover every path without touching the network.
 * @param unameOut - the remote `uname -srm` output.
 * @param config - plugin config (source repository and version pin).
 * @param fetchers - network overrides for tests.
 * @param fetchers.listReleases - the packaged release list (newest first).
 * @param fetchers.listAssets - one tag's release assets.
 * @param fetchers.npmDist - the npm packument dist metadata.
 * @throws {UnsupportedRemotePlatformError} when the platform is outside the matrix.
 */
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
  // An unparseable configured repository falls back inside pkgRepoOf; note
  // it so a config typo is visible instead of silently installing official.
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
    notes.push(`release 列表获取失败（${describeError(error)}）`)
  }
  const resolved = pickReleaseTag(metas, { ref: config.installRef })
  notes.push(...resolved.notes.map(note => `版本选择: ${note}`))
  const nodeFilename = nodeFilenameFor(os, arch)
  if (nodeFilename === undefined)
    throw new Error(`node asset missing for ${os}/${arch}`)
  const node = {
    urls: nodeDownloadUrls(os, arch),
    shasumUrls: nodeShasumUrls(),
    filename: nodeFilename,
    version: nodeFilename.split('-')[1] ?? '',
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
      notes.push(`release 资产元数据获取失败（${describeError(error)}）`)
    }
    if (digest === undefined)
      notes.push(`未取得 ${zipName} 的可信摘要，将跳过 SHA-256 校验`)
    return {
      os,
      arch,
      matrix,
      repo,
      dshEntry: DSH_ZIP_ENTRY,
      dshVersion: resolved.version,
      node,
      dsh: { kind: 'pkg-zip', urls: urls ?? dshZipDownloadUrls(repo, resolved.tag, zipName), ...digest === undefined ? {} : { digest }, zipName, tag: resolved.tag },
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
    // A packument served by the mirror already carries the mirror tarball
    // URL — dedupe so the fallback list never repeats the same URL.
    urls = [...new Set([dist.url, dist.mirrorUrl])]
    integrity = normalizeNpmIntegrity(dist.integrity)
  }
  catch (error) {
    notes.push(`npm 元数据获取失败（${describeError(error)}），回退确定性 URL`)
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

/** The shell-quoted URL list for a fetch call. */
function quoteUrls(urls: string[]): string {
  return urls.map(shQuote).join(' ')
}

/**
 * Build the remote install script (POSIX sh) for one plan. Behavior: idempotent
 * (installed components are skipped), official → mirror download fallback with
 * both sources' errors reported on double failure, SHA-256/512 verification
 * with mismatch abort and partial cleanup (`trap`), single-top-level
 * flattening, and the `npm-tgz` kind's `pnpm install` (registry official →
 * mirror fallback). Progress reports through `::dsh <stage> <line>` markers.
 * @param plan - the resolved install plan.
 * @returns the full script text.
 */
export function buildInstallScript(plan: RemoteInstallPlan): string {
  const dshSection = plan.dsh.kind === 'pkg-zip'
    ? [
        `if [ -f "$ROOT/dependencies/dsh/${DSH_ZIP_ENTRY}" ]; then`,
        `  log install "dsh 已就绪"`,
        `else`,
        `  log download "dsh ${plan.dsh.tag}"`,
        `  fetch "$TMP/dsh-pkg.zip" ${quoteUrls(plan.dsh.urls)}`,
        `  verify "$TMP/dsh-pkg.zip" "${plan.dsh.digest ?? ''}" "${plan.dsh.zipName}"`,
        `  extract_zip "$TMP/dsh-pkg.zip" "$ROOT/dependencies/dsh.new"`,
        `  flatten_move "$ROOT/dependencies/dsh.new" "$ROOT/dependencies/dsh"`,
        `  log install "dsh 安装完成 (${plan.dsh.tag})"`,
        `fi`,
      ].join('\n')
    : [
        // The npm kind assembles node_modules on the remote: pnpm resolves
        // the platform-correct natives, official registry first, mirror
        // fallback. pnpm must run inside the extracted package (SSH exec
        // starts in $HOME, where pnpm would abort with NO_PKG_MANIFEST).
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
        `  fetch "$TMP/dsh.tgz" ${quoteUrls(plan.dsh.urls)}`,
        `  verify "$TMP/dsh.tgz" "${plan.dsh.integrity ?? ''}" "${plan.dsh.packageName}-${plan.dsh.version}.tgz"`,
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
    // Half-finished products never outlive the run: the trap clears the
    // staging area and any *.new partial directory on every exit path.
    'cleanup() { rm -rf "$TMP" "$ROOT/runtime.new" "$ROOT/dependencies/pnpm.new" "$ROOT/dependencies/dsh.new"; }',
    'trap cleanup EXIT',
    `log() { printf '${BOOTSTRAP_LOG_PREFIX}%s %s\\n' "$1" "$2"; }`,
    'fetch() {',
    '  _dst="$1"; shift',
    '  _errs=""',
    '  for _url in "$@"; do',
    '    if command -v curl >/dev/null 2>&1; then',
    '      log download "$_url"',
    '      if curl -fsSL --retry 3 --connect-timeout 15 -o "$_dst" "$_url" 2>"$TMP/fetch.err"; then return 0; fi',
    '      _errs="$_errs | $_url: $(head -n 1 "$TMP/fetch.err" 2>/dev/null || echo download failed)"',
    '    elif command -v wget >/dev/null 2>&1; then',
    '      log download "$_url"',
    '      if wget -q --tries=3 -O "$_dst" "$_url" 2>/dev/null; then return 0; fi',
    '      _errs="$_errs | $_url: wget download failed"',
    '    else',
    '      log failed "REMOTE_INSTALL_NO_DOWNLOADER: 远端缺少 curl 或 wget，请先安装其一"',
    '      exit 9',
    '    fi',
    '  done',
    '  log failed "所有下载源均失败:$_errs"',
    '  exit 10',
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
    '    log failed "checksum mismatch: $_name (want sha$_algo:$_hex, got $_got)"',
    '    exit 11',
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
    `  fetch "$TMP/node.tar.gz" ${quoteUrls(plan.node.urls)}`,
    `  fetch "$TMP/SHASUMS256.txt" ${quoteUrls(plan.node.shasumUrls)}`,
    `  _want="$(grep " ${plan.node.filename}\$" "$TMP/SHASUMS256.txt" | head -n 1 | tr -d '\\r' | sed 's/^ *//' | cut -d' ' -f1)"`,
    `  verify "$TMP/node.tar.gz" "\$_want" "${plan.node.filename}"`,
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
    `  fetch "$TMP/pnpm.tgz" ${quoteUrls(plan.pnpm.urls)}`,
    `  verify "$TMP/pnpm.tgz" "sha256:${plan.pnpm.sha256}" "pnpm-${plan.pnpm.version}.tgz"`,
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

/**
 * The remote missing-components probe: prints one line per missing member of
 * the three-part runtime (nothing when fully installed).
 */
export function checkMissingCommand(): string {
  return [
    `ROOT="$HOME/${REMOTE_ROOT}"`,
    `[ -x "$ROOT/runtime/bin/node" ] || echo node`,
    `[ -f "$ROOT/dependencies/pnpm/${PNPM_ENTRY}" ] || echo pnpm`,
    `if [ ! -f "$ROOT/dependencies/dsh/${DSH_ZIP_ENTRY}" ] && [ ! -f "$ROOT/dependencies/dsh/${DSH_NPM_ENTRY}" ]; then echo dsh; fi`,
    'true',
  ].join('\n')
}

/** Parse the check script's stdout into the missing component set. */
export function missingComponentsOf(stdout: string): string[] {
  return stdout.split('\n').map(line => line.trim()).filter(line => line !== '' && ['node', 'dsh', 'pnpm'].includes(line))
}

/**
 * The default remote-instance start command's entry resolution: the layout's
 * Node binary and DSH entry, always (the installer's `~/.local/bin` link no
 * longer exists in the binary layout).
 */
export function layoutDshEntry(plan?: RemoteInstallPlan): string {
  return `$HOME/${REMOTE_ROOT}/dependencies/dsh/${plan?.dshEntry ?? DSH_ZIP_ENTRY}`
}

/** The layout's Node binary, double-quoted so `$HOME` still expands under `sh -lc`. */
export function layoutNodeBinary(): string {
  return `"$HOME/${REMOTE_ROOT}/runtime/bin/node"`
}

/**
 * The layout's shared bin directory (unquoted; `$HOME` expands in the remote
 * shell). It is already on the remote instance's PATH — the start command
 * exports it — so anything placed here is visible to the instance's own
 * tooling as well.
 */
export function layoutBinDir(): string {
  return `$HOME/${REMOTE_ROOT}/runtime/bin`
}

/**
 * Make the layout's bundled pnpm reachable as a bare `pnpm` on PATH.
 *
 * `dsh plugin add` shells out to `pnpm`, but a stock remote install only
 * ships the binary at `dependencies/pnpm/bin/pnpm.cjs` (the installer uses it
 * by absolute path) — nothing named `pnpm` exists, so every plugin install
 * died with `exit 127: dsh: pnpm not found on PATH`. The shim is written
 * once (an existing one is left alone), runs the layout's own Node and pnpm,
 * and needs no network: the version is the one the installer already pinned
 * ({@link PNPM_VERSION}).
 */
export function ensurePnpmCommand(): string {
  const shim = `#!/bin/sh\nexec "$HOME/${REMOTE_ROOT}/runtime/bin/node" "$HOME/${REMOTE_ROOT}/dependencies/pnpm/${PNPM_ENTRY}" "$@"\n`
  return `B="${layoutBinDir()}"; [ -x "$B/pnpm" ] || { mkdir -p "$B" && printf %s ${shQuote(shim)} > "$B/pnpm" && chmod +x "$B/pnpm"; }`
}

/**
 * The installed dsh-entry probe for command-driving callers (the sync
 * engine): prints the first entry the binary layout actually holds — zip
 * layout first, npm layout second, the same precedence as
 * {@link checkMissingCommand} — or nothing when neither is installed.
 * Unlike the instance launch the plan is unknown here, so the probe resolves
 * it remotely; the printed path is absolute (`$HOME` already expanded).
 */
export function dshEntryProbeCommand(): string {
  return [
    `ROOT="$HOME/${REMOTE_ROOT}"`,
    `if [ -f "$ROOT/dependencies/dsh/${DSH_ZIP_ENTRY}" ]; then printf '%s\\n' "$ROOT/dependencies/dsh/${DSH_ZIP_ENTRY}"`,
    `elif [ -f "$ROOT/dependencies/dsh/${DSH_NPM_ENTRY}" ]; then printf '%s\\n' "$ROOT/dependencies/dsh/${DSH_NPM_ENTRY}"`,
    'fi',
    'true',
  ].join('\n')
}

/**
 * The remote-instance launch: the profile override when present, else the
 * layout's Node + DSH entry with the port pinned twice (`DSH_WEB_PORT` and
 * the flag). Detached through a double subshell so the exec channel settles
 * immediately; the pid lands in `~/.dsh/.dsh-remote.pid`; output redirects
 * to the log with stdin from /dev/null; no `nohup` (macOS kills the child).
 * @param profile - the machine profile (port + start command override).
 * @param plan - the resolved install plan (chooses the DSH entry).
 * @returns the shell command line that starts (or restarts) the instance.
 */
/**
 * The launch-token lookup command: `dsh web` prints its authenticated URL
 * (`…/?token=…`) to stdout, which the start command appends to the remote
 * web log. The last match wins (a restarted instance appends a fresh line);
 * prints nothing when the log has no token (callers fall back to the bare
 * tunnel URL). Token charset is the URL-safe base the launch token uses.
 */
export function remoteWebTokenCommand(): string {
  return `grep -oE 'token=[A-Za-z0-9._~-]+' "$HOME/${REMOTE_WEB_LOG}" 2>/dev/null | tail -n 1 | cut -d= -f2`
}

/** Shell- and path-safe profile names only (`^[A-Za-z0-9_-]+$`); anything else falls back to the default. */
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

/** Credentials read from a local dsh `.env` document. */
export interface EnvCredentials {
  apiKey?: string
  baseUrl?: string
}

/**
 * Read `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL` from a dsh `.env` document.
 * @param path - the `.env` file path (the harness home's `.env`).
 * @returns the credentials present in the document.
 */
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

/**
 * Write credentials into the remote `~/.dsh/.env`: print `copied` when the
 * write happened, `existing` when the remote already carries a key (kept
 * untouched). The write merges instead of replacing — only the keys being
 * written are filtered out of an existing document, so remote-set variables
 * (including a remote `DEEPSEEK_BASE_URL` when the local env carries none)
 * survive — and it lands through a temp file + `mv`, so a failed write can
 * never truncate the existing document.
 * @param credentials - the credentials to write (apiKey required).
 * @returns the shell command line.
 */
export function credentialsCopyCommand(credentials: EnvCredentials & { apiKey: string }): string {
  // Only the keys this write owns are filtered from the existing document.
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

/** One `KEY=value` line of a `.env` document, optional surrounding quotes stripped. */
function envValueOf(text: string, key: string): string | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${key}=`))
      continue
    const value = line.slice(key.length + 1).trim().replace(/^"(.*)"$/u, '$1')
    return value === '' ? undefined : value
  }
  return undefined
}

/** The first non-empty line of a command's stdout, trimmed (a probe prints one path). */
export function firstLineOf(stdout: string): string {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '')
      return trimmed
  }
  return ''
}

/** Marker the readiness probes report when the remote has neither curl nor wget. */
export const REMOTE_PROBE_NO_DOWNLOADER = 'REMOTE_PROBE_NO_DOWNLOADER'

/**
 * Wrap one probe's fetch arms with the downloader selection the install
 * script's `fetch()` uses: curl when present, wget next, and a loud
 * `REMOTE_PROBE_NO_DOWNLOADER` marker (exit 1) when neither exists — a
 * wget-only remote must not install fine and then fail readiness forever.
 * `command -v` runs inside a command substitution so the probes never
 * contain a `/dev/null` redirect (the legacy verdict probe is told apart
 * by exactly that token).
 * @param curlArm - the curl invocation.
 * @param wgetArm - the wget invocation.
 */
function withDownloaderFallback(curlArm: string, wgetArm: string): string {
  return [
    `if [ -n "$(command -v curl)" ]; then ${curlArm}`,
    `elif [ -n "$(command -v wget)" ]; then ${wgetArm}`,
    `else echo "${REMOTE_PROBE_NO_DOWNLOADER}: 远端缺少 curl 与 wget，无法探测就绪状态" >&2; exit 1; fi`,
  ].join('; ')
}

/**
 * The root-page probe: fetch the instance's boot HTML. Any HTTP response
 * (including 401/404) exits 0 — the body decides; a connection-level
 * failure exits nonzero. The wget arm normalizes GNU wget's exit codes to
 * curl's any-response-answers semantics: 6 is an authentication challenge
 * (the auth fence's 401), 8 a server error status — both are answers
 * (verified live: GNU Wget 1.21.2 gives 6 on 401, 8 on 404, 4 on refused).
 * busybox wget collapses every failure to 1 and lands on the not-ready
 * side of that split.
 * @param remotePort - the instance's loopback port.
 * @param timeoutMs - per-probe downloader deadline.
 */
export function rootProbeCommand(remotePort: number, timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  return withDownloaderFallback(
    `curl -s -m ${seconds} http://127.0.0.1:${remotePort}/`,
    `wget -q -T ${seconds} -O - http://127.0.0.1:${remotePort}/; case $? in 0|6|8) ;; *) exit 1 ;; esac`,
  )
}

/**
 * The client-bundle probe: fetch one boot-manifest URL, printing the body
 * followed by the numeric status code on its last line. wget cannot append
 * a status line, so its arm synthesizes one: a completed fetch (exit 0) IS
 * a 2xx answer; anything else — connection failure or a server error
 * status (exit 8) — reports status 0, which never passes readiness.
 * @param url - the absolute loopback URL to fetch.
 * @param timeoutMs - per-probe downloader deadline.
 */
export function bundleProbeCommand(url: string, timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  return withDownloaderFallback(
    `curl -s -m ${seconds} -w '\\n%{http_code}' ${shQuote(url)}`,
    `wget -q -T ${seconds} -O - ${shQuote(url)} && printf '\\n200\\n' || printf '\\n0\\n'`,
  )
}

/**
 * Split a bundle probe's stdout into body and numeric status. Malformed
 * output (no trailing status line) reports status 0.
 * @param stdout - the raw probe stdout.
 */
export function splitBundleProbeStdout(stdout: string): { body: string, status: number } {
  const trimmed = stdout.replace(/\n$/u, '')
  const index = trimmed.lastIndexOf('\n')
  if (index < 0) {
    // A single-line answer is the bare status (an empty body).
    const status = Number.parseInt(trimmed, 10)
    return Number.isNaN(status) ? { body: trimmed, status: 0 } : { body: '', status }
  }
  const status = Number.parseInt(trimmed.slice(index + 1).trim(), 10)
  return Number.isNaN(status) ? { body: trimmed, status: 0 } : { body: trimmed.slice(0, index), status }
}

/** The tail command that recovers the remote instance's log for the error message. */
export function logTailCommand(): string {
  return `tail -n 20 "$HOME/${REMOTE_WEB_LOG}" 2>/dev/null || true`
}

/** One operator-facing fragment for a failed remote command. */
export function describeExecFailure(code: number | null, stderr: string): string {
  const tail = stderr.trim().split('\n').slice(-3).join(' | ')
  return `exit ${code ?? '?'}${tail === '' ? '' : `: ${tail}`}`
}

/** One operator-facing fragment for an unknown-shape failure. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Hooks the assurance flow reports through (both optional). */
export interface BootstrapHooks {
  /** Coarse UI progress (the settings page's live status line). */
  onProgress?: (progress: SshProgress) => void
  /** Machine event channel appends (stage-tagged, the spec's C-EVENT). */
  onEvent?: (stage: SshMachineStage, line: string, options?: { terminal?: SshMachineTerminal, reason?: string }) => void
}

/** Timing + source configuration of the assurance flow. */
export interface BootstrapConfig {
  config: Pick<Config, 'installRepo' | 'installRef' | 'installTimeoutMs'>
  healthCheckTimeoutMs: number
  healthPollIntervalMs: number
  healthPollAttempts: number
}

/**
 * Ensure the remote instance is ready: judge readiness from the served boot
 * HTML (client-bundle manifest), and when it is not, bootstrap the machine —
 * probe the platform, install missing runtime components from pinned binary
 * assets, launch the instance, and poll until the manifest answers. The
 * legacy any-response verdict stays as the fallback for instances whose HTML
 * carries no manifest.
 * @param session - the authenticated SSH session.
 * @param profile - the machine profile (port + start command override).
 * @param bootstrap - timing + source configuration.
 * @param hooks - progress and event reporting.
 * @param planner - the install-plan resolver (injectable for tests).
 * @returns a short description of the ready instance (host:port, plus how
 * readiness was judged).
 * @throws {Error} with an operator-facing message when the machine cannot be
 * bootstrapped (unsupported platform, install failure, never ready).
 */
export async function ensureRemoteInstance(
  session: SshSession,
  profile: MachineProfile,
  bootstrap: BootstrapConfig,
  hooks: BootstrapHooks = {},
  planner: (unameOut: string, config: Pick<Config, 'installRepo' | 'installRef'>) => Promise<RemoteInstallPlan> = (unameOut, config) => planRemoteInstall(unameOut, config),
): Promise<string> {
  const { onEvent, onProgress } = hooks
  const target = `${profile.host}:${profile.remotePort}`
  const readyFromHtml = await judgeReadiness(session, profile, bootstrap)
  if (readyFromHtml !== undefined) {
    emitReady(onEvent, target, readyFromHtml)
    return target
  }
  // The instance is not answering: bootstrap (probe → install → launch).
  onEvent?.('probe', '探测远端平台 (uname -srm)')
  const uname = await session.exec('uname -srm')
  if (uname.code !== 0) {
    return failBootstrap(onEvent, `无法探测远端平台: ${describeExecFailure(uname.code, uname.stderr)}`)
  }
  let plan: RemoteInstallPlan
  try {
    plan = await planner(uname.stdout, bootstrap.config)
  }
  catch (error) {
    return failBootstrap(onEvent, describeError(error))
  }
  onEvent?.('probe', `远端平台 ${plan.os}/${plan.arch}，安装源 ${plan.repo}${plan.dsh.kind === 'pkg-zip' ? ` tag ${plan.dsh.tag}` : ` npm ${plan.dsh.version}`}`)
  for (const note of plan.notes)
    onEvent?.('probe', note)
  const missing = missingComponentsOf((await session.exec(checkMissingCommand())).stdout)
  let skips: string[] = []
  if (missing.length > 0) {
    onEvent?.('probe', `缺失组件: ${missing.join(', ')}`)
    skips = await runInstallScript(session, plan, bootstrap.config.installTimeoutMs, hooks)
  }
  else {
    onEvent?.('probe', '三件套已就绪，跳过安装')
  }
  // The bootstrap's settling event carries the skipped-verification summary
  // (plan notes + the script's live verify warnings), if any.
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
  for (let attempt = 0; attempt < bootstrap.healthPollAttempts; attempt++) {
    onProgress?.({ phase: 'probing', attempt: attempt + 1, total: bootstrap.healthPollAttempts })
    await sleep(bootstrap.healthPollIntervalMs)
    const verdict = await judgeReadiness(session, profile, bootstrap)
    if (verdict !== undefined) {
      emitReady(onEvent, target, verdict, skipSummary)
      return target
    }
  }
  const tail = await logTail(session)
  return failBootstrap(
    onEvent,
    `remote dsh web did not become ready on "${target}" within ${bootstrap.healthPollAttempts} polls; `
    + `fallback probe: root ${await legacyRootVerdict(session, profile, bootstrap)}; `
    + `remote log tail: ${tail}`,
  )
}

/**
 * One readiness judgement: boot-HTML manifest (primary) or any-response
 * (legacy fallback). Returns `boot …` / `legacy …`, or undefined while not
 * ready.
 */
async function judgeReadiness(session: SshSession, profile: MachineProfile, bootstrap: BootstrapConfig): Promise<string | undefined> {
  const root = await session.exec(rootProbeCommand(profile.remotePort, bootstrap.healthCheckTimeoutMs))
  if (root.code !== 0)
    return undefined
  const urls = clientUrlsFromBootHtml(profile.remotePort, root.stdout)
  if (urls === undefined) {
    // No usable manifest: keep the legacy verdict — an answered port still
    // proves a webserver listens (the v1 behavior, demoted to fallback).
    return await legacyRootVerdict(session, profile, bootstrap)
  }
  const first = urls[0]
  if (first === undefined)
    return undefined
  const probe = await session.exec(bundleProbeCommand(first, bootstrap.healthCheckTimeoutMs))
  const { body, status } = splitBundleProbeStdout(probe.stdout)
  if (probe.code === 0 && status >= 200 && status < 300 && looksLikePluginBundle(true, body))
    return `boot manifest (${urls.length} bundles)`
  return undefined
}

/**
 * The legacy any-response probe command: the status code on stdout, exit
 * nonzero only when nothing answered. curl prints the real code; the wget
 * arm normalizes GNU wget's exit codes — 0 is a 2xx answer, 6/8 are server
 * answers (auth challenge / error status, code unknown → `4xx/5xx`), and
 * the rest are connection-level failures. The no-downloader marker rides
 * stdout so the failure message says why instead of a misleading "no
 * answer".
 * @param remotePort - the instance's loopback port.
 * @param timeoutMs - per-probe downloader deadline.
 */
export function legacyProbeCommand(remotePort: number, timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  return [
    `if [ -n "$(command -v curl)" ]; then curl -s -o /dev/null -m ${seconds} -w '%{http_code}' http://127.0.0.1:${remotePort}/`,
    `elif [ -n "$(command -v wget)" ]; then wget -q -T ${seconds} -O /dev/null http://127.0.0.1:${remotePort}/; case $? in 0) echo 200 ;; 6|8) echo 4xx/5xx ;; *) exit 1 ;; esac`,
    `else echo ${REMOTE_PROBE_NO_DOWNLOADER}; fi`,
  ].join('; ')
}

/** The legacy any-response verdict, with the observed status code attached. */
async function legacyRootVerdict(session: SshSession, profile: MachineProfile, bootstrap: BootstrapConfig): Promise<string> {
  const probe = await session.exec(legacyProbeCommand(profile.remotePort, bootstrap.healthCheckTimeoutMs))
  if (probe.stdout.includes(REMOTE_PROBE_NO_DOWNLOADER))
    return `no downloader (${REMOTE_PROBE_NO_DOWNLOADER}: 远端缺少 curl 与 wget，无法探测就绪状态)`
  return probe.code === 0 ? `root answered ${probe.stdout.trim() || '?'}` : 'no answer'
}

/**
 * Run the generated install script, streaming its stage-tagged output
 * line-buffered (SSH chunks may split mid-line). Returns the verify-stage
 * lines that recorded a skipped check, for the settling event's summary.
 * The single install executor for both the connect-time bootstrap and the
 * manager's install operation — the caller injects its event adapter
 * through {@link BootstrapHooks.onEvent}, so the two flows can never drift.
 * @param session - the authenticated session.
 * @param plan - the resolved install plan.
 * @param installTimeoutMs - the install exec deadline, when configured.
 * @param hooks - progress and event reporting.
 * @param failureLine - the settling failure event's display line.
 * @returns the verify-stage lines that recorded a skipped check.
 * @throws {Error} with the output tail when the script exits nonzero.
 */
export async function runInstallScript(
  session: SshSession,
  plan: RemoteInstallPlan,
  installTimeoutMs: number | undefined,
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
    ...installTimeoutMs === undefined ? {} : { timeoutMs: installTimeoutMs },
    onData: (chunk) => {
      log = `${log}${chunk}`.slice(-2000)
      dispatch.push(chunk)
      onProgress?.({ phase: 'installing', log })
    },
  })
  dispatch.flush()
  if (result.code !== 0) {
    // Prefer the streamed log (the transport taps stdout live); transports
    // without the tap still surface the markers through the collected
    // stdout, and a totally silent failure keeps its exit stderr.
    const streamed = log.trim()
    const collected = streamed !== '' ? streamed : result.stdout.trim()
    const stream = collected !== '' ? collected : result.stderr.trim()
    const tail = stream === '' ? '(no output captured)' : stream.split('\n').slice(-5).join(' | ')
    failBootstrap(onEvent, `install failed on remote (exit ${result.code ?? '?'}): ${tail}`, failureLine)
  }
  return skips
}

/**
 * The settling ready event: primary boot-manifest verdict, legacy-fallback
 * note, and the skipped-verification summary when checks were skipped.
 */
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

/**
 * Record the terminal failure and build the thrown error.
 * @param onEvent - the event hook receiving the settling event.
 * @param reason - the operator-facing failure reason.
 * @param line - the settling event's display line (the install operation
 * passes its own wording; the default matches the connect-time bootstrap).
 */
function failBootstrap(onEvent: BootstrapHooks['onEvent'], reason: string, line = 'bootstrap 失败'): never {
  onEvent?.('failed', line, { terminal: 'failed', reason })
  throw new Error(reason)
}

/** The remote instance log's tail, or a note when nothing was captured. */
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
