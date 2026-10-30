import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDirectory, openUrl } from 'dsh-tauri'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configFile } from './config-file'

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  return { ...actual, openDirectory: vi.fn(), openUrl: vi.fn() }
})

describe('config file open', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-config-open-'))
    vi.stubEnv('DSH_HOME', home)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    await rm(home, { recursive: true, force: true })
  })

  it('opens the settings file with the system default', async () => {
    await writeFile(join(home, 'settings.yaml'), 'models: {}\n')
    expect(await configFile.open()).toEqual({ ok: true, path: join(home, 'settings.yaml'), opened: 'file' })
    expect(openUrl).toHaveBeenCalledWith(join(home, 'settings.yaml'))
    expect(openDirectory).not.toHaveBeenCalled()
  })

  it('opens the containing directory when settings do not exist', async () => {
    expect(await configFile.open()).toEqual({ ok: true, path: home, opened: 'directory' })
    expect(openDirectory).toHaveBeenCalledWith(home)
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('treats a directory named settings.yaml as no settings file and opens the containing directory', async () => {
    await mkdir(join(home, 'settings.yaml'))
    expect(await configFile.open()).toEqual({ ok: true, path: home, opened: 'directory' })
    expect(openDirectory).toHaveBeenCalledWith(home)
  })

  it('reports launcher failure instead of silently opening a different app', async () => {
    await writeFile(join(home, 'settings.yaml'), 'models: {}\n')
    vi.mocked(openUrl).mockRejectedValueOnce(new Error('No default application'))
    expect(await configFile.open()).toEqual({ ok: false, path: join(home, 'settings.yaml'), error: 'No default application' })
    expect(openDirectory).not.toHaveBeenCalled()
  })
})
