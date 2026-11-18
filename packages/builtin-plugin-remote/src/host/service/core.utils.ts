import { REMOTE_ROOT } from '../config/constants'
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

export function buildCoreSwitchScript(targetTag: string, backupTag: string, runId: string): string {
  assertSlotName(targetTag)
  assertSlotName(backupTag)
  assertSlotName(runId)
  if (targetTag === backupTag)
    throw new Error(`REMOTE_CORE_SWITCH_FAILED: ${targetTag} 与当前使用版本的槽位相同`)
  return [
    `ROOT="$HOME/${REMOTE_ROOT}"`,
    'DEPS="$ROOT/dependencies"',
    `TARGET="$DEPS/${targetTag}"`,
    `BACKUP="$DEPS/${backupTag}"`,
    `HOLDING="$DEPS/.switch-holding-${runId}"`,
    `TAG_NEW="$DEPS/.active-tag.new.${runId}"`,
    `TMP="$ROOT/tmp/switch-${runId}"`,
    'ACTIVE_MOVED=0',
    'TARGET_MOVED=0',
    'HELD=0',
    'mkdir -p "$TMP"',
    `log() { printf '${BOOTSTRAP_LOG_PREFIX}%s %s\\n' "$1" "$2"; }`,
    'cleanup() { rm -rf "$TMP"; rm -f "$CLAIM_ACTIVE" "$CLAIM_TARGET"; }',
    // 清理只删自己那两条声明（声明名带自己的 pid），拿不到锁时不会碰到别人的。
    'trap cleanup EXIT',
    ...switchSlotClaims(targetTag),
    'rollback() {',
    '  if [ "$TARGET_MOVED" = 1 ] && [ -d "$DEPS/dsh" ] && [ ! -e "$TARGET" ]; then mv "$DEPS/dsh" "$TARGET" || true; fi',
    '  if [ "$ACTIVE_MOVED" = 1 ] && [ -d "$BACKUP" ] && [ ! -e "$DEPS/dsh" ]; then mv "$BACKUP" "$DEPS/dsh" || true; fi',
    '  if [ "$HELD" = 1 ] && [ -d "$HOLDING" ] && [ ! -e "$BACKUP" ]; then mv "$HOLDING" "$BACKUP" || true; fi',
    '}',
    'fail() { rollback; rm -f "$TAG_NEW"; echo "REMOTE_CORE_SWITCH_FAILED: $1" >&2; exit 1; }',
    '[ -d "$DEPS/dsh" ] || fail "当前使用的核心目录不存在"',
    '[ -d "$TARGET" ] || fail "目标核心副本不存在"',
    'if [ -e "$BACKUP" ]; then',
    '  mv "$BACKUP" "$HOLDING" || fail "无法移走旧备份"',
    '  HELD=1',
    'fi',
    'mv "$DEPS/dsh" "$BACKUP" || fail "无法移走当前使用的核心"',
    'ACTIVE_MOVED=1',
    'mv "$TARGET" "$DEPS/dsh" || fail "无法启用目标核心副本"',
    'TARGET_MOVED=1',
    `printf '%s\\n' ${shQuote(targetTag)} > "$TAG_NEW" || fail "无法记录当前核心版本"`,
    'mv -f "$TAG_NEW" "$DEPS/.active-tag" || fail "无法保存当前核心版本"',
    'if [ "$HELD" = 1 ] && [ -e "$HOLDING" ]; then rm -rf "$HOLDING" || echo "REMOTE_CORE_SWITCH_WARNING: 旧备份清理失败" >&2; fi',
    'echo "REMOTE_CORE_SWITCH_READY"',
  ].join('\n')
}

/**
 * 切换要同时动两个槽位：当前使用的那份（`dsh`）与目标副本。
 * 两边都占住，才能和「下载同一版本」「两次切换」互斥。
 */
function switchSlotClaims(targetTag: string): string[] {
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
  ]
}

export function buildCoreSwitchRollbackScript(targetTag: string, backupTag: string, restoreTag: string | undefined, runId: string): string {
  assertSlotName(targetTag)
  assertSlotName(backupTag)
  assertSlotName(runId)
  if (restoreTag !== undefined)
    assertSlotName(restoreTag)
  const tagNew = `TAG_NEW="$DEPS/.active-tag.rollback.${runId}"`
  const restore = restoreTag === undefined
    ? 'rm -f "$DEPS/.active-tag"'
    : `printf '%s\\n' ${shQuote(restoreTag)} > "$TAG_NEW" && mv -f "$TAG_NEW" "$DEPS/.active-tag"`
  return [
    `ROOT="$HOME/${REMOTE_ROOT}"`,
    'DEPS="$ROOT/dependencies"',
    `TARGET="$DEPS/${targetTag}"`,
    `BACKUP="$DEPS/${backupTag}"`,
    tagNew,
    `TMP="$ROOT/tmp/switch-rollback-${runId}"`,
    'mkdir -p "$TMP"',
    `log() { printf '${BOOTSTRAP_LOG_PREFIX}%s %s\\n' "$1" "$2"; }`,
    'cleanup() { rm -rf "$TMP"; rm -f "$CLAIM_ACTIVE" "$CLAIM_TARGET"; }',
    'trap cleanup EXIT',
    ...switchSlotClaims(targetTag),
    '[ -d "$DEPS/dsh" ] || { echo "REMOTE_CORE_ROLLBACK_FAILED: 新核心目录不存在" >&2; exit 1; }',
    '[ -d "$BACKUP" ] || { echo "REMOTE_CORE_ROLLBACK_FAILED: 旧核心备份不存在" >&2; exit 1; }',
    '[ ! -e "$TARGET" ] || { echo "REMOTE_CORE_ROLLBACK_FAILED: 目标槽位已被占用" >&2; exit 1; }',
    'mv "$DEPS/dsh" "$TARGET" || { echo "REMOTE_CORE_ROLLBACK_FAILED: 无法移走新核心" >&2; exit 1; }',
    'mv "$BACKUP" "$DEPS/dsh" || { mv "$TARGET" "$DEPS/dsh" || true; echo "REMOTE_CORE_ROLLBACK_FAILED: 无法恢复旧核心" >&2; exit 1; }',
    `${restore} || { echo "REMOTE_CORE_ROLLBACK_FAILED: 无法恢复当前版本记录" >&2; exit 1; }`,
    'echo "REMOTE_CORE_SWITCH_ROLLED_BACK"',
  ].join('\n')
}

function validSlotName(value: string): boolean {
  return /^[\w.-]+$/u.test(value) && value !== '.' && value !== '..'
}

function assertSlotName(value: string): void {
  if (!validSlotName(value))
    throw new Error(`REMOTE_CORE_SLOT_INVALID: 非法版本目录名 ${value}`)
}
