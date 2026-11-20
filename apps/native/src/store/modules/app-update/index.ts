import Constants from 'expo-constants'
import { Linking, Platform } from 'react-native'
import { defineStore } from 'valtio-define'
import { getLatestAppRelease } from '@/apis'
import { isNewerVersion, pickDownloadUrl } from '@/utils/app-update'

export interface AppUpdateState {
  currentVersion: string
  latestVersion: string | null
  downloadUrl: string | null
  checking: boolean
  checked: boolean
  ignoredVersion: string | null
}

export function createAppUpdateState(): AppUpdateState {
  return {
    currentVersion: Constants.expoConfig?.version ?? '',
    latestVersion: null,
    downloadUrl: null,
    checking: false,
    checked: false,
    ignoredVersion: null,
  }
}

export const appUpdate = defineStore({
  state: createAppUpdateState,
  getters: {
    hasUpdate(): boolean {
      return this.latestVersion !== null && isNewerVersion(this.latestVersion, this.currentVersion)
    },
  },
  actions: {
    async check(): Promise<void> {
      if (this.checking)
        return
      this.checking = true
      try {
        const release = await getLatestAppRelease()
        if (release) {
          this.latestVersion = release.version
          this.downloadUrl = pickDownloadUrl(release, Platform.OS === 'ios' ? 'ios' : 'android')
        }
      }
      catch (error) {
        console.error('[app-update] check failed:', error)
      }
      finally {
        this.checking = false
        this.checked = true
      }
    },
    dismiss() {
      this.ignoredVersion = this.latestVersion
    },
    async openDownload(): Promise<void> {
      if (!this.downloadUrl)
        return
      try {
        await Linking.openURL(this.downloadUrl)
      }
      catch (error) {
        console.error('[app-update] open download failed:', error)
      }
    },
  },
})
