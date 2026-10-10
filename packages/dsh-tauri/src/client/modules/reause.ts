/**
 * client/modules/reause.ts — `@reause/core` 的唯一出口。
 *
 * 依赖收敛（与 unstorage / hookable / date-fns / valtio-define 同一条规则）：
 * 插件的 client bundle 是 ModuleLoader 里的 CJS 工厂，模块表只认识平台种子词
 * （react / @deepseek-ai/*）与已加载的链接模块（dsh-tauri/client）。若各插件直接
 * `import { useEventListener } from '@reause/core'`，产物会发出模块表查不到的
 * require（"missed the module table"）。因此 reause 只在这里被 import 一次、
 * 随 dsh-tauri/client 内联，插件一律 `from 'dsh-tauri/client'` 取用。
 *
 * 必须逐个具名导出：client entry 是库产物，其全部导出都被视为对外可达，
 * `export *` 会把 reause 全部 306 个导出（含数百个 hook 实现）打进 client.cjs；
 * 具名清单只保留真正被消耗的 hook，其余被 tree-shake（941KB → 70KB）。
 * 新增 hook 在此登记即可（dts 同步收窄，漏登记时插件侧直接类型报错）。
 */
export { noop, useAsyncState, useEventListener, useMount, useResizeObserver, useTimeoutPoll, useUnmount, useWatchImmediate } from '@reause/core'
export { If } from 'react-if-lite'
