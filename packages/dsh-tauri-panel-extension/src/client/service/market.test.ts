/**
 * client/service/market.test.ts — 市场面板服务的能力判据。
 *
 * 守三条需求硬约束：**没装市场时不出现标签页**；**已发布的 1.47.0（有 `market`
 * 但没有 `render`）不能被当成可用**——收不进面板，就更不能顺手把它自带的设置页
 * 入口藏掉，否则市场会彻底没有入口；**注册表读取抛错时静默**。
 *
 * 另守面板归属：只有桌面 iframe 收编市场，普通浏览器标签页保留市场自带的设置页入口。
 *
 * 判据都是能力探测，不是版本号。
 */

import type { ClientContext } from 'dsh-tauri/client'
import { describe, expect, it } from 'vitest'
import { hostsMarketPanel, readMarket } from './market'

/** 最小上下文替身：只提供能力探测真正读到的 `reflect.get`。 */
function contextWith(service: unknown, options: { throws?: boolean } = {}): ClientContext {
  return {
    reflect: {
      get: () => {
        if (options.throws === true)
          throw new Error('registry unavailable')
        return service
      },
      provide: () => () => {},
    },
  } as unknown as ClientContext
}

/** 已发布的 1.47.0 形状：有可见性开关，但没有 `render`。 */
function released(): unknown {
  return { version: 1, setSettingsVisible: () => {}, settingsVisible: () => true }
}

describe('readMarket', () => {
  it('未安装市场：服务缺席 → 不可用（标签页不出现）', () => {
    expect(readMarket(contextWith(undefined))).toBeUndefined()
  })

  it('已发布的 1.47.0：有 market 服务但没有 render → 仍不可用', () => {
    expect(readMarket(contextWith(released()))).toBeUndefined()
  })

  it('新版：render 可调用 → 返回服务本体', () => {
    const service = { ...released() as object, render: () => null }
    expect(readMarket(contextWith(service))).toBe(service)
  })

  it('render 存在但不是函数 → 按不可用处理', () => {
    expect(readMarket(contextWith({ ...released() as object, render: 'yes' }))).toBeUndefined()
  })

  it('注册表读取抛错时按不可用处理，不冒泡', () => {
    expect(readMarket(contextWith(undefined, { throws: true }))).toBeUndefined()
  })

  it('缺少 reflect 的壳也不会崩', () => {
    expect(readMarket({} as unknown as ClientContext)).toBeUndefined()
    expect(readMarket({ reflect: {} } as unknown as ClientContext)).toBeUndefined()
  })

  it('每次都按当前注册表读数探测：服务消失后回到不可用（不缓存旧引用）', () => {
    let service: unknown = { ...released() as object, render: () => null }
    const ctx = {
      reflect: {
        get: () => service,
        provide: () => () => {},
      },
    } as unknown as ClientContext
    expect(readMarket(ctx)).toBeDefined()
    service = undefined
    expect(readMarket(ctx)).toBeUndefined()
  })
})

describe('hostsMarketPanel', () => {
  it('桌面 iframe：parent 不是自身 → 收编市场面板', () => {
    expect(hostsMarketPanel({ parent: {} })).toBe(true)
  })

  it('独立浏览器标签页：parent 是自身 → 不收编，市场设置页入口保留', () => {
    const scope: { parent: unknown } = { parent: undefined }
    scope.parent = scope
    expect(hostsMarketPanel(scope)).toBe(false)
  })

  it('没有窗口（非浏览器环境）→ 不收编', () => {
    expect(hostsMarketPanel(undefined)).toBe(false)
  })
})
