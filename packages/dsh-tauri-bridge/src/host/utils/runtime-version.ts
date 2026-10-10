import type { PlatformLoader } from '../types'

const RUNTIME_PACKAGE = '@deepseek-ai/dsh-app-boot'

function runtimeExport(loader: PlatformLoader, value: unknown, key: string): unknown {
  const direct = (value as Record<string, unknown> | null)?.[key]
  if (direct !== undefined)
    return direct
  return (loader.unwrapExports(value) as Record<string, unknown> | null)?.[key]
}

export async function runtimeVersion(loader: PlatformLoader): Promise<string | null> {
  try {
    const version = runtimeExport(loader, await loader.import(RUNTIME_PACKAGE), 'getDshRuntimeVersion')
    if (typeof version !== 'function')
      return null
    const value = (version as () => unknown)()
    return typeof value === 'string' && value.trim() !== '' ? value : null
  }
  catch {
    return null
  }
}
