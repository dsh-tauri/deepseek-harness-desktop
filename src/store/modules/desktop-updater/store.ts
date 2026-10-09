import type {
  DesktopAboutInfo,
  DesktopDownloadProgress,
  DesktopUpdateInfo,
} from './types'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import i18next from 'i18next'
import { defineStore } from 'valtio-define'
import { toast } from '@/utils/toast'

let checkTask: Promise<DesktopUpdateInfo | null> | null = null
let downloadTask: Promise<void> | null = null
let downloadAndOpenTask: Promise<boolean> | null = null

/**
 * 桌面端自更新模块：检查新版本 → 静默下载安装包 → 打开安装器完成升级。
 *
 * 与 `updater` 模块（dsh 内核更新）区分：本模块针对桌面应用自身。
 * 轮询检查低频触发（见 `layout/index.tsx` 的 `useIntervalFn`），Rust 侧每次实时查询、
 * 不做缓存，由低频轮询避免 GitHub 未认证限流。
 *
 * 交互约定：
 * - 检测到新版本即**静默下载**，不弹右下角 toast、不打断用户；进度只在
 *   「检查更新」/「更新可用」chip 打开的对话框里展示；
 * - 用户没在对话框里安装时，Rust 侧会在应用退出时自动打开已下载的安装器
 *   （见 service::update::pending）。
 */
export const desktopUpdater = defineStore({
  state: () => ({
    /** 发现的新版本信息（null 表示暂无） */
    updateInfo: null as DesktopUpdateInfo | null,
    /** 是否正在检查更新（避免并发/重复） */
    checking: false,
    /** 是否正在下载安装包 */
    downloading: false,
    /** 下载进度 0-100 */
    downloadProgress: 0,
    /** 关于对话框信息 */
    about: null as DesktopAboutInfo | null,
  }),
  actions: {
    /**
     * 检查是否有新版本；发现更新时顺带发起静默下载。
     * 轮询与「检查更新」共用；每次用原生结果同步完整 updateInfo，
     * 让安装包被移动/删除后的 downloaded/path 状态也能实时反映。
     * 网络失败/限流时抛出错误（不吞掉），由调用方决定如何提示——
     * 绝不能把「检查失败」误报成「已是最新」。
     */
    check(): Promise<DesktopUpdateInfo | null> {
      if (checkTask)
        return checkTask
      this.checking = true
      const task = (async () => {
        try {
          const info = await invoke<DesktopUpdateInfo | null>('check_desktop_update')
          if (info) {
            this.updateInfo = info
            // 检测到更新即静默下载（不弹 toast、不打开安装器）；失败静默，
            // 用户点击「立即更新」时会重试并给出可见的错误提示
            void this.download()
          }
          else {
            this.updateInfo = null
          }
          return info
        }
        finally {
          checkTask = null
          this.checking = false
        }
      })()
      checkTask = task
      return task
    },

    /**
     * 静默下载安装包：已下载 / 已在下载中 → 直接复用，不重复发起。
     *
     * 后台行为：不打开安装器、不弹错误 toast，失败只记录日志；
     * 用户在对话框里主动点「立即更新」时的失败提示由 `downloadAndOpen` 负责。
     */
    download(): Promise<void> {
      if (downloadTask)
        return downloadTask
      const info = this.updateInfo
      if (!info || info.downloaded)
        return Promise.resolve()

      this.downloading = true
      this.downloadProgress = 0
      downloadTask = invoke<DesktopUpdateInfo>('download_desktop_update')
        .then((updated) => {
          this.updateInfo = updated
        })
        .catch((err) => {
          console.error('[DesktopUpdater] download failed:', err)
        })
        .finally(() => {
          downloadTask = null
          this.downloading = false
          this.downloadProgress = 0
        })
      return downloadTask
    },

    /** 加载关于信息（缓存到 store，仅首次拉取；打开关于对话框前调用） */
    async loadAbout(): Promise<DesktopAboutInfo | null> {
      if (!this.about) {
        try {
          this.about = await invoke<DesktopAboutInfo>('get_desktop_about')
        }
        catch (err) {
          console.warn('[DesktopUpdater] failed to load about info:', err)
        }
      }
      return this.about
    },

    /**
     * 「立即更新」：等待在途的静默下载（没有则发起），完成后打开安装器。
     * 已下载则直接打开；下载失败时给出可见提示（对话框保持打开）。
     */
    downloadAndOpen(): Promise<boolean> {
      if (downloadAndOpenTask)
        return downloadAndOpenTask
      const task = (async () => {
        const info = this.updateInfo
        if (!info)
          return false

        let path = info.path
        if (!info.downloaded) {
          await this.download()
          const updated = this.updateInfo
          if (!updated?.downloaded) {
            toast(i18next.t('update.desktop_download_failed'), {
              variant: 'danger',
              placement: 'bottom end',
            })
            return false
          }
          path = updated.path
        }

        try {
          await invoke('open_desktop_installer', { path })
          toast(i18next.t('update.desktop_opened'), {
            variant: 'default',
            placement: 'bottom end',
          })
          return true
        }
        catch (err) {
          console.error('[DesktopUpdater] failed to open installer:', err)
          toast(i18next.t('update.desktop_open_failed'), {
            variant: 'danger',
            placement: 'bottom end',
          })
          return false
        }
      })().finally(() => {
        downloadAndOpenTask = null
      })
      downloadAndOpenTask = task
      return task
    },
  },
})

// 模块级监听下载进度（应用生命周期内常驻）
listen<DesktopDownloadProgress>('desktop-update-progress', (e) => {
  desktopUpdater.downloadProgress = e.payload.percentage
  // 后端附加提示（如主源失败已切换镜像源重试）→ toast 告知用户
  if (e.payload.message) {
    toast(e.payload.message, {
      variant: 'default',
      placement: 'bottom end',
    })
  }
}).catch((err) => {
  console.error('[DesktopUpdater] failed to listen desktop-update-progress:', err)
})
