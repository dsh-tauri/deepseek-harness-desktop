import type { AppRelease, BridgeManifest, GetManifestPaths } from './index.types'
import { APP_RELEASE_API_URL, MANIFEST_PATH } from '@/config/constants'
import { parseLatestRelease } from '@/utils/app-update'
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

export async function getLatestAppRelease(): Promise<AppRelease | null> {
  const response = await fetch(APP_RELEASE_API_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  })

  if (!response.ok)
    return null

  const data: unknown = await response.json()
  return parseLatestRelease(data)
}
