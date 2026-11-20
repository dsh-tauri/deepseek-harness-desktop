import type { MachineProfile, RemoteSession } from '../types/index'
import type { BootstrapHooks, BootstrapInstallOptions, RemoteInstallPlan } from './bootstrap.types'
import type { EnsureRemoteInstanceOptions } from './bootstrap.utils'
import { defineService } from 'dsh-tauri'
import { hostConfig } from '../config/runtime'
import { ensureRemoteInstance, runInstallScript } from './bootstrap.utils'

export const bootstrap = defineService({
  async provision(
    session: RemoteSession,
    profile: MachineProfile,
    hooks: BootstrapHooks = {},
    options: EnsureRemoteInstanceOptions = {},
  ): Promise<string> {
    return await ensureRemoteInstance(session, profile, hostConfig(), hooks, options)
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
      {
        ...(options.failureLine === undefined ? {} : { failureLine: options.failureLine }),
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.profileName === undefined ? {} : { profileName: options.profileName }),
        ...(options.remotePort === undefined ? {} : { remotePort: options.remotePort }),
      },
    )
  },
})
