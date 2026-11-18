import { REMOTE_ROOT } from '../config/constants'
import { remoteInstanceStopCommand } from '../utils/instance'
import { shQuote } from '../utils/shell'
import { BOOTSTRAP_LOG_PREFIX, coreSlotClaimShell } from './bootstrap.utils'

const COPY_MARKER = '__DSH_COPY__'
const DIR_MARKER = '__DSH_DIR__'
const ENTRY_MARKER = '__DSH_ENTRY__'
const ACTIVE_TAG_MARKER = '__DSH_ACTIVE_TAG__'
const PKG_BEGIN = '__DSH_PKG_BEGIN__'
const PKG_END = '__DSH_PKG_END__'

const DSH_ZIP_ENTRY = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
const DSH_NPM_ENTRY = 'lib/bin.js'

/** 远端机器上的核心副本：当前使用的那份叫 `dsh`，其余按版本标识分目录存放。 */
export interface RemoteCoreCopy {
  name: string
  dir: string
  entry?: string
  tag?: string
  version?: string
  unreadable?: string
}

export function remoteCopiesProbeCommand(): string {
  return [
    `ROOT="$HOME/${REMOTE_ROOT}"`,
    'DEPS="$ROOT/dependencies"',
    '[ -d "$DEPS" ] || exit 0',
    'if [ -f "$DEPS/.active-tag" ]; then',
    '  IFS= read -r ACTIVE_TAG < "$DEPS/.active-tag" || true',
    `  printf '${ACTIVE_TAG_MARKER}%s\\n' "$ACTIVE_TAG"`,
    'fi',
    'for dir in "$DEPS"/*; do',
    '  [ -d "$dir" ] || continue',
    '  name="$(basename "$dir")"',
    '  case "$name" in',
    '    *.new|*.new.*|*.ready|*.ready.*) continue ;;',
    '    dsh|dsh-*|src-*) ;;',
    '    *) continue ;;',
    '  esac',
    '  pkg=""',
    '  entry=""',
    `  if [ -f "$dir/${DSH_ZIP_ENTRY}" ]; then`,
    `    entry="$dir/${DSH_ZIP_ENTRY}"`,
    `    pkg="$dir/node_modules/@deepseek-ai/dsh/package.json"`,
    `  elif [ -f "$dir/${DSH_NPM_ENTRY}" ]; then`,
    `    entry="$dir/${DSH_NPM_ENTRY}"`,
    '    pkg="$dir/package.json"',
    '  fi',
    '  [ -n "$entry" ] || continue',
    `  printf '${COPY_MARKER}%s\\n' "$name"`,
    `  printf '${DIR_MARKER}%s\\n' "$dir"`,
    `  printf '${ENTRY_MARKER}%s\\n' "$entry"`,
    `  printf '${PKG_BEGIN}\\n'`,
    '  if [ -n "$pkg" ]; then cat "$pkg"; fi',
    `  printf '\\n${PKG_END}\\n'`,
    'done',
    'true',
  ].join('\n')
}

export function parseRemoteCopies(stdout: string): RemoteCoreCopy[] {
  const copies: RemoteCoreCopy[] = []
  let current: { name: string, dir: string, entry: string, pkg: string[] } | undefined
  let inPackage = false
  let activeTag: string | undefined
  for (const line of stdout.split('\n')) {
    if (line.startsWith(ACTIVE_TAG_MARKER)) {
      const candidate = line.slice(ACTIVE_TAG_MARKER.length).trim()
      activeTag = validSlotName(candidate) ? candidate : undefined
      continue
    }
    if (line.startsWith(COPY_MARKER)) {
      if (current !== undefined)
        copies.push(finishCopy(current, activeTag))
      current = { name: line.slice(COPY_MARKER.length).trim(), dir: '', entry: '', pkg: [] }
      inPackage = false
      continue
    }
    if (current === undefined)
      continue
    if (line.startsWith(DIR_MARKER)) {
      current.dir = line.slice(DIR_MARKER.length).trim()
      continue
    }
    if (line.startsWith(ENTRY_MARKER)) {
      current.entry = line.slice(ENTRY_MARKER.length).trim()
      continue
    }
    if (line === PKG_BEGIN) {
      inPackage = true
      continue
    }
    if (line === PKG_END) {
      inPackage = false
      continue
    }
    if (inPackage)
      current.pkg.push(line)
  }
  if (current !== undefined)
    copies.push(finishCopy(current, activeTag))
  return copies
}

function finishCopy(raw: { name: string, dir: string, entry: string, pkg: string[] }, activeTag: string | undefined): RemoteCoreCopy {
  const copy: RemoteCoreCopy = {
    name: raw.name,
    dir: raw.dir,
    ...raw.entry === '' ? {} : { entry: raw.entry },
    ...raw.name === 'dsh' && activeTag !== undefined ? { tag: activeTag } : {},
  }
  const text = raw.pkg.join('\n').trim()
  if (text === '')
    return { ...copy, unreadable: 'REMOTE_DSH_PACKAGE_UNREADABLE: 副本缺少包元数据' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return { ...copy, unreadable: 'REMOTE_DSH_PACKAGE_INVALID: 包元数据无法解析' }
  }
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || typeof parsed.version !== 'string' || parsed.version === '')
    return { ...copy, unreadable: 'REMOTE_DSH_PACKAGE_INVALID: 包元数据缺少版本号' }
  return { ...copy, version: parsed.version }
}

export function fallbackActiveTag(version: string | undefined): string {
  const normalized = (version ?? 'unknown').replace(/[^\w.-]/gu, '-')
  return normalized === '' || normalized === 'dsh' ? 'dsh-unknown' : `dsh-${normalized}`
}

export interface CoreSwitchScriptOptions {
  targetTag: string
  backupTag: string
  runId: string
  profileName: string
  remotePort: number
  startCommand: string
  entryRelativePath: string
  healthPollAttempts: number
  healthPollIntervalMs: number
}

/**
 * 切换脚本：停实例 → 确认实例已退出 → 互换目录 → 记录版本 → 拉起实例 → 等端口就绪。
 *
 * 整段都在两个槽位的占用声明之内：与「下载同一版本」「另一次切换」互斥，
 * 也保证备份槽位在互换期间不会被别的任务发布。
 *
 * 任何一步失败都先回滚目录；回滚本身失败时用另一个错误码报出来，
 * 调用方据此知道「旧核心没恢复」，不能当成普通失败直接重连。
 */
export function buildCoreSwitchScript(options: CoreSwitchScriptOptions): string {
  const { targetTag, backupTag, runId, profileName, remotePort, startCommand, entryRelativePath } = options
  assertSlotName(targetTag)
  assertSlotName(backupTag)
  assertSlotName(runId)
  assertSlotName(profileName)
  if (targetTag === backupTag)
    throw new Error(`REMOTE_CORE_SWITCH_FAILED: ${targetTag} 与当前使用版本的槽位相同`)
  if (!/^[\w@./-]+$/u.test(entryRelativePath) || entryRelativePath.includes('..'))
    throw new Error(`REMOTE_CORE_SLOT_INVALID: 非法核心入口路径 ${entryRelativePath}`)
  const attempts = Math.max(1, Math.min(120, Math.trunc(options.healthPollAttempts)))
  const intervalMs = Math.max(200, Math.min(10_000, Math.trunc(options.healthPollIntervalMs)))
  return [
    `ROOT="$HOME/${REMOTE_ROOT}"`,
    'DEPS="$ROOT/dependencies"',
    `TARGET="$DEPS/${targetTag}"`,
    `BACKUP="$DEPS/${backupTag}"`,
    `TAG_NEW="$DEPS/.active-tag.new.${runId}"`,
    `TMP="$ROOT/tmp/switch-${runId}"`,
    'ACTIVE_MOVED=0',
    'TARGET_MOVED=0',
    'RECOVERED=1',
    'mkdir -p "$TMP"',
    `log() { printf '${BOOTSTRAP_LOG_PREFIX}%s %s\\n' "$1" "$2"; }`,
    'cleanup() { rm -rf "$TMP"; rm -f "$CLAIM_ACTIVE" "$CLAIM_TARGET" "$CLAIM_BACKUP"; }',
    // 清理只删自己那几条声明（声明名带自己的 pid），拿不到锁时不会碰到别人的。
    'trap cleanup EXIT',
    ...switchSlotClaims(targetTag, backupTag),
    'rollback() {',
    '  if [ "$TARGET_MOVED" = 1 ]; then',
    '    if [ -d "$DEPS/dsh" ] && [ ! -e "$TARGET" ]; then mv "$DEPS/dsh" "$TARGET" || RECOVERED=0; else RECOVERED=0; fi',
    '  fi',
    '  if [ "$ACTIVE_MOVED" = 1 ]; then',
    '    if [ -d "$BACKUP" ] && [ ! -e "$DEPS/dsh" ]; then mv "$BACKUP" "$DEPS/dsh" || RECOVERED=0; else RECOVERED=0; fi',
    '  fi',
    '  [ -d "$DEPS/dsh" ] || RECOVERED=0',
    '}',
    'fail() {',
    '  rollback',
    '  rm -f "$TAG_NEW"',
    '  if [ "$RECOVERED" = 1 ]; then',
    '    echo "REMOTE_CORE_SWITCH_FAILED: $1" >&2',
    '  else',
    '    echo "REMOTE_CORE_SWITCH_UNRECOVERED: $1" >&2',
    '  fi',
    '  exit 1',
    '}',
    '[ -d "$DEPS/dsh" ] || fail "当前使用的核心目录不存在"',
    '[ -d "$TARGET" ] || fail "目标核心副本不存在"',
    // 备份槽位已经被占住时直接失败：绝不把当前核心挪进别人的目录里。
    '[ ! -e "$BACKUP" ] || fail "备份槽位已被占用，请重试"',
    'log switch "停止远端核心实例"',
    ...remoteInstanceStopCommand(profileName, remotePort),
    'sleep 1',
    // 停止命令末尾的 true 会吞掉退出码，只能自己确认监听进程真的没了。
    'if ps -eo args= 2>/dev/null | grep -Eq "$PATTERN"; then fail "远端实例仍在运行，未改动目录"; fi',
    'log switch "互换核心目录"',
    'mv "$DEPS/dsh" "$BACKUP" || fail "无法移走当前使用的核心"',
    'ACTIVE_MOVED=1',
    'mv "$TARGET" "$DEPS/dsh" || fail "无法启用目标核心副本"',
    'TARGET_MOVED=1',
    `printf '%s\\n' ${shQuote(targetTag)} > "$TAG_NEW" || fail "无法记录当前核心版本"`,
    'mv -f "$TAG_NEW" "$DEPS/.active-tag" || fail "无法保存当前核心版本"',
    'log switch "拉起远端核心实例"',
    ...startCommand.split('\n'),
    // 端口应声之前不做别的：拉不起来就换回旧核心。
    'attempt=0',
    `while [ "$attempt" -lt ${attempts} ]; do`,
    '  attempt=$((attempt + 1))',
    `  if curl -s -o /dev/null -m 2 http://127.0.0.1:${remotePort}/ 2>/dev/null || wget -q -T 2 -O /dev/null http://127.0.0.1:${remotePort}/ 2>/dev/null; then break; fi`,
    `  sleep ${Math.round(intervalMs / 1000)}`,
    'done',
    `if [ "$attempt" -ge ${attempts} ]; then fail "远端核心未能在限定时间内就绪"; fi`,
    'echo "REMOTE_CORE_SWITCH_READY"',
  ].join('\n')
}

/**
 * 切换要同时动三个槽位：当前使用的那份（`dsh`）、目标副本，以及放旧核心的备份槽位。
 * 三边都占住，才能和「下载同一版本」「另一次切换」互斥，备份槽位也不会被别任务占去。
 */
function switchSlotClaims(targetTag: string, backupTag: string): string[] {
  return [
    ...coreSlotClaimShell('dsh', {
      lockVar: 'LOCKDIR_ACTIVE',
      claimVar: 'CLAIM_ACTIVE',
      claimName: 'claim-active-$$',
      tmpClaim: 'claim-active.$$',
      busyText: '当前使用的核心槽位正在被其它操作占用',
    }),
    ...coreSlotClaimShell(targetTag, {
      lockVar: 'LOCKDIR_TARGET',
      claimVar: 'CLAIM_TARGET',
      claimName: 'claim-target-$$',
      tmpClaim: 'claim-target.$$',
      busyText: '目标核心槽位正在被其它操作占用',
    }),
    ...coreSlotClaimShell(backupTag, {
      lockVar: 'LOCKDIR_BACKUP',
      claimVar: 'CLAIM_BACKUP',
      claimName: 'claim-backup-$$',
      tmpClaim: 'claim-backup.$$',
      busyText: '备份核心槽位正在被其它操作占用',
    }),
  ]
}

function validSlotName(value: string): boolean {
  return /^[\w.-]+$/u.test(value) && value !== '.' && value !== '..'
}

function assertSlotName(value: string): void {
  if (!validSlotName(value))
    throw new Error(`REMOTE_CORE_SLOT_INVALID: 非法版本目录名 ${value}`)
}
