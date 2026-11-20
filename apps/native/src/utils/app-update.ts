import type { AppPlatform, AppRelease, AppReleaseAsset } from '@/apis/index.types'
import { APP_IOS_TESTFLIGHT_URL } from '@/config/constants'
import { isRecord } from '@/utils/bridge-protocol'

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

/** iOS 走 TestFlight 邀请链接：release 里的 ipa 未签名，无法直接安装。 */
export function pickDownloadUrl(release: AppRelease, platform: AppPlatform): string {
  if (platform === 'ios')
    return APP_IOS_TESTFLIGHT_URL
  const asset = release.assets.find(asset => asset.name.toLowerCase().endsWith('.apk'))
  return asset?.url ?? release.pageUrl
}
