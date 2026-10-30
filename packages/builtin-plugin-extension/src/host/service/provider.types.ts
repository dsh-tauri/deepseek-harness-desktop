import type { HostPluginLoader } from 'dsh-tauri'

export interface PlatformPluginLoader extends HostPluginLoader {}

export interface FilesystemSkillPlugin {
  name: string
  apply: (context: unknown, config?: unknown) => void
}

export interface PluginFiber {
  dispose: () => Promise<void>
}

export interface ProviderRuntime {
  fiber: PluginFiber | undefined
  chain: Promise<void>
  disposed: boolean
}
