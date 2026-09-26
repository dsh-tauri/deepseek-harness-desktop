import { desktopUpdater } from './modules/desktop-updater'
import { harness } from './modules/harness'
import { harnessUpdater } from './modules/harness-updater'
import { preinstall } from './modules/preinstall'
import { recovery } from './modules/recovery'
import { remote } from './modules/remote'
import { setting } from './modules/setting'

/**
 * 全局 store 聚合（参考 damn-reports 的组织方式：模块各自独立，聚合统一出口）。
 *
 * 每个 `modules/<name>/` 都是一个自洽的模块，`index.ts` 是该模块唯一的公共出口
 * （store + 类型 + 需要外用的工具函数），模块内部结构（store/types/utils/constants）
 * 不对其它模块暴露。
 *
 * 跨模块协作统一走本聚合对象或兄弟模块的 `index.ts`：例如 `preinstall` 通过
 * `harness.launchAndWait()` 收尾启动、`recovery` 通过 `harness.restart()`
 * 重启服务。组件一律 `import { store } from '@/store'`。
 */
export const store = {
  harness,
  harnessUpdater,
  preinstall,
  recovery,
  setting,
  desktopUpdater,
  remote,
}
