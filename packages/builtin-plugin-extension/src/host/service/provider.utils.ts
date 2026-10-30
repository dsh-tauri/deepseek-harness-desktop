import type { FilesystemSkillPlugin, PlatformPluginLoader } from './provider.types'

export async function loadFilesystemSkillPlugin(loader: PlatformPluginLoader): Promise<FilesystemSkillPlugin> {
  return loader.unwrapExports(
    await loader.import('@deepseek-ai/dsh-skill-filesystem'),
  ) as FilesystemSkillPlugin
}
