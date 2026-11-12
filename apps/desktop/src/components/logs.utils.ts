/** DSH 发行版 GitHub Release 下载 URL 前缀：日志展示时剥离，避免整段长 URL 占满一行 */
const DSH_RELEASE_URL_PREFIX = 'https://github.com/dsh-tauri/deepseek-harness-pkg/releases/download/'
/** GitHub 代理镜像的透传包装前缀（与官方 URL 拼接），同样剥离 */
const DSH_MIRROR_URL_PREFIXES = [
  'https://gh-proxy.com/',
  'https://gh.llkk.cc/',
  'https://ghfast.top/',
  'https://ghproxy.net/',
]

/** 日志中认定为「错误行」的标记（大小写不敏感） */
const ERROR_LINE_MARKERS = /error|duplicate|fatal|panic|throw|✖|exception|failed/i
/**
 * 启动卡点行的标记：插件停在 `pending (waiting for service: …)`，或 MCP 客户端在连接/握手
 * 阶段停滞时报出的 `mcp-client(<server>)` 行。这些行没有任何 error/failed 字样，却往往是
 * 唯一能指名「卡在哪个条目」的证据，因此必须与错误行一起保留（issue #1503）。
 */
const STARTUP_STALL_MARKERS = /pending \(waiting for services?:|mcp-client\(/

/**
 * 精简下载日志行：把 GitHub Release 下载 URL 缩短为「版本 tag / 文件名」，
 * 让日志里"正在下载的是什么"一目了然（如 `Download dsh-0.1.1-rc.1-32457794457/...zip`）。
 * 用 split/join 代替 replaceAll 以保证各构建目标下行为一致。
 */
export function formatLogLine(line: string): string {
  let formatted = line.split(DSH_RELEASE_URL_PREFIX).join('')
  for (const prefix of DSH_MIRROR_URL_PREFIXES) formatted = formatted.split(prefix).join('')
  return formatted
}

/**
 * 从日志行中挑出能定位失败的证据行（最多 8 行）：致命报告 → 启动卡点行 → 错误行；
 * 全都命不中才退回最后 8 行。卡点行必须完整保留，否则错误页只剩「启动失败」，
 * 用户和日志里都看不出卡在哪个插件上（issue #1503）。
 * 纯函数：仅依赖字符串输入，便于单元测试。
 */
export function pickErrorLines(lines: readonly string[]): string[] {
  const isReport = (line: string) => line.startsWith('ERROR HARNESS_FATAL_REPORT: ')
  const isStall = (line: string) => !isReport(line) && STARTUP_STALL_MARKERS.test(line)
  const reports = lines.filter(isReport).slice(-8)
  const room = Math.max(0, 8 - reports.length)
  const stalls = room === 0 ? [] : lines.filter(isStall).slice(-Math.min(4, room))
  const errors = lines.filter(line => !isReport(line) && !isStall(line) && ERROR_LINE_MARKERS.test(line))
  const errorBudget = room - stalls.length
  const errored = errorBudget > 0 ? errors.slice(-errorBudget) : []
  const terminal = errors.findLast(line => /^(?:error|fatal|panic)\b/i.test(line))
  if (errored.length > 0 && terminal !== undefined && !errored.includes(terminal))
    errored[0] = terminal
  const picked = [...errored, ...stalls, ...reports]
  return picked.length > 0 ? picked : lines.slice(-8)
}

/**
 * 判断日志是否命中 Linux 的 inotify 文件监视上限（ENOSPC）错误。
 *
 * harness 服务（dsh web）会用 chokidar 递归监视 `$DSH_HOME/profiles/*`，
 * 当系统 `fs.inotify.max_user_watches` 上限过低（常见于 Docker/容器或新装 Ubuntu
 * 默认值偏小）时，node 会抛 `ENOSPC: System limit for number of file watchers
 * reached` 并直接退出，表现为「服务启动即崩溃」。这类错误对用户无解，必须提示
 * 调高系统参数（见 errors.inotify_limit 文案）。纯函数，便于单元测试。
 */
export function containsInotifyLimitError(lines: readonly string[]): boolean {
  return lines.some(line => /ENOSPC/i.test(line) && /file watchers/i.test(line))
}

export function containsHeapOomError(lines: readonly string[]): boolean {
  return lines.some(line => /JavaScript heap out of memory|Ineffective mark-compacts near heap limit/i.test(line))
}

/**
 * 端口被占用导致的启动失败（`listen EADDRINUSE: address already in use`）。
 *
 * dsh 在启动早期派生迁移/恢复用的 CLI 子进程，那个子进程继承同一个
 * `--port` 并去 bind 已被父进程占住的端口，于是 webserver（required）判定失败、
 * 整个 dsh 以 code 1 退出。配置端口在启动前必然空闲，因此这个命中意味着端口在
 * 本次启动过程中被别的进程占了——重启换一个端口即可能成功，无需用户介入。
 * 纯函数，便于单元测试。
 */
export function containsPortInUseError(lines: readonly string[]): boolean {
  return lines.some(line => /EADDRINUSE/i.test(line) && /address already in use/i.test(line))
}

/** V8 GC 追踪行：`Mark-Compact 8058.3 (8224.0) -> 8051.0 (8234.2) MB`，最后一个括号里是提交的堆总量 */
const HEAP_COMMITTED_MB = /\(\d+(?:\.\d+)?\)\s*->[^(]*\((\d+(?:\.\d+)?)\)\s*MB/

/**
 * 从日志尾部取崩溃瞬间实际提交到的堆上限（MB，取整）。
 *
 * V8 堆耗尽时会把 GC 追踪行写进日志，括号里的第二个数就是当时的堆总量；
 * 它通常略高于配置上限（V8 会略微超发），因此比"设置页里现在填了什么"
 * 更能说明崩溃现场的真实上限。没有 GC 追踪行时返回 undefined。
 */
export function heapPeakFromLogs(lines: readonly string[]): number | undefined {
  let peak: number | undefined
  for (const line of lines) {
    const matched = HEAP_COMMITTED_MB.exec(line)
    if (!matched) {
      continue
    }
    const committed = Number(matched[1])
    if (!Number.isFinite(committed)) {
      continue
    }
    const mb = Math.floor(committed)
    peak = peak === undefined ? mb : Math.max(peak, mb)
  }
  return peak
}
