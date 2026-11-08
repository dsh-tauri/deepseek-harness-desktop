import process from 'node:process'
import { dirname, resolve } from 'pathe'
import { describe, expect, it } from 'vitest'
import { dshLaunch, isAsarPath } from './restart.utils'

const asarEntry = 'C:\\Users\\someone\\AppData\\Roaming\\dsh-tauri\\dependencies\\dsh\\deepseek-harness-pkg-windows.asar\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'

const cliEntry = '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'

describe('isAsarPath', () => {
  it('detects an asar segment on windows and posix entries', () => {
    expect(isAsarPath(asarEntry)).toBe(true)
    expect(isAsarPath('/opt/dsh/deepseek-harness-pkg-linux-x64.asar/node_modules/@deepseek-ai/dsh/lib/bin.js')).toBe(true)
  })

  it('accepts real directories, including electron unpacked siblings', () => {
    expect(isAsarPath(cliEntry)).toBe(false)
    expect(isAsarPath('/opt/dsh/app.asar.unpacked/node_modules/@deepseek-ai/dsh/lib/bin.js')).toBe(false)
  })
})

describe('dshLaunch', () => {
  it('does not use a path inside the asar archive as cwd', () => {
    const launch = dshLaunch(['node', asarEntry, '--port', '3080'], ['--inspect=127.0.0.1:9229'])
    expect(launch.cwd).toBeUndefined()
    expect(launch.file).toBe(process.execPath)
    expect(launch.viaShell).toBe(false)
    expect(launch.args).toEqual(['--inspect=127.0.0.1:9229', resolve(asarEntry), '--port', '3080'])
  })

  it('keeps dirname of the entry as cwd for a plain cli installation', () => {
    const launch = dshLaunch(['node', cliEntry, '--port', '3080'], [])
    expect(launch.cwd).toBe(dirname(resolve(cliEntry)))
    expect(launch.args).toEqual([resolve(cliEntry), '--port', '3080'])
  })

  it('falls back to the dsh executable when the entry is not a launcher', () => {
    const launch = dshLaunch(['dsh', '--port', '3080'])
    expect(launch.file).toBe('dsh')
    expect(launch.cwd).toBeUndefined()
    expect(launch.viaShell).toBe(process.platform === 'win32')
  })
})
