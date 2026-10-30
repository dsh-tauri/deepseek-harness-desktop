import type { RestartOutcome } from './restart.types'
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { defineService } from 'dsh-tauri'
import { dirname, resolve } from 'pathe'
import { PLUGIN_ID } from '../../shared/constants'

const RESTART_KILL_DELAY_MS = 500

export const restart = defineService({
  start(): RestartOutcome {
    if (restartOwnedByShell())
      return { owned: true }
    return { owned: false, ...scheduleRestart(dshLaunch()) }
  },
})

function dshLaunch(
  argv: readonly string[] = process.argv,
  execArgv: readonly string[] = process.execArgv,
): { file: string, args: string[], cwd: string | undefined, viaShell: boolean } {
  const entry = argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    const abs = resolve(entry)
    return { file: process.execPath, args: [...execArgv, abs, ...argv.slice(2)], cwd: dirname(abs), viaShell: false }
  }
  return { file: 'dsh', args: [...argv.slice(2)], cwd: undefined, viaShell: process.platform === 'win32' }
}

function scheduleRestart(
  launch: ReturnType<typeof dshLaunch>,
): { pid: number, replacementPid: number | undefined, logOut: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logOut = `${tmpdir()}${tmpdir().endsWith('/') ? '' : '\\'}${PLUGIN_ID}-restart-${stamp}.out.log`
  const logErr = logOut.replace('.out.log', '.err.log')
  const child = spawn(launch.file, launch.args, {
    cwd: launch.cwd,
    stdio: ['ignore', openSync(logOut, 'a'), openSync(logErr, 'a')],
    env: process.env,
    shell: launch.viaShell,
    windowsHide: true,
  })
  child.unref()
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), RESTART_KILL_DELAY_MS)
  return { pid: process.pid, replacementPid: child.pid, logOut }
}

function restartOwnedByShell(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DSH_DESKTOP === '1'
}
