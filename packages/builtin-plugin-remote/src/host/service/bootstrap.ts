import type { MachineProfile, RemoteSession } from '../types/index'
import type { BootstrapHooks, BootstrapInstallOptions, RemoteInstallPlan } from './bootstrap.types'
import { defineService } from 'dsh-tauri'
import { hostConfig } from '../config/runtime'
import { ensureRemoteInstance, runInstallScript } from './bootstrap.utils'

export const bootstrap = defineService({
  async provision(
    session: RemoteSession,
    profile: MachineProfile,
    hooks: BootstrapHooks = {},
  ): Promise<string> {
    return await ensureRemoteInstance(session, profile, hostConfig(), hooks)
  },

  async install(
    session: RemoteSession,
    plan: RemoteInstallPlan,
    hooks: BootstrapHooks = {},
    options: BootstrapInstallOptions = {},
  ): Promise<string[]> {
    return await runInstallScript(
      session,
      plan,
      hostConfig().installTimeoutMs!,
      hooks,
      options.failureLine ?? 'bootstrap 失败',
      options.force === true,
    )
  },
})
