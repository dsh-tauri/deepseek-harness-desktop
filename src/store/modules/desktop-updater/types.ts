/** Rust 侧 check_desktop_update 返回的桌面端新版本信息 */
export interface DesktopUpdateInfo {
  /** 最新可用版本号（无 v 前缀） */
  version: string
  /** 当前已安装版本号（无 v 前缀） */
  currentVersion: string
  tag: string
  published_at: string
  url: string
  asset_name: string
  path: string
  downloaded: boolean
}

/** Rust 侧 desktop-update-progress 事件载荷 */
export interface DesktopDownloadProgress {
  percentage: number
  downloaded: number
  total: number
  /** 附加提示（如切换下载源），无提示时缺省 */
  message?: string
}

/** Rust 侧 get_desktop_about 返回的关于信息 */
export interface DesktopAboutInfo {
  version: string
  publishedAt: string
  copyright: string
  repo: string
  poweredBy: string
}
