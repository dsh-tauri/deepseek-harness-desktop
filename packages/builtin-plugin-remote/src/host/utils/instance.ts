import type { RemoteSession } from '../types/index'
import { remotePidfile } from '../config/constants'

/**
 * 端口上的监听进程快照：操作系统、pid、工作目录、进程标识与完整 argv。
 *
 * 端口就是实例的身份：谁占着这个端口，谁就是这个端口上的实例。lsof 与 ss 至少要有一个，
 * 否则报 TOOLS_MISSING——认不出身份不等于身份不对。issue #1574。
 */
export function listenerSnapshotCommand(port: number): string {
  return [
    'fail() { echo "REMOTE_DSH_LISTENER_$1" >&2; exit 1; }',
    'OS=$(uname -s) || fail PLATFORM',
    'case "$OS" in Linux|Darwin) ;; *) fail PLATFORM ;; esac',
    `if command -v lsof >/dev/null 2>&1; then PIDS=$(lsof -a -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null | sort -u)`,
    `elif [ "$OS" = Linux ] && command -v ss >/dev/null 2>&1; then PIDS=$(ss -H -lntp 'sport = :${port}' 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)`,
    'else fail TOOLS_MISSING; fi',
    'set -f; set -- $PIDS; [ "$#" -eq 1 ] || fail PID_MISSING_OR_MULTIPLE',
    'REMOTE_DSH_LISTENER_PID=$1',
    'case "$REMOTE_DSH_LISTENER_PID" in ""|*[!0-9]*) fail PID_INVALID ;; esac',
    'if [ "$OS" = Linux ]; then',
    '  CWD=$(readlink "/proc/$REMOTE_DSH_LISTENER_PID/cwd") || fail CWD_UNREADABLE',
    '  STAMP=$(stat -Lc "%d:%i" "/proc/$REMOTE_DSH_LISTENER_PID") || fail PROCESS_UNREADABLE',
    '  [ -r "/proc/$REMOTE_DSH_LISTENER_PID/cmdline" ] || fail COMMAND_UNREADABLE',
    '  printf "%s\\n" "$OS" "$REMOTE_DSH_LISTENER_PID" "$CWD" "$STAMP"',
    '  cat "/proc/$REMOTE_DSH_LISTENER_PID/cmdline" || fail COMMAND_UNREADABLE',
    'else',
    '  CWD=$(lsof -a -p "$REMOTE_DSH_LISTENER_PID" -d cwd -Fn 2>/dev/null | sed -n "s/^n//p") || fail CWD_UNREADABLE',
    '  STAMP=$(ps -p "$REMOTE_DSH_LISTENER_PID" -o lstart=) || fail PROCESS_UNREADABLE',
    '  ARGS=$(ps -ww -p "$REMOTE_DSH_LISTENER_PID" -o command=) || fail COMMAND_UNREADABLE',
    '  printf "%s\\n" "$OS" "$REMOTE_DSH_LISTENER_PID" "$CWD" "$STAMP" "$ARGS"',
    'fi',
  ].join('\n')
}

export interface ListenerIdentity {
  os: string
  pid: string
  cwd: string
  stamp: string
  argv: string[]
}

export function parseListenerSnapshot(stdout: string): ListenerIdentity | undefined {
  const [os, pid, cwd, stamp, ...rest] = stdout.split('\n')
  if (!['Linux', 'Darwin'].includes(os ?? '') || !/^\d+$/u.test(pid ?? '') || !cwd?.startsWith('/') || !stamp?.trim())
    return undefined
  const argv = os === 'Linux' ? rest.join('\n').split('\0') : rest.join('\n').trim().split(/\s+/u)
  return { os: os ?? '', pid: pid ?? '', cwd: cwd ?? '', stamp: stamp ?? '', argv }
}

/** 启动参数里的远端档案名：认不出就是 undefined（不是「档案不对」）。 */
export function profileOfArgv(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--profile')
  const value = index === -1 ? undefined : argv[index + 1]
  return value !== undefined && value !== '' && !value.startsWith('-') ? value : undefined
}

/**
 * 端口上的实例属于哪个远端档案。
 *
 * 读不到就是 undefined：远端缺 lsof/ss、实例不是桌面拉起来的、argv 里没有 --profile，
 * 都属于「认不出」。只有读出另一个档案名才算「认得出且不是它」。issue #1574。
 */
export async function readListenerProfile(session: RemoteSession, port: number): Promise<string | undefined> {
  try {
    const snapshot = await session.exec(listenerSnapshotCommand(port))
    if (snapshot.code !== 0)
      return undefined
    const identity = parseListenerSnapshot(snapshot.stdout)
    return identity === undefined ? undefined : profileOfArgv(identity.argv)
  }
  catch {
    return undefined
  }
}

/**
 * 端口上的实例必须是自己以为的那个档案。
 *
 * 认不出档案（远端缺 lsof/ss、实例不是桌面拉起来的）不算错：那种情况下没有证据说
 * 端口上跑的是别人的实例。认得出且不是它，就必须报错而不是静默复用。issue #1574。
 */
export async function assertListenerProfile(session: RemoteSession, port: number, expectedProfile: string): Promise<void> {
  const actual = await readListenerProfile(session, port)
  if (actual === undefined || actual === expectedProfile)
    return
  throw new Error(`REMOTE_INSTANCE_PROFILE_MISMATCH: 端口 ${port} 上跑的是远端档案「${actual}」，本机这条远端机器配的是「${expectedProfile}」`)
}

export interface RemoteSlotClaimOptions {
  lockVar?: string
  claimVar?: string
  claimName?: string
  tmpClaim?: string
  busyText?: string
  busyCode?: string
}

/**
 * 远端槽位的占用声明：同一槽位只允许一个操作在跑。
 *
 * 锁不是「一把锁」，而是槽位目录下的一组**占用声明**：每个操作脚本发布一条
 * `claim-<pid>` 声明，声明内容就是自己的进程号。
 *
 * - 声明与持有者 pid 一起原子发布（`ln` 一个已经写好 pid 的文件），
 *   不存在「声明已在但不知道是谁持有」的窗口。
 * - 同一时刻只允许一条存活的声明：别人的声明还活着就明确失败（`REMOTE_CORE_SLOT_BUSY`）。
 * - 回收陈旧声明时只删**进程已经不在**的那一条，活着的持有者的声明不会被碰。
 * - 锁目录本身从不被搬动或替换，因此不存在「按先前读到的 pid 搬走当前锁」的窗口——
 *   这正是单一锁路径方案里最容易被忽略的竞态。
 *
 * 插件同步与核心切换、强制重装共用「活动槽位」这一把锁：谁在动这个实例脚下的目录，
 * 谁就得先占住它。
 */
export function remoteSlotClaimShell(slot: string, options: RemoteSlotClaimOptions = {}): string[] {
  const lockVar = options.lockVar ?? 'LOCKDIR'
  const claimVar = options.claimVar ?? 'CLAIM'
  const claimName = options.claimName ?? 'claim-$$'
  const tmpClaim = options.tmpClaim ?? 'claim.$$'
  const busyText = options.busyText ?? '该版本槽位已有安装正在进行'
  const busyCode = options.busyCode === undefined ? 'REMOTE_CORE_SLOT_BUSY' : `REMOTE_CORE_SLOT_BUSY:${options.busyCode}`
  return [
    `${lockVar}="$ROOT/tmp/slot-${slot}.lock"`,
    `${claimVar}="$${lockVar}/${claimName}"`,
    // 上一版用的是文件形态的锁，先按老规矩处理：持有者还在就明确失败，
    // 持有者已经不在就把这份旧锁清掉，否则这个路径会挡住新的声明目录。
    `if [ -f "$${lockVar}" ]; then`,
    `  _old="$(cat "$${lockVar}" 2>/dev/null || true)"`,
    '  if [ -n "$_old" ] && kill -0 "$_old" 2>/dev/null; then',
    `    log failed "${busyCode}: ${busyText}（pid $_old），请等它结束后重试"`,
    '    exit 17',
    '  fi',
    `  rm -f "$${lockVar}"`,
    'fi',
    `mkdir -p "$${lockVar}"`,
    `printf '%s\\n' "$$" > "$TMP/${tmpClaim}"`,
    // ln 是原子的：声明与持有者 pid 同时出现，不存在「声明已在但不知道是谁」的窗口。
    `ln "$TMP/${tmpClaim}" "$${claimVar}" 2>/dev/null || true`,
    `if [ ! -f "$${claimVar}" ]; then`,
    '  rm -rf "$TMP"',
    `  log failed "REMOTE_CORE_LOCK_FAILED: 无法在 $${lockVar} 下发布占用声明"`,
    '  exit 18',
    'fi',
    // 同一时刻只允许一条存活的占用声明：别的声明还活着就明确失败。
    `for _f in "$${lockVar}"/claim-*; do`,
    '  [ -f "$_f" ] || continue',
    `  if [ "$_f" = "$${claimVar}" ]; then continue; fi`,
    '  _pid="$(cat "$_f" 2>/dev/null || true)"',
    '  [ -n "$_pid" ] || continue',
    '  if kill -0 "$_pid" 2>/dev/null; then',
    // 退出清理还没挂上（trap 在拿锁之后才注册），这里要自己收尾：
    // 删掉自己的声明与本次临时目录，别在远端留下垃圾。
    `    rm -f "$${claimVar}"`,
    '    rm -rf "$TMP"',
    `    log failed "${busyCode}: ${busyText}（pid $_pid），请等它结束后重试"`,
    '    exit 17',
    '  fi',
    // 持有者已经不在：清掉这条陈旧声明。这里只动已经死掉的进程留下的声明，
    // 活着的持有者的声明不会被碰，锁目录也不会被整体搬走。
    '  rm -f "$_f"',
    'done',
  ]
}

/**
 * 停掉远端实例的命令。
 *
 * 停不掉就是停不掉：换树与重装都要动这个实例脚下的目录，实例还活着就动手，
 * 等于把共享实例的插件换成半套。因此这里等它真的退出，退出不了就失败。
 */
export function remoteInstanceStopCommand(profileName: string, remotePort: number): string[] {
  const pidfile = `$HOME/${remotePidfile(remotePort)}`
  return [
    `PROFILE="${profileName}"`,
    `PORT="${remotePort}"`,
    'ARGV="bin.js --profile $PROFILE --host 127.0.0.1 --port $PORT"',
    'PATTERN="$ARGV( |$)"',
    'TARGETS=""',
    `if [ -f "${pidfile}" ]; then`,
    `  OLD_PID="$(cat "${pidfile}" 2>/dev/null || true)"`,
    '  case "$OLD_PID" in',
    '    "" | *[!0-9]*) ;;',
    '    *)',
    '      OLD_ARGS="$(ps -p "$OLD_PID" -o args= 2>/dev/null || true)"',
    '      if [ -z "$OLD_ARGS" ] || printf \'%s\' "$OLD_ARGS" | grep -Eq "$PATTERN"; then',
    '        TARGETS="$TARGETS $OLD_PID "',
    '      fi',
    '      ;;',
    '  esac',
    'fi',
    // pgrep 与 pkill 用同一个匹配串。匹配串在运行期拼出来，脚本自己的命令行里只有未展开的变量，命中不了自己。
    'if command -v pgrep >/dev/null 2>&1; then',
    '  for _p in $(pgrep -f "$PATTERN" 2>/dev/null || true); do',
    '    case "$TARGETS" in *" $_p "*) ;; *) TARGETS="$TARGETS $_p " ;; esac',
    '  done',
    'fi',
    'for _p in $TARGETS; do kill "$_p" 2>/dev/null || true; done',
    'pkill -f "$PATTERN" 2>/dev/null || true',
    // 端口还在应答就说明实例（或别的进程）还占着它：没有下载器时这项判不了，只能看进程。
    '_port_busy() {',
    '  if [ -n "$(command -v curl)" ]; then',
    '    curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/" 2>/dev/null && return 0',
    '    return 1',
    '  fi',
    '  if [ -n "$(command -v wget)" ]; then',
    '    wget -q -T 1 -O /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && return 0',
    '    return 1',
    '  fi',
    '  return 1',
    '}',
    '_i=0',
    'while [ $_i -lt 50 ]; do',
    '  _alive=""',
    '  for _p in $TARGETS; do',
    '    if kill -0 "$_p" 2>/dev/null; then _alive="$_alive $_p"; fi',
    '  done',
    '  if [ -z "$_alive" ] && ! _port_busy; then break; fi',
    '  _i=$((_i+1))',
    '  sleep 0.2',
    'done',
    'if [ -n "$_alive" ] || _port_busy; then',
    '  echo "REMOTE_INSTANCE_STOP_FAILED: 远端实例（端口 $PORT）没有退出，先停掉它再重试" >&2',
    '  exit 19',
    'fi',
  ]
}
