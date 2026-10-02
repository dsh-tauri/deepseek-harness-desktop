/**
 * L3 桌面端用例共享的 `data-testid` 选择器常量。
 *
 * 规范见 `docs/specs/desktop.test.md` §5 的「选择器口径」：用例只认 `dsh-<业务域>-<元素名>`，
 * 禁止依赖 CSS 类名、DOM 层级或文本内容；跨用例复用的选择器一律登记在此。
 *
 * 桌面端只剩一条启动冒烟用例，因此这里只保留它真正用到的锚点；被删用例的选择器
 * 随用例一起移除，避免留下没有消费者的死常量。
 */

/** 壳层根节点（`src/layout/index.tsx`）。 */
export const SHELL_ROOT = '[data-testid="dsh-shell-root"]'

/**
 * 内嵌 dsh 页面的 iframe（`src/layout/components/iframe.tsx`）。
 *
 * 仅在 `harness.serviceHealthy` 为真时挂载；因此「iframe 出现」即「dsh 内核已起来」。
 */
export const SHELL_IFRAME = '[data-testid="dsh-shell-iframe"]'

/** 装配失败页根节点（`src/layout/components/setup.tsx` → `Loadable`）。 */
export const SETUP_ERROR = '[data-testid="dsh-setup-error"]'

/**
 * 首次装配「安装推荐插件」引导页的跳过按钮。
 *
 * 三处（有变更 / 无变更 / 安装失败）互斥渲染，因此同一 testid 只会命中一个。
 */
export const SETUP_PREINSTALL_SKIP = '[data-testid="dsh-setup-preinstall-skip"]'

/* ==========================================
 * 浏览器层用例（`plugin` project + Playwright 库 API）
 * ==========================================
 *
 * 选择器按「元素归属」分流（`docs/specs/plugin.test.md` §3.2 与 `desktop.test.md` §5 的
 * 适用范围）：插件包 `packages/*` 注入的元素用 `data-dsh-*`（部分是行为钩子，属性名被
 * 插件自身以 `attributeFilter` 观测，**不得**为测试方便改写）；壳层 `src/` 提供的元素
 * 用 `data-testid="dsh-<业务域>-<元素名>"`；dsh 内部结构属上游产物，只能用稳定结构性
 * 锚点（`data-slot` / `role` / 插件自有 `dshp-*` 前缀类），缺口登记在各批次文档末节。
 *
 * 完整的浏览器层锚点见 `test/e2e/support/browser.ts`；这里只登记跨批次复用的壳层锚点。
 */

/** 内嵌 dsh 页面的 iframe 宿主文档由用例 `page.route` 提供，见 `browser.ts`。 */
export const EMBEDDED_DOCUMENT = '[id="dsh"]'

/** 设置侧栏根（`packages/dsh-tauri-ui/src/client/ui/settings-sidebar.tsx`，插件包属性）。 */
export const SETTINGS_SIDEBAR_ATTRIBUTE = '[data-slot-sidebar="dsh-tauri-ui"]'

export const TASK_MANAGER = '[data-testid="dsh-task-manager"]'
export const TASK_MANAGER_SEARCH = '[data-testid="dsh-task-manager-search"]'
export const TASK_MANAGER_PROCESSES = '[data-testid="dsh-task-manager-processes"]'
export const TASK_MANAGER_REFRESH = '[data-testid="dsh-task-manager-refresh"]'
export const TASK_MANAGER_AUTO_REFRESH = '[data-testid="dsh-task-manager-auto-refresh"]'
export const TASK_MANAGER_END = '[data-testid="dsh-task-manager-end"]'
export const TASK_MANAGER_RESTART = '[data-testid="dsh-task-manager-restart"]'
export const TASK_MANAGER_CLOSE = '[data-testid="dsh-task-manager-close"]'
