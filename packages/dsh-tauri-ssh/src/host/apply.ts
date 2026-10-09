import type { Context } from '@deepseek-ai/cordis'
import type z from 'schemastery'
import type { Config as SshRemoteConfig } from './config/schema'
import type { SshHostContext } from './types/index'
import { SSH_PLUGIN_NAME } from '../shared/constants'
import { resetRuntime, setHostConfig, setMachineDeps, setSyncDeps } from './config/runtime'
import { ConfigSchema } from './config/schema'
import { server } from './server'
import { machine } from './service/machine'
import { transport } from './service/transport'
import { packSkills, profileAllowlistReader, profileDependenciesReader, skillRootsScanner } from './utils/local'

const SSH_START_EFFECT = `${SSH_PLUGIN_NAME}: start`

const SSH_ROUTES_EFFECT = `${SSH_PLUGIN_NAME}: routes`

const SSH_RUNTIME_EFFECT = `${SSH_PLUGIN_NAME}: host runtime`

export const name = SSH_PLUGIN_NAME

export const inject = ['webServer', 'connection']

export const Config: z<SshRemoteConfig> = ConfigSchema

export function apply(ctx: SshHostContext, config: SshRemoteConfig): void {
  setHostConfig(config)
  setMachineDeps({
    transport,
    emitStatus: () => {}, // keep: 进度出口注入点，故意留空——状态另经 status() 与事件环读取
    localAllowlist: profileAllowlistReader(),
  })
  setSyncDeps({
    profileDependencies: profileDependenciesReader(),
    scanSkills: skillRootsScanner(),
    packSkills,
    ...config.installTimeoutMs === undefined ? {} : { commandTimeoutMs: config.installTimeoutMs },
  })

  ctx.effect(() => {
    void machine.start().catch(() => undefined)
  }, SSH_START_EFFECT)

  ctx.effect(() => server(ctx as unknown as Context), SSH_ROUTES_EFFECT)

  ctx.effect(() => () => {
    void machine.dispose()
    resetRuntime()
  }, SSH_RUNTIME_EFFECT)
}

export default { apply, Config, inject, name }
