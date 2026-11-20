export interface GetManifestPaths {
  baseURL: string
}

export interface BridgeManifest {
  name: string
  short_name: string
}

export interface AppReleaseAsset {
  name: string
  url: string
}

export interface AppRelease {
  version: string
  pageUrl: string
  assets: AppReleaseAsset[]
}

export type AppPlatform = 'android' | 'ios'
