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

interface HmrHandle {
  runExclusive: <T>(operation: () => Promise<T>) => Promise<T>
  reconcileProfile?: () => Promise<{ restartReason?: string }>
}

export const name = PLUGIN_ID

export const inject = ['webServer', 'skills', 'connection', 'credentials']

export { loadFilesystemSkillPlugin } from './service/provider.utils'

export function packagedSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
}

export function apply(ctx: HostContext, config?: Config): void {
  ctx.inject(inject, (hostCtx) => {
    resetProviderRuntime()
    const remountProvider = (): Promise<void> => provider.start(packagedSkillsDir())
    const hmr = (): HmrHandle | undefined => {
      try {
        return hostCtx.get('hmr') as HmrHandle | undefined
      }
      catch {
        return undefined
      }
    }
    const hotReload = (): boolean => hmr() !== undefined
    const reload = async (): Promise<boolean> => {
      const handle = hmr()
      if (handle?.reconcileProfile === undefined)
        return handle !== undefined
      try {
        const outcome = await handle.runExclusive(() => handle.reconcileProfile!())
        return outcome.restartReason === undefined
      }
      catch {
        return false
      }
    }
    const profileDirPath = profile.peek(config?.profile ?? profile.resolve() ?? DEFAULT_PROFILE)
    ctx.effect(
      () => server(hostCtx, { profileDirPath, remountProvider, hotReload, reload }),
      'dsh-tauri-extension: routes',
    )
    ctx.effect(() => {
      void remountProvider()
      return disposeProviderRuntime
    }, 'dsh-tauri-extension: skill provider')
    return disposeProviderRuntime
  })
}
