import type { TestProject } from 'vitest/node'
import process from 'node:process'
import { startDshHost } from './dsh'

declare module 'vitest' {
  export interface ProvidedContext {
    dshBaseUrl: string
    dshUrl: string
    dshCookie: string
    dshHome: string
    dshMounted: string[]
    dshCoreVersion: string
  }
}

const DEFAULT_ALSO = [
  'dsh-tauri',
  'dsh-tauri-rightclick',
  'dsh-tauri-archive',
  'dsh-tauri-worktree',
  'dsh-tauri-ui',
  'dsh-tauri-mobile-ui',
  'dsh-tauri-extension',
  'dsh-tauri-scheduler',
  'dsh-tauri-model',
  'dsh-tauri-remote',
].join(',')

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const plugin = process.env.DSH_E2E_PLUGIN ?? 'dsh-tauri-pet'
  const also = (process.env.DSH_E2E_ALSO ?? DEFAULT_ALSO).split(',').map(item => item.trim()).filter(Boolean)
  const host = await startDshHost({ plugin, also, keepHome: process.env.DSH_E2E_KEEP_HOME === '1' })

  project.provide('dshBaseUrl', host.baseUrl)
  project.provide('dshUrl', host.url)
  project.provide('dshCookie', host.cookie)
  project.provide('dshHome', host.home)
  project.provide('dshMounted', [...host.mounted])
  project.provide('dshCoreVersion', host.coreVersion)

  return async () => {
    await host.stop()
  }
}
