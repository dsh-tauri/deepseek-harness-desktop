import type { BridgeManifest, GetManifestPaths } from './index.types'
import { MANIFEST_PATH } from '@/config/constants'
import { isBridgeManifest } from '@/utils/bridge-protocol'

export async function getManifest(paths: GetManifestPaths, init?: RequestInit): Promise<BridgeManifest | null> {
  const response = await fetch(new URL(MANIFEST_PATH, paths.baseURL).toString(), {
    headers: { Accept: 'application/manifest+json' },
    cache: 'no-store',
    redirect: 'error',
    ...init,
  })

  if (!response.ok)
    return null

  const data: unknown = await response.json()
  return isBridgeManifest(data) ? data : null
}
