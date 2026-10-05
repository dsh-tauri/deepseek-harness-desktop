import type { Context } from '@deepseek-ai/cordis'
import type z from 'schemastery'
import type { Config as RemoteConfig } from './config/schema'
import type { RemoteHostContext } from './types/index'
import { REMOTE_PLUGIN_NAME } from '../shared/constants'
import { clearHostRuntime, migrateLegacyState, setCurrentHostInstance, setHostConfig, setMachineDeps, setSyncDeps } from './config/runtime'
import { ConfigSchema } from './config/schema'
import { server } from './server'
import { panel } from './server/panel'
import { access } from './service/access'
import { gateway } from './service/gateway'
import { machine } from './service/machine'
import { transport } from './service/transport'
import { packSkills, profileAllowlistReader, profileDependenciesReader, skillRootsScanner } from './utils/local'

const REMOTE_START_EFFECT = `${REMOTE_PLUGIN_NAME}: start`

const REMOTE_ROUTES_EFFECT = `${REMOTE_PLUGIN_NAME}: routes`

const REMOTE_PANEL_EFFECT = `${REMOTE_PLUGIN_NAME}: panel routes`

const REMOTE_RUNTIME_EFFECT = `${REMOTE_PLUGIN_NAME}: host runtime`

export const name = REMOTE_PLUGIN_NAME

export const inject = ['webServer', 'connection']

export const Config: z<RemoteConfig> = ConfigSchema

export function apply(ctx: RemoteHostContext, config: RemoteConfig): void {
  setCurrentHostInstance(ctx)
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
    const migrationFailure = migrateLegacyState()
    if (migrationFailure !== undefined)
      ctx.logger?.warn?.(`${REMOTE_PLUGIN_NAME}: 旧状态目录迁移未完成，已按新目录空状态启动（旧文件未改动）: ${migrationFailure}`)
    void machine.start().catch(() => undefined)
    void access.restore().catch(() => undefined)
  }, REMOTE_START_EFFECT)

  ctx.effect(() => server(ctx as unknown as Context), REMOTE_ROUTES_EFFECT)

  ctx.effect(() => panel(ctx as unknown as Context), REMOTE_PANEL_EFFECT)

  ctx.effect(() => () => {
    void machine.dispose()
    void access.dispose()
    void gateway.dispose().catch(() => undefined)
    clearHostRuntime()
  }, REMOTE_RUNTIME_EFFECT)
}

export default { apply, Config, inject, name }
