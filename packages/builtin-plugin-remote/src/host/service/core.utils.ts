import { BOOTSTRAP_LOG_PREFIX, REMOTE_ROOT } from '../config/constants'
import { remoteInstanceStopCommand, remoteSlotClaimShell } from '../utils/instance'
import { shQuote } from '../utils/shell'

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
  /** 探测时看到的当前使用那份的版本：占槽之后要核对它没变。 */
  activeVersion?: string | undefined
  /** 探测时看到的目标副本的版本：占槽之后要核对它没变。 */
  targetVersion?: string | undefined
}

/**
 * 切换脚本：停实例 → 确认实例已退出 → 互换目录 → 记录版本 → 拉起实例 → 等端口就绪。
 *
 * 整段都在三个槽位的占用声明之内：与「下载同一版本」「另一次切换」互斥，
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
  const activeVersion = options.activeVersion ?? ''
  const targetVersion = options.targetVersion ?? ''
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
    'ROLLED_BACK=0',
    'COMPLETED=0',
    'FAILED=0',
    'STARTED=0',
    'PREV_TAG=""',
    'HAD_TAG=0',
    'TAG_CHANGED=0',
    'mkdir -p "$TMP"',
    `log() { printf '${BOOTSTRAP_LOG_PREFIX}%s %s\\n' "$1" "$2"; }`,
    // 副本的版本号：占槽之后要核对副本没被别人换掉。
    'dsh_version_of() {',
    '  for _pkg in "$1/node_modules/@deepseek-ai/dsh/package.json" "$1/package.json"; do',
    '    [ -f "$_pkg" ] || continue',
    `    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$_pkg" | head -n 1`,
    '    return 0',
    '  done',
    '  return 1',
    '}',
    'cleanup() { rm -rf "$TMP"; rm -f "$TAG_NEW" "$CLAIM_ACTIVE" "$CLAIM_TARGET" "$CLAIM_BACKUP"; }',
    // 清理只删自己那几条声明（声明名带自己的 pid），拿不到锁时不会碰到别人的。
    'rollback() {',
    '  if [ "$ROLLED_BACK" = 1 ]; then return; fi',
    '  ROLLED_BACK=1',
    '  if [ "$TARGET_MOVED" = 1 ]; then',
    '    if [ -d "$DEPS/dsh" ] && [ ! -e "$TARGET" ]; then mv "$DEPS/dsh" "$TARGET" || RECOVERED=0; else RECOVERED=0; fi',
    '  fi',
    '  if [ "$ACTIVE_MOVED" = 1 ]; then',
    '    if [ -d "$BACKUP" ] && [ ! -e "$DEPS/dsh" ]; then mv "$BACKUP" "$DEPS/dsh" || RECOVERED=0; else RECOVERED=0; fi',
    '  fi',
    // 目录换回去了，版本记录也要换回去：否则清单会把旧核心标成新版本。
    // 只有本次真的改过版本记录才回写：停在停机前就拒绝时不能动别人的记录。
    '  if [ "$TAG_CHANGED" = 1 ]; then',
    '    if [ "$HAD_TAG" = 1 ]; then',
    `      printf '%s\\n' "$PREV_TAG" > "$TAG_NEW" && mv -f "$TAG_NEW" "$DEPS/.active-tag" || RECOVERED=0`,
    '    else',
    // 原本没有版本记录：删掉切换时写的那份。删不掉就不能算恢复成功。
    '      rm -f "$DEPS/.active-tag" || RECOVERED=0',
    '    fi',
    '  fi',
    '  [ -d "$DEPS/dsh" ] || RECOVERED=0',
    '}',
    // 目录动过之后脚本再意外退出（没走 fail），也要把目录换回去。
    'on_exit() {',
    '  if [ "$COMPLETED" = 0 ] && [ "$ACTIVE_MOVED" = 1 ]; then',
    '    rollback',
    '    if [ "$FAILED" = 0 ]; then',
    '      if [ "$RECOVERED" = 1 ]; then',
    '        echo "REMOTE_CORE_SWITCH_FAILED: 切换脚本异常退出" >&2',
    '      else',
    '        echo "REMOTE_CORE_SWITCH_UNRECOVERED: 切换脚本异常退出" >&2',
    '      fi',
    '    fi',
    '  fi',
    '  cleanup',
    '}',
    'trap on_exit EXIT',
    ...switchSlotClaims(targetTag, backupTag),
    // 版本记录要在占槽之后才读：占槽之前读到的可能已经被别的桌面换掉了，
    // 拿旧快照去回写会把别人的记录抹掉。
    'if [ -f "$DEPS/.active-tag" ]; then',
    '  IFS= read -r PREV_TAG < "$DEPS/.active-tag" || true',
    '  HAD_TAG=1',
    'fi',
    'fail() {',
    // 回滚之前先把本次拉起的实例停掉：它可能刚好在最后一轮探测之后才起来。
    // 不停就换目录，恢复出来的旧核心旁边还挂着一个新核心，恢复重连会连错。
    '  if [ "$STARTED" = 1 ]; then',
    '    stop_instance',
    '  fi',
    '  rollback',
    '  if [ "$RECOVERED" = 1 ]; then',
    '    echo "REMOTE_CORE_SWITCH_FAILED: $1" >&2',
    '  else',
    '    echo "REMOTE_CORE_SWITCH_UNRECOVERED: $1" >&2',
    '  fi',
    '  FAILED=1',
    '  exit 1',
    '}',
    // 停实例：回滚之前还要再停一次，所以单独做成函数。
    'stop_instance() {',
    ...remoteInstanceStopCommand(profileName, remotePort),
    '}',
    '[ -d "$DEPS/dsh" ] || fail "当前使用的核心目录不存在"',
    '[ -d "$TARGET" ] || fail "目标核心副本不存在"',
    // 备份槽位已经被占住时直接失败：绝不把当前核心挪进别人的目录里。
    '[ ! -e "$BACKUP" ] || fail "备份槽位已被占用，请重试"',
    // 占槽期间别的桌面可能已经换过副本：核对版本，没变才继续动目录。
    ...versionGuard('$DEPS/dsh', activeVersion, '当前使用的核心'),
    ...versionGuard('$TARGET', targetVersion, '目标核心副本'),
    'log switch "停止远端核心实例"',
    'stop_instance',
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
    'TAG_CHANGED=1',
    'log switch "拉起远端核心实例"',
    // 拉起命令放在子 shell 里：它自己 exit 1 时只会退出子 shell，
    // 由这里的 fail 接手回滚，不会把目录留在换了一半的状态。
    '(',
    ...startCommand.split('\n'),
    ') || fail "无法拉起远端核心实例"',
    'STARTED=1',
    // 端口应声之前不做别的：拉不起来就换回旧核心。
    'attempt=0',
    'READY=0',
    `while [ "$attempt" -lt ${attempts} ]; do`,
    '  attempt=$((attempt + 1))',
    `  if curl -s -o /dev/null -m 2 http://127.0.0.1:${remotePort}/ 2>/dev/null || wget -q -T 2 -O /dev/null http://127.0.0.1:${remotePort}/ 2>/dev/null; then READY=1; break; fi`,
    `  sleep ${Math.round(intervalMs / 1000)}`,
    'done',
    // 探测成功与否单独记：最后一次探测刚好成功时不能当成超时。
    '[ "$READY" = 1 ] || fail "远端核心未能在限定时间内就绪"',
    'COMPLETED=1',
    'echo "REMOTE_CORE_SWITCH_READY"',
  ].join('\n')
}

/** 占槽之后核对副本还是探测时看到的那一份：别的桌面可能已经换过了。 */
function versionGuard(dirVariable: string, expectedVersion: string, label: string): string[] {
  if (expectedVersion === '')
    return []
  return [
    `_ver="$(dsh_version_of ${dirVariable} || true)"`,
    `[ "$_ver" = ${shQuote(expectedVersion)} ] || fail "${label}已变化，请重新尝试"`,
  ]
}

export interface CoreSwitchRestoreOptions {
  targetTag: string
  backupTag: string
  runId: string
  profileName: string
  remotePort: number
  startCommand: string
  /** 切换前的版本标识：恢复时要写回去；原本没有就删掉。 */
  restoreTag?: string | undefined
  healthPollAttempts: number
  healthPollIntervalMs: number
}

/**
 * 恢复脚本：目录已经换成新核心，但连接没建起来时，把旧核心换回去并重新拉起。
 *
 * 切换要么整体成功（目录 + 实例 + 连接），要么整体回到旧核心。
 * 只报失败却把远端留在新核心上，用户看到的和实际发生的对不上。
 */
export function buildCoreSwitchRestoreScript(options: CoreSwitchRestoreOptions): string {
  const { targetTag, backupTag, runId, profileName, remotePort, startCommand, restoreTag } = options
  assertSlotName(targetTag)
  assertSlotName(backupTag)
  assertSlotName(runId)
  assertSlotName(profileName)
  if (targetTag === backupTag)
    throw new Error(`REMOTE_CORE_SWITCH_FAILED: ${targetTag} 与当前使用版本的槽位相同`)
  const attempts = Math.max(1, Math.min(120, Math.trunc(options.healthPollAttempts)))
  const intervalMs = Math.max(200, Math.min(10_000, Math.trunc(options.healthPollIntervalMs)))
  return [
    `ROOT="$HOME/${REMOTE_ROOT}"`,
    'DEPS="$ROOT/dependencies"',
    `TARGET="$DEPS/${targetTag}"`,
    `BACKUP="$DEPS/${backupTag}"`,
    `TAG_NEW="$DEPS/.active-tag.restore.${runId}"`,
    `TMP="$ROOT/tmp/switch-restore-${runId}"`,
    'mkdir -p "$TMP"',
    `log() { printf '${BOOTSTRAP_LOG_PREFIX}%s %s\\n' "$1" "$2"; }`,
    'cleanup() { rm -rf "$TMP"; rm -f "$TAG_NEW" "$CLAIM_ACTIVE" "$CLAIM_TARGET" "$CLAIM_BACKUP"; }',
    'trap cleanup EXIT',
    ...switchSlotClaims(targetTag, backupTag),
    'fail() { echo "REMOTE_CORE_SWITCH_UNRECOVERED: $1" >&2; exit 1; }',
    'stop_instance() {',
    ...remoteInstanceStopCommand(profileName, remotePort),
    '}',
    '[ -d "$BACKUP" ] || fail "旧核心备份不存在"',
    '[ -d "$DEPS/dsh" ] || fail "新核心目录不存在"',
    // 恢复需要目标位置空着：被别人填上就不能恢复，否则活动目录里还是新核心，
    // 却把版本记录写回旧核心，清单会把两样东西对错。
    '[ ! -e "$TARGET" ] || fail "目标副本位置已被占用，无法恢复旧核心"',
    'log rollback "停止远端核心实例"',
    'stop_instance',
    'sleep 1',
    'log rollback "恢复旧核心目录"',
    'mv "$DEPS/dsh" "$TARGET" || fail "无法移走新核心"',
    'mv "$BACKUP" "$DEPS/dsh" || fail "无法恢复旧核心"',
    '[ -d "$DEPS/dsh" ] || fail "旧核心目录不存在"',
    // 版本记录也要换回去，否则清单会把旧核心标成新版本。
    ...(restoreTag === undefined
      ? ['rm -f "$DEPS/.active-tag" || fail "无法清除当前核心版本记录"']
      : [`printf '%s\\n' ${shQuote(restoreTag)} > "$TAG_NEW" && mv -f "$TAG_NEW" "$DEPS/.active-tag" || fail "无法恢复当前核心版本记录"`]),
    'log rollback "拉起旧核心实例"',
    '(',
    ...startCommand.split('\n'),
    ') || fail "无法拉起旧核心实例"',
    'attempt=0',
    'READY=0',
    `while [ "$attempt" -lt ${attempts} ]; do`,
    '  attempt=$((attempt + 1))',
    `  if curl -s -o /dev/null -m 2 http://127.0.0.1:${remotePort}/ 2>/dev/null || wget -q -T 2 -O /dev/null http://127.0.0.1:${remotePort}/ 2>/dev/null; then READY=1; break; fi`,
    `  sleep ${Math.round(intervalMs / 1000)}`,
    'done',
    '[ "$READY" = 1 ] || fail "旧核心未能在限定时间内就绪"',
    'echo "REMOTE_CORE_SWITCH_RESTORED"',
  ].join('\n')
}

/**
 * 切换要同时动三个槽位：当前使用的那份（`dsh`）、目标副本，以及放旧核心的备份槽位。
 * 三边都占住，才能和「下载同一版本」「另一次切换」互斥，备份槽位也不会被别任务占去。
 */
function switchSlotClaims(targetTag: string, backupTag: string): string[] {
  return [
    ...remoteSlotClaimShell('dsh', {
      lockVar: 'LOCKDIR_ACTIVE',
      claimVar: 'CLAIM_ACTIVE',
      claimName: 'claim-active-$$',
      tmpClaim: 'claim-active.$$',
      busyText: '当前使用的核心槽位正在被其它操作占用',
      busyCode: 'active',
    }),
    ...remoteSlotClaimShell(targetTag, {
      lockVar: 'LOCKDIR_TARGET',
      claimVar: 'CLAIM_TARGET',
      claimName: 'claim-target-$$',
      tmpClaim: 'claim-target.$$',
      busyText: '目标核心槽位正在被其它操作占用',
      busyCode: 'target',
    }),
    ...remoteSlotClaimShell(backupTag, {
      lockVar: 'LOCKDIR_BACKUP',
      claimVar: 'CLAIM_BACKUP',
      claimName: 'claim-backup-$$',
      tmpClaim: 'claim-backup.$$',
      busyText: '备份核心槽位正在被其它操作占用',
      busyCode: 'backup',
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
