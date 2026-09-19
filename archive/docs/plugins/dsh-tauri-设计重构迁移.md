archive/dsh-tauri 废弃，其他插件需迁移到重构后的 packages/dsh-tauri

1. 每个 host 插件的路由定义应按照以下协议：

- host/routes/index.ts
import { defineRoutes } from "dsh-tauri"
import postFeature from "./feature/post.ts"
import getFeature2 from './feature/get.ts'
...

const routes = defineRoutes(disposer => {
  disposer.post({ ... }, postFeature)
  disposer.get({ ... }, getFeature2)
  ...
})

ctx.effect(() => routes(ctx), '...')

处理器需要 apply 期依赖（配置 / 数据根 / 服务实例）时，用类型参数声明 deps 形状，
经注册期第二参数传入，handler 里用 `dshRouteDepsOf(event)` 取回：

- host/routes/index.ts
import { defineRoutes } from "dsh-tauri"
import type { FeatureRouteDeps } from '../types'

export const routes = defineRoutes<FeatureRouteDeps>(disposer => {
  disposer.post({ ... }, postFeature)
  ...
})

- host/apply.ts
const deps: FeatureRouteDeps = { config, root }
ctx.effect(() => routes(ctx, deps), '...')

- host/routes/deps.ts（无状态：没有模块级变量，同一份声明在两组 deps 下注册时各读各的）
import { dshRouteDepsOf } from 'dsh-tauri'
export function routeDeps(event: H3Event): FeatureRouteDeps {
  const deps = dshRouteDepsOf<FeatureRouteDeps>(event)
  if (!deps) throw new Error('...: 路由依赖未随注册传入')
  return deps
}

2. 每个 host 插件的 storage 定义应修改为
import { fsAtomicDriver } from "dsh-tauri"
import { createStorage } from 'unstorage'

export const storage = createStorage({
   driver: fsAtomicDriver(...)
})


3. 每个插件的 client 侧的注册，都应该如下

src/client/register/feature1.ts
export const feature1 = defineRegister((controller, ctx, adapter) => {
   ....
})
src/client/register/feature2.ts ...
src/client/register/feature3.ts ...

ctx.effect(feature1, '...')
ctx.effect(feature2, '...')
ctx.effect(feature3, '...')

4. 每个插件的 client 侧状态储存，文件定义、协议都应该按照壳使用 valtio-define 定义

src/client/store/modules/*
src/client/store/index.ts
export const store = {
  store1,
  store2,
}


5. 每个插件的 client 侧组件，都应该全面使用 @reause/core 的 hooks 以简化组件的实现：
D:\projects\dsh-tauri-desk\deepseek-harness-desktop\packages\dsh-tauri\src\client\modules\reause.ts