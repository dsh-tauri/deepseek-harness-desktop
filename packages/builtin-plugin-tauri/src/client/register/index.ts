import type { Context } from '@deepseek-ai/cordis'
import type { LifecycleController } from '../controller'
import type { ClientAdapter } from '../types/adapter'
import { createLifecycleController } from '../controller'
import { effectContext } from '../utils/context'
import { defineAdapter } from './index.adapter'

export * from './index.adapter'

export type RegisterController = LifecycleController

export type RegisterCleanup = () => void

export type RegisterSetup<Ctx = Context> = (
  controller: RegisterController,
  ctx: Ctx,
  adapter: ClientAdapter,
) => void | RegisterCleanup | readonly RegisterCleanup[]

export type RegisterEffect = (this: unknown) => RegisterCleanup

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
    const ctx = (boundCtx ?? effectContext<Ctx>(this) ?? this) as Ctx
    const controller = createLifecycleController()

    try {
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
      controller.dispose()
      throw error
    }

    return () => controller.dispose()
  }
}
