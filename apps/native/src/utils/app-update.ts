import type { AppPlatform, AppRelease, AppReleaseAsset } from '@/apis/index.types'
import { isRecord } from '@/utils/bridge-protocol'

const PLATFORM_EXTENSIONS: Record<AppPlatform, string> = { android: '.apk', ios: '.ipa' }

export function parseVersion(value: string): number[] | null {
  const normalized = value.trim().replace(/^v/i, '').split('-')[0] ?? ''
  if (!normalized)
    return null
  const segments = normalized.split('.')
  if (!segments.every(segment => /^\d+$/.test(segment)))
    return null
  return segments.map(Number)
}

export function isNewerVersion(latest: string, current: string): boolean {
  const next = parseVersion(latest)
  const base = parseVersion(current)
  if (!next || !base)
    return false
  for (let index = 0; index < Math.max(next.length, base.length); index++) {
    const left = next[index] ?? 0
    const right = base[index] ?? 0
    if (left !== right)
      return left > right
  }
  return false
}

export function parseLatestRelease(payload: unknown): AppRelease | null {
  if (!isRecord(payload))
    return null
  const { tag_name: tag, html_url: pageUrl, assets } = payload
  if (typeof tag !== 'string' || typeof pageUrl !== 'string' || !Array.isArray(assets))
    return null
  const version = tag.trim().replace(/^v/i, '')
  if (!parseVersion(version) || !pageUrl)
    return null
  const parsed: AppReleaseAsset[] = []
  for (const asset of assets) {
    if (!isRecord(asset) || typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string')
      continue
    parsed.push({ name: asset.name, url: asset.browser_download_url })
  }
  return { version, pageUrl, assets: parsed }
}

export function pickDownloadUrl(release: AppRelease, platform: AppPlatform): string {
  const extension = PLATFORM_EXTENSIONS[platform]
  const asset = release.assets.find(asset => asset.name.toLowerCase().endsWith(extension))
  return asset?.url ?? release.pageUrl
}
