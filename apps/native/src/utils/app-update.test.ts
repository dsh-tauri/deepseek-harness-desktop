import { describe, expect, it } from 'vitest'
import { isNewerVersion, parseLatestRelease, parseVersion, pickDownloadUrl } from './app-update'

const pageUrl = 'https://github.com/dsh-tauri/deepseek-harness-desktop/releases/tag/v0.33.0'
const apkUrl = 'https://github.com/dsh-tauri/deepseek-harness-desktop/releases/download/v0.33.0/Deepseek.Harness.Android_0.33.0.apk'
const ipaUrl = 'https://github.com/dsh-tauri/deepseek-harness-desktop/releases/download/v0.33.0/Deepseek.Harness.iOS_0.33.0_unsigned.ipa'

function payload(assets: unknown[] = []) {
  return { tag_name: 'v0.33.0', html_url: pageUrl, assets }
}

function asset(name: string, url: string) {
  return { name, browser_download_url: url }
}

describe('parseVersion', () => {
  it('accepts a release tag with or without the v prefix', () => {
    expect(parseVersion('v0.33.0')).toEqual([0, 33, 0])
    expect(parseVersion('0.33.0')).toEqual([0, 33, 0])
  })

  it('drops a pre-release suffix so only the numeric core is compared', () => {
    expect(parseVersion('v0.33.0-beta.2')).toEqual([0, 33, 0])
  })

  it('rejects empty, non-numeric and negative segments', () => {
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('v')).toBeNull()
    expect(parseVersion('latest')).toBeNull()
    expect(parseVersion('0.x.0')).toBeNull()
    expect(parseVersion('0.-1.0')).toBeNull()
  })
})

describe('isNewerVersion', () => {
  it('reports a strictly greater release as an update', () => {
    expect(isNewerVersion('v0.33.0', '0.32.0')).toBe(true)
    expect(isNewerVersion('0.33.0', '0.32.9')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true)
  })

  it('treats equal versions and the v prefix difference as no update', () => {
    expect(isNewerVersion('v0.32.0', '0.32.0')).toBe(false)
    expect(isNewerVersion('0.32.0', '0.32.0')).toBe(false)
  })

  it('reports an older release as no update', () => {
    expect(isNewerVersion('0.31.9', '0.32.0')).toBe(false)
    expect(isNewerVersion('0.32.0', '0.32.1')).toBe(false)
  })

  it('returns false instead of throwing when either side is not a version', () => {
    expect(isNewerVersion('latest', '0.32.0')).toBe(false)
    expect(isNewerVersion('0.33.0', '')).toBe(false)
    expect(isNewerVersion('', '')).toBe(false)
  })
})

describe('parseLatestRelease', () => {
  it('extracts the version, release page and downloadable assets', () => {
    expect(parseLatestRelease(payload([asset('Deepseek.Harness.Android_0.33.0.apk', apkUrl), asset('SHA256SUMS-Android.txt', 'https://example.com/sums')]))).toEqual({
      version: '0.33.0',
      pageUrl,
      assets: [
        { name: 'Deepseek.Harness.Android_0.33.0.apk', url: apkUrl },
        { name: 'SHA256SUMS-Android.txt', url: 'https://example.com/sums' },
      ],
    })
  })

  it('keeps a release without assets so the caller can fall back to its page', () => {
    expect(parseLatestRelease(payload())).toEqual({ version: '0.33.0', pageUrl, assets: [] })
  })

  it('drops malformed assets instead of failing the whole release', () => {
    expect(parseLatestRelease(payload([{ name: 'broken' }, null, asset('Deepseek.Harness.iOS_0.33.0_unsigned.ipa', ipaUrl)]))).toEqual({
      version: '0.33.0',
      pageUrl,
      assets: [{ name: 'Deepseek.Harness.iOS_0.33.0_unsigned.ipa', url: ipaUrl }],
    })
  })

  it('returns null for a non-object payload', () => {
    expect(parseLatestRelease(null)).toBeNull()
    expect(parseLatestRelease('v0.33.0')).toBeNull()
    expect(parseLatestRelease([payload()])).toBeNull()
  })

  it('returns null when a required field is missing or mistyped', () => {
    expect(parseLatestRelease({ html_url: pageUrl, assets: [] })).toBeNull()
    expect(parseLatestRelease({ tag_name: 'v0.33.0', assets: [] })).toBeNull()
    expect(parseLatestRelease({ tag_name: 'v0.33.0', html_url: pageUrl })).toBeNull()
    expect(parseLatestRelease({ tag_name: 33, html_url: pageUrl, assets: [] })).toBeNull()
    expect(parseLatestRelease({ tag_name: 'v0.33.0', html_url: pageUrl, assets: {} })).toBeNull()
  })

  it('returns null when the tag is not a comparable version', () => {
    expect(parseLatestRelease({ tag_name: 'nightly', html_url: pageUrl, assets: [] })).toBeNull()
  })
})

describe('pickDownloadUrl', () => {
  const release = { version: '0.33.0', pageUrl, assets: [{ name: 'Deepseek.Harness.Android_0.33.0.apk', url: apkUrl }, { name: 'Deepseek.Harness.iOS_0.33.0_unsigned.ipa', url: ipaUrl }] }

  it('selects the apk asset on Android', () => {
    expect(pickDownloadUrl(release, 'android')).toBe(apkUrl)
  })

  it('selects the ipa asset on iOS', () => {
    expect(pickDownloadUrl(release, 'ios')).toBe(ipaUrl)
  })

  it('falls back to the release page when the platform asset is missing', () => {
    expect(pickDownloadUrl({ ...release, assets: [{ name: 'Deepseek.Harness.iOS_0.33.0_unsigned.ipa', url: ipaUrl }] }, 'android')).toBe(pageUrl)
    expect(pickDownloadUrl({ version: '0.33.0', pageUrl, assets: [] }, 'ios')).toBe(pageUrl)
  })
})
