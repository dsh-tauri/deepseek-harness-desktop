import type { FilesystemSkillPlugin, PlatformPluginLoader, PluginFiber } from '../service/provider.types'
import type { SkillsService } from '../service/skills.types'

export interface PanelExtensionHost {
  skills: SkillsService
  loader: PlatformPluginLoader
  plugin: (plugin: FilesystemSkillPlugin, config?: unknown) => PluginFiber
  logger: { error: (message: string) => void }
}
