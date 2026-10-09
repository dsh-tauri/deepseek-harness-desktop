import type { HostContext } from 'dsh-tauri'
import type { Config } from './apply.types'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'pathe'
import { PLUGIN_ID } from '../shared/constants'
import { disposeProviderRuntime, resetProviderRuntime } from './config/runtime'
import { server } from './server'
import { profile } from './service/profile'
import { provider } from './service/provider'

const DEFAULT_PROFILE = 'web'

export type { Config } from './apply.types'

export const name = PLUGIN_ID

export const inject = ['webServer', 'skills', 'connection']

export { loadFilesystemSkillPlugin } from './service/provider.utils'

export function packagedSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
}

export function apply(ctx: HostContext, config?: Config): void {
  ctx.inject(inject, (hostCtx) => {
    resetProviderRuntime()
    const remountProvider = (): Promise<void> => provider.start(packagedSkillsDir())
    const hotReload = (): boolean => {
      try {
        return hostCtx.get('hmr') !== undefined
      }
      catch {
        return false
      }
    }
    const profileDirPath = profile.peek(config?.profile ?? profile.resolve() ?? DEFAULT_PROFILE)
    ctx.effect(
      () => server(hostCtx, { profileDirPath, remountProvider, hotReload }),
      'dsh-tauri-extension: routes',
    )
    ctx.effect(() => {
      void remountProvider()
      return disposeProviderRuntime
    }, 'dsh-tauri-extension: skill provider')
    return disposeProviderRuntime
  })
}
