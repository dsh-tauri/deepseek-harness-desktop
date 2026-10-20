import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import configPlugins from 'expo/config-plugins.js'

const { AndroidConfig, withAndroidManifest, withMainActivity } = configPlugins

// 本仓库根 package.json 是 `"type": "module"`，动态配置必须以 ESM 导出。
const rootDir = fileURLToPath(new URL('.', import.meta.url))

const mainActivityClass = 'class MainActivity : ReactActivity() {'
const superOnCreate = /^([ \t]*)super\.onCreate\(/m
const orientationMembers = `
  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    applyScreenOrientation(newConfig)
  }

  private fun applyScreenOrientation(config: android.content.res.Configuration) {
    requestedOrientation = if (config.smallestScreenWidthDp < 600) {
      android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    } else {
      android.content.pm.ActivityInfo.SCREEN_ORIENTATION_FULL_USER
    }
  }
`

export default function appConfig({ config }) {
  const withNotices = {
    ...config,
    extra: {
      ...config.extra,
      thirdPartyNotices: readFileSync(`${rootDir}THIRD_PARTY_NOTICES.md`, 'utf8'),
    },
  }
  // Expo 的 `orientation` 由 iOS / Android 共用，Android 也没有 iPad 那样的平板专用键：
  // 清单放开方向，再由 MainActivity 按最小宽度 600dp（与 Android 16 的大屏规则一致）把手机锁回竖屏。
  const withManifest = withAndroidManifest(withNotices, (config) => {
    AndroidConfig.Manifest.getMainActivityOrThrow(config.modResults).$['android:screenOrientation'] = 'fullUser'
    return config
  })
  return withMainActivity(withManifest, (config) => {
    const { contents } = config.modResults
    if (contents.includes('applyScreenOrientation('))
      return config
    if (!contents.includes(mainActivityClass) || !superOnCreate.test(contents))
      throw new Error('MainActivity.kt no longer matches the Expo template that the tablet orientation patch expects')
    config.modResults.contents = contents
      .replace(superOnCreate, '$1applyScreenOrientation(resources.configuration)\n$1super.onCreate(')
      .replace(mainActivityClass, () => `${mainActivityClass}\n${orientationMembers}`)
    return config
  })
}
