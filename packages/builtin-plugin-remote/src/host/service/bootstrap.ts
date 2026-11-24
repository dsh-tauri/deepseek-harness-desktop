import type { MachineProfile, RemoteSession } from '../types/index'
import type { BootstrapHooks, BootstrapInstallOptions, RemoteInstallPlan } from './bootstrap.types'
import { defineService } from 'dsh-tauri'
import { hostConfig } from '../config/runtime'
import { ensureRemoteInstance, restartRemoteInstance, runInstallScript } from './bootstrap.utils'

export const bootstrap = defineService({
  async provision(
    session: RemoteSession,
    profile: MachineProfile,
    hooks: BootstrapHooks = {},
  ): Promise<string> {
    return await ensureRemoteInstance(session, profile, hostConfig(), hooks)
  },

  async restart(
    session: RemoteSession,
    profile: MachineProfile,
    hooks: BootstrapHooks = {},
  ): Promise<string> {
    return await restartRemoteInstance(session, profile, hostConfig(), hooks)
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
