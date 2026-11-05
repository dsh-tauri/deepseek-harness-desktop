/** 壳层建窗时注入的全局名（与 `src-tauri/src/desktop/window.rs` 逐字一致）。 */
const NAVIGATION_GLOBAL = '__DSH_NAVIGATION__'

/** 主窗口把 DSH 作为自身文档时注入的全局标记。 */
const HOSTED_GLOBAL = '__DSH_HOSTED__'

/** 主窗口注入的本机 DSH 服务 origin，用于判断当前文档是否已是 DSH 页面。 */
const HOSTED_SERVICE_ORIGIN = '__DSH_SERVICE_ORIGIN__'

/** 全屏右栏窗口的载荷标记（与插件 `sidebar-fullwindow.ts` 逐字一致）。 */
const PRESENTATION_FULL_SIDEBAR = 'full-sidebar'

/**
 * 主窗口是否「文档即 DSH」。
 *
 * 新架构下主窗口 webContents 直接加载 DSH 页面，壳层 UI 以 Shadow DOM 覆盖其上；
 * 此时 DSH 已在文档里，壳层不能再创建原生子视图，而是自报就绪状态。
 */
export function isHostedDocument(): boolean {
  return (globalThis as Record<string, unknown>)[HOSTED_GLOBAL] === true
}

/**
 * 当前文档是否就是 DSH 页面本身（而非引导用的壳层页）。
 *
 * 主窗口先在壳层页启动服务，再导航到 DSH；DSH 文档里注入脚本再次运行、壳层重新挂载，
 * 此时不能再触发一次启动，否则会把正在承载当前文档的服务重启掉。
 */
export function isHostedServiceDocument(): boolean {
  if (!isHostedDocument())
    return false
  const origin = (globalThis as Record<string, unknown>)[HOSTED_SERVICE_ORIGIN]
  return typeof origin === 'string' && origin !== '' && location.origin === origin
}

/**
 * 本窗口是否由「在新窗口全屏打开」建出。
 *
 * 注入脚本对全部 frame 生效：壳层与内嵌 dsh 各读自己 realm 的同一份载荷，
 * 所以这里读壳层全局，不需要插件经 webview 转发。
 */
export function isFullSidebarWindow(): boolean {
  const payload = (globalThis as Record<string, unknown>)[NAVIGATION_GLOBAL]
  if (typeof payload !== 'object' || payload === null)
    return false
  return (payload as { presentation?: unknown }).presentation === PRESENTATION_FULL_SIDEBAR
}
