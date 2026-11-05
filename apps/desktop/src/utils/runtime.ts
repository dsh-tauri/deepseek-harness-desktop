/**
 * 当前外壳是否运行在 Electron 运行时（`tauri-runtime-electron`）上。
 *
 * Electron 下 Harness 页面是主窗口内容区里的原生 `WebContentsView`，会整块盖住
 * 壳层 DOM，右下角的壳层 toast 根本看不到——这类提示必须改走独立的置顶覆盖窗口。
 * 覆盖窗口菜单/渲染都依赖 Electron 的窗口 API，WebView 运行时没有，故需先判定。
 *
 * 判定用 UA：Electron 固定把 `Electron/x.y.z` 写进 UA，而 jsdom 与浏览器都不含。
 */
export function isElectronRuntime(): boolean {
  return / Electron\//.test(globalThis.navigator?.userAgent ?? '')
}
