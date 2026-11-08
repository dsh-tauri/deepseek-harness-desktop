import type { LaunchSpec, RestartOutcome } from './restart.types'
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { defineService } from 'dsh-tauri'
import { join } from 'pathe'
import { PLUGIN_ID } from '../../shared/constants'
import { dshLaunch } from './restart.utils'

const RESTART_KILL_DELAY_MS = 500

export const restart = defineService({
  start(): RestartOutcome {
    return scheduleRestart(dshLaunch())
  },
})

function scheduleRestart(launch: LaunchSpec): RestartOutcome {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logOut = join(tmpdir(), `${PLUGIN_ID}-restart-${stamp}.out.log`)
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
