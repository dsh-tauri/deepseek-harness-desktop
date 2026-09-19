import type { TestProject } from 'vitest/node'
import process from 'node:process'
import { startDshHost } from './support/dsh-host'

/**
 * e2e project 的 globalSetup：起一次真实 dsh web 宿主，把地址 provide 给用例。
 *
 * globalSetup 跑在测试 worker 之外、且早于它们创建，所以这里定义的变量用例读不到；
 * 地址一律经 `project.provide()` 下传，用例用 `inject('dshBaseUrl')` 取。
 *
 * 被挂载的插件由 `DSH_E2E_PLUGIN` 指定（默认 `dsh-tauri-pet`），同一份编排即可服务
 * 不同插件的 lane，不必为每个插件复制一份 setup。
 */

declare module 'vitest' {
  export interface ProvidedContext {
    /** dsh web 的裸 origin（`http://127.0.0.1:<port>`），用于宿主路由的 HTTP 断言。 */
    dshBaseUrl: string
    /** 带一次性 token 的就绪 URL（`--skip-auth` 下与裸 origin 等价，保留给页面用例）。 */
    dshUrl: string
    /** 本次运行独占的 DSH_HOME（调试与断言落盘用）。 */
    dshHome: string
    /** 已挂载的包名。 */
    dshMounted: string[]
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const plugin = process.env.DSH_E2E_PLUGIN ?? 'dsh-tauri-pet'
  const also = (process.env.DSH_E2E_ALSO ?? '').split(',').map(item => item.trim()).filter(Boolean)
  const host = await startDshHost({ plugin, also, keepHome: process.env.DSH_E2E_KEEP_HOME === '1' })

  project.provide('dshBaseUrl', host.baseUrl)
  project.provide('dshUrl', host.url)
  project.provide('dshHome', host.home)
  project.provide('dshMounted', [...host.mounted])

  return async () => {
    await host.stop()
  }
}
