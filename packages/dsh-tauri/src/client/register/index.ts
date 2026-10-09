/**
 * client/register/index.ts — 客户端注册工具：把一组受控资源收敛成一个 effect。
 *
 * 声明期只登记「做什么」，运行期由工具负责
 * 创建控制器、执行 setup、并把 `controller.dispose()` 作为 effect 的 disposer 返回，
 * 业务 setup 不再手写 `return () => controller.dispose()`。
 *
 * 用法：
 * ```ts
 * const feature = defineRegister((controller, ctx, adapter) => {
 *   controller.add(listenParent(handler, 'dsh://demo:sync'))
 *   controller.observe(document.body, () => sync(), { childList: true, subtree: true })
 *   // DSH 升级迁移统一走适配层：能力探测 + 退级阶梯，不猜核心版本号
 *   void adapter.startSession()
 *   adapter.sessions.list?.getSnapshot()
 * })
 *
 * ctx.effect(feature, 'demo: feature')
 * ```
 *
 * `ctx` 的来源：cordis 4 的 `ctx.effect(callback)` 内部是 `callback.call(fiber)`，effect 的
 * `this` 是 Fiber（`fiber.ctx` 才是客户端上下文）；本工具经 `effectContext` 归一化后作为
 * 第二个参数透传给 setup。若调用方不使用 `ctx.effect`，可用双参形式显式传入：
 * `defineRegister(ctx, setup)`。
 *
 * 第三个参数 `adapter` 由 `defineAdapter(ctx)` 按需创建（见 `./index.adapter`）：
 * 官方服务布局随核心版本漂移的那部分能力（会话列表投影、工作区导航、目录选择）全部收敛在它
 * 里面，setup 只消费稳定面与 `has(...)` 能力探测。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LifecycleController } from '../controller'
import type { ClientAdapter } from '../types/adapter'
import { createLifecycleController } from '../controller'
import { effectContext } from '../utils/context'
import { defineAdapter } from './index.adapter'

export * from './index.adapter'

/** setup 内可用的控制器：与 `createLifecycleController()` 同一实例类型。 */
export type RegisterController = LifecycleController

/** 一次性清理句柄。 */
export type RegisterCleanup = () => void

/**
 * 注册回调：只在 effect 运行时被调用一次。
 *
 * `controller` 由 `defineRegister` 创建并托管，setup 不必（也不能）自行 dispose；
 * `adapter` 由 `defineAdapter(ctx)` 创建（DSH 升级迁移 / 能力探测 / 退级阶梯的唯一入口）。
 * 返回值可选——若返回 disposer 或 disposer 数组，会被追加登记，卸载时一并执行
 * （兜底老写法，推荐一律用 `controller.add(...)`）。
 */
export type RegisterSetup<Ctx = Context> = (
  controller: RegisterController,
  ctx: Ctx,
  adapter: ClientAdapter,
) => void | RegisterCleanup | readonly RegisterCleanup[]

/**
 * 可直接交给 `ctx.effect(...)` 的 effect 函数。
 * 用 function（而非箭头函数）声明，是为了让 cordis 把运行时对象绑进 `this`
 * （cordis 4 绑的是 Fiber，插件上下文要从 `fiber.ctx` 取，见 `effectContext`）；
 * `this` 声明为 unknown 以便同时支持直接调用与 `.call(ctx)` 两种用法。
 */
export type RegisterEffect = (this: unknown) => RegisterCleanup

/**
 * 定义一组客户端注册。
 *
 * @param ctx - 客户端上下文；省略时在 effect 运行时从 `this` 取（配合 `ctx.effect`）。
 * @param setup - 注册回调；用 `controller.add / observe / listen / interval / timeout` 登记资源，
 *   跨核心版本的官方服务一律经第三个参数 `adapter` 取用。
 * @returns effect 函数：运行时创建控制器与适配器并执行 setup，返回的 disposer 统一 dispose。
 */
export function defineRegister<Ctx = Context>(ctx: Ctx, setup: RegisterSetup<Ctx>): RegisterEffect
export function defineRegister<Ctx = Context>(setup: RegisterSetup<Ctx>): RegisterEffect
export function defineRegister<Ctx = Context>(
  ctxOrSetup: Ctx | RegisterSetup<Ctx>,
  maybeSetup?: RegisterSetup<Ctx>,
): RegisterEffect {
  const boundCtx = typeof maybeSetup === 'function' ? ctxOrSetup as Ctx : undefined
  const setup = (typeof maybeSetup === 'function' ? maybeSetup : ctxOrSetup) as RegisterSetup<Ctx>
  if (typeof setup !== 'function')
    throw new TypeError('defineRegister: 缺少注册回调，签名是 defineRegister([ctx,] setup)')

  return function registerEffect(this: unknown): RegisterCleanup {
    // this 声明为 unknown：`ctx.effect(feature)` 时它是 cordis 的 Fiber（上下文经
    // `effectContext` 取回），也允许 `feature()` / `feature.call(ctx)` 直接调用，
    // 由显式 boundCtx 兜底。
    const ctx = (boundCtx ?? effectContext<Ctx>(this) ?? this) as Ctx
    const controller = createLifecycleController()

    try {
      // 适配器按需创建：探测不到服务时是空投影（不是抛错），setup 仍照常拿到可用实例。
      const adapter = defineAdapter(ctx)
      const cleanup = setup(controller, ctx, adapter)
      if (typeof cleanup === 'function') {
        controller.add(cleanup)
      }
      else if (Array.isArray(cleanup)) {
        for (const fn of cleanup) controller.add(fn)
      }
    }
    catch (error) {
      // setup 失败：立即回收本次已登记的资源，不把半挂载状态留给卸载路径。
      controller.dispose()
      throw error
    }

    return () => controller.dispose()
  }
}
