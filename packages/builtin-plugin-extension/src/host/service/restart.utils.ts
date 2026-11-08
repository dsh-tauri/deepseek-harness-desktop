import type { LaunchSpec } from './restart.types'
import process from 'node:process'
import { dirname, resolve } from 'pathe'

const ASAR_SEGMENT_RE = /\.asar$/i

const ENTRY_RE = /[\\/](?:bin\.(?:js|ts)|dsh)$/

export function isAsarPath(path: string): boolean {
  return path.split(/[\\/]/).some(segment => ASAR_SEGMENT_RE.test(segment))
}

export function dshLaunch(
  argv: readonly string[] = process.argv,
  execArgv: readonly string[] = process.execArgv,
): LaunchSpec {
  const entry = argv[1]
  if (entry !== undefined && ENTRY_RE.test(entry)) {
    const abs = resolve(entry)
    // 归档内路径不能作为 cwd：交由子进程继承父进程的工作目录（桌面端为真实 core_dir）。
    return { file: process.execPath, args: [...execArgv, abs, ...argv.slice(2)], cwd: isAsarPath(abs) ? undefined : dirname(abs), viaShell: false }
  }
  return { file: 'dsh', args: [...argv.slice(2)], cwd: undefined, viaShell: process.platform === 'win32' }
}
