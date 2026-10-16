import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getConfig } from 'expo/config'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packageVersion = (JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')) as { version: string }).version

describe('public Expo configuration packaged by expo-constants', () => {
  it('embeds the complete third-party notice without changing Android identity', () => {
    const { exp } = getConfig(projectRoot, { isPublicConfig: true, skipSDKVersionRequirement: true })
    const notice = exp.extra?.thirdPartyNotices

    expect(notice).toBe(readFileSync(resolve(projectRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8'))
    expect(String(notice)).not.toBe('')
    expect(exp.name).toBe('DSH Mobile')
    expect(exp.slug).toBe('dsh-bridge')
    expect(exp.scheme).toBe('dshbridge')
    expect(exp.version).toBe(packageVersion)
    expect(exp.android?.package).toBe('com.dshtauri.dshbridge')
    expect(Number.isInteger(exp.android?.versionCode)).toBe(true)
    expect(exp.android?.versionCode ?? 0).toBeGreaterThan(0)
  })

  it('declares the iOS store identity and only the permissions used by the app', () => {
    const { exp } = getConfig(projectRoot, { isPublicConfig: true, skipSDKVersionRequirement: true })

    expect(exp.ios?.bundleIdentifier).toBe('com.dshtauri.dshbridge')
    expect(exp.ios?.supportsTablet).toBe(true)
    expect(exp.ios?.buildNumber).toBe('1')
    expect(exp.ios?.infoPlist?.['UISupportedInterfaceOrientations~ipad']).toEqual([
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationPortraitUpsideDown',
      'UIInterfaceOrientationLandscapeLeft',
      'UIInterfaceOrientationLandscapeRight',
    ])
    expect(getConfig(projectRoot, { skipSDKVersionRequirement: true }).exp.ios?.config?.usesNonExemptEncryption).toBe(false)
    expect(exp.ios?.infoPlist?.NSLocalNetworkUsageDescription).toBe('DSH Mobile 使用本地网络发现并连接您电脑上的 DSH 服务。')
    expect(exp.plugins).toContainEqual(['expo-camera', {
      cameraPermission: '允许 DSH Mobile 使用相机扫描连接二维码。',
      microphonePermission: false,
      recordAudioAndroid: false,
    }])
    expect(exp.plugins).toContainEqual(['expo-secure-store', { faceIDPermission: false }])
    expect(exp.plugins).toContainEqual(['expo-notifications', {
      icon: './assets/native/notification-icon.png',
      color: '#151517',
      mode: 'production',
    }])
  })

  it('shrinks release code and resources and compresses APK payloads', () => {
    const { exp } = getConfig(projectRoot, { skipSDKVersionRequirement: true })

    expect(exp.plugins).toContainEqual(['expo-build-properties', {
      android: {
        usesCleartextTraffic: true,
        buildArchs: ['arm64-v8a'],
        enableMinifyInReleaseBuilds: true,
        enableShrinkResourcesInReleaseBuilds: true,
        enableBundleCompression: true,
        useLegacyPackaging: true,
      },
    }])
  })

  it('keeps TestFlight build numbers on the EAS remote source', () => {
    const eas = JSON.parse(readFileSync(resolve(projectRoot, 'eas.json'), 'utf8')) as {
      cli?: { appVersionSource?: string }
      build?: { production?: { autoIncrement?: boolean } }
    }

    expect(eas.cli?.appVersionSource).toBe('remote')
    expect(eas.build?.production?.autoIncrement).toBe(true)
  })
})
