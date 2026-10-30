import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import process from 'node:process'
import { spawnDetached } from './spawn'

export async function openUrl(url: string): Promise<void> {
  if (process.platform === 'win32') {
    await spawnDetached('rundll32.exe', ['url.dll,FileProtocolHandler', url])
    return
  }
  await spawnDetached(process.platform === 'darwin' ? 'open' : 'xdg-open', [url])
}

export async function openDirectory(dir: string): Promise<void> {
  if (!statSync(dir).isDirectory())
    throw new Error(`Path is not a directory: ${dir}`)

  const normalizedDir = process.platform === 'win32' ? dir.replace(/\//g, '\\') : dir
  const launcher = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'

  await new Promise<void>((resolve, reject) => {
    const child = spawn(launcher, [normalizedDir], { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
