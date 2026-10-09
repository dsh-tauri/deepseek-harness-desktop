> 该文档已固定，禁止修改。

# 插件宿主端架构规范 (Plugin Host Architecture Protocol)

> 本规范为 [devlopment.md](./devlopment.md) 在 **DeepSeek Harness 插件宿主端（Node Runtime）** 的落地协议。插件 `src/host` 实现必须严格遵守本规范。
> **服务层细则**见：[plugin.host.service.md](./plugin.host.service.md)（定义宏、动词白名单与签名铁律）。

---

## 一、 核心架构原则

* **唯一事实来源 (SSOT)**：运行期内存单例（防抖队列、在途任务映射、会话标记等）必须统一由 `config/runtime.ts` 导出。严禁参数层层透传可变状态。
* **零无用中间层**：`apply.ts` 只做装配接线，不写业务逻辑；禁止为 2~3 个文件建立纯转发的 `index.ts`；临时数据转换必须就地处理。
* **彻底删除与零包袱**：彻底清理废弃逻辑、兼容层与存根代码，严禁保留 `legacy`/`compat` 文件。文件移动/重命名统一使用 `git mv`。
* **单向依赖流**：

$$\text{apply.ts (装配)} \longrightarrow \begin{bmatrix} \text{server/routes/} \\ \text{tools/} \\ \text{events/} \\ \text{prompts/} \end{bmatrix} \longrightarrow \text{service/ (业务领域)} \longrightarrow \begin{bmatrix} \text{storage/} \\ \text{utils/} \end{bmatrix}$$



---

## 二、 目录结构与规范

各插件 `src/host/` 物理落点定义如下：

| 目录/文件 | 职责说明 | 关键约束 |
| --- | --- | --- |
| **`apply.ts`** | 装配入口 | 仅做声明式组装（工具/事件/提示词/路由），控制在 30~50 行以内，不含业务逻辑。 |
| **`config/`** | 配置与运行状态 | `runtime.ts`: 仅保存业务内存状态及 reset/dispose，不保存宿主 Context；没有业务状态时删除该文件。<br>

<br>`constants.ts`: 静态常量与配置，严禁硬编码 Magic Number/String；只登记**两个及以上模块**消费的常量（单一消费方的常量归属见 [plugin.baisc.md](./plugin.baisc.md) 的《通用协议：常量归属》），`config/` 下不允许出现 `*.types.ts`。 |
| **`types/`** | 类型定义 | 导出领域模型、DTO、输入输出接口（纯类型定义）。单一模块专属的类型与所属模块**同目录同名**，命名为 `<module>.types.ts`（如 `service/worktree.types.ts`）；此目录仅保留被多个模块共享的类型（如 `index.ts`）——跨模块共享的**宿主面类型**（`SessionHost` / `PanelExtensionHost` 等）统一放 `types/index.ts`。 |
| **`storage/`** | 持久化实例 | `index.ts` 纯粹导出持久化驱动实例，不包含任何业务读写逻辑。 |
| **`server/`** | HTTP 服务层 *(可选)* | `index.ts` 使用 `dsh-h3` 的 `defineWebServer` 声明服务，`routes/` 保存 H3 handler。handler 文件按 URL 层级与方法落位（如 `server/routes/session/open/path/post.ts`），不根据文件名自动注册路由；URL 与方法以 `server/index.ts` 的显式注册为唯一依据，仅做协议解析、DTO 校验与 Service 调用。入口以 `app.post('/api/tauri/<插件短名>/session/open/path', handler)` 等直接注册完整字面量，禁止路径常量、拼接与自造路由宏。 |
| **`tools/`** | Agent 工具层 *(可选)* | 单工具单文件，包含声明、JSON Schema 与 execute 编排。 |
| **`prompts/`** | 系统提示词层 *(可选)* | 拆分为常驻提示词 (`*-section.ts`) 与动态单次上下文注入 (`*-context.ts`)。 |
| **`events/`** | 事件监听层 *(可选)* | 宿主生命周期事件处理（如 `turn/end`、工具前置拦截等）。 |
| **`service/`** | 领域服务层 | 领域服务使用 `defineService`，统一承接业务 storage 读写与宿主能力访问；共享请求中间件属于基础设施例外。 |
| **`utils/`** | 底层工具纯函数 | 纯粹、无状态，不包含业务上下文与契约宏。返回标准操作结果 `{ ok: boolean, ... }`。单一模块专属的工具与所属模块**同目录同名**，命名为 `<module>.utils.ts`；此目录仅保留被多个模块共享的纯函数（如 `git.ts`、`paths.ts`）。 |

---

## 三、 结构范例 (`dsh-tauri-worktree`)

```text
packages/dsh-tauri-worktree/src/host/
├── apply.ts                   # 平铺装配器
├── config/ (runtime.ts | constants.ts)
├── types/index.ts             # 仅跨多模块共享类型；单模块专属类型与其模块同目录同名
├── storage/index.ts           # 仅导出 storage 实例
├── server/
│   ├── index.ts               # defineWebServer + 原生 app 方法注册
│   └── routes/                # handler 文件；URL 与方法由 index.ts 显式注册
├── tools/                     # Agent 工具定义 (create-worktree.ts, checkout-worktree.ts)
├── prompts/                   # 提示词注入 (worktree-section.ts, checkout-context.ts)
├── events/                    # 事件监听 (session-event.ts, tools-execute.ts)
├── service/                   # 业务领域服务 (文件名 = 导出标识符)
│   ├── worktree.ts            # 领域编排 (create/checkout/attach)
│   ├── ledger.ts              # 持久化 <Binding> (load/save/remove/list)
│   ├── cleaner.ts             # 长任务调度 (start/lookup/unsettled)
│   └── session-context.ts     # 只读推演 (resolve/peek)
└── utils/                     # 仅跨多模块共享纯函数 (git.ts, filesystem.ts)；单模块专属工具与其模块同目录同名

```

---

## 四、 核心层实现细则

**1. 装配总线 (`apply.ts`)**

* 仅包含声明式注册 (`ctx.tools.register()`、`ctx.on()`、`ctx.systemPrompt.*()`、`ctx.effect()`)。
* 超过 2 行的回调必须抽离至 `events/` 或 `prompts/`。禁止创建全局 `deps` 对象透传。

```typescript
import { server } from './server'

export function apply(ctx: HostContext): void {
  ctx.effect(() => server(ctx), 'plugin: routes')

  ctx.tools.register(createWorktreeTool())
  ctx.tools.register(checkoutWorktreeTool())
  ctx.on('session/event', (session, event) => handleSessionEvent(session, event))
  ctx.on('tools/execute', (exec, next) => handleToolsExecute(exec, next))
  ctx.systemPrompt.context(checkoutContextProvider)
  ctx.systemPrompt.section(worktreeSectionProvider)
}

```

**2. 配置与状态层 (`config/`)**

* `dsh-h3` 基线为 `0.2.1`，Context 泛型由上游原生支持：`import { getServerContext, getServerOptions } from 'dsh-h3/utils'`。

* `runtime.ts` 仅导出业务内存状态及清除/销毁函数；Context 与服务配置由 `dsh-h3` 管理，禁止重新实现 `defineHostRuntime`、宿主 set/get 槽或路由依赖副本。`server(ctx, options)` 返回的 disposer 必须由 `ctx.effect` 托管。
* `server` 必须先于依赖它的恢复任务、事件监听及服务调用激活；服务内从 `dsh-h3/utils` 导入 `getServerContext` 和 `getServerOptions`，使用原生 `getServerContext<HostContext>(server)`；激活前和卸载后不得读取 Context。请求内的实例配置使用 `getServerOptions<Options>(event)`，禁止在 `dsh-tauri` 重导出或另建泛型兼容层。

**3. 持久化层 (`storage/`)**

* `storage/index.ts` 仅负责创建并导出驱动实例（如 `createStorage({ driver: fsAtomicDriver(...) })`）。
* 禁止在 `storage/` 目录下编写业务增删改查，存取逻辑统一收拢于 `service/` 对应的持久化服务中。

**4. 业务领域服务层 (`service/`)**

* 统一使用 `dsh-tauri` 的 `defineService` 宏声明，禁止自造宏。
* `server/routes/`、`tools/`、`events/`、`prompts/` 不直接执行业务宿主操作或读写 `storage`，必须通过领域服务访问；路由读取实例配置与共享安全中间件检查请求来源不属于业务穿透。

**5. 服务与路由形态 (`server/index.ts`、`server/routes/`)**

* **原生服务入口**：`export const server = defineWebServer<Options>((app) => { ... })`，无配置时省略泛型。共享安全检查在入口统一 `app.use(guard)`，业务 handler 不重复鉴权。精确路由不经过官方 `/api` 前缀闸门；桌面 `gate` 放行登录 401 不代表取消 Host/Origin 的 403。
* **统一命名空间**：插件 API 使用 `/api/tauri/<插件短名>`，例如 `dsh-tauri-rightclick` 对应 `/api/tauri/rightclick`；包名与注册标识不变。根资源不强加末尾斜杠，不保留旧路径别名。服务注册、生成客户端、Rust 桥接白名单与 SSE 订阅必须同步。
* **默认 RESTful 资源化**：URL 只描述资源，动作由 HTTP 方法承担。文件按方法命名（`get.ts`、`post.ts`、`put.ts`、`delete.ts`），同一资源的多个方法在 `server/index.ts` 使用 `app.get/post/put/delete` 分别注册；不恢复 `defineRoutes` 或原共享 routes 实现。
* **方法与请求体契约**：沿用 H3/dsh-h3 原生方法处理，GET 包含 HEAD，未注册 OPTIONS 时返回 405；不恢复 `desktopPreflight` 或固定 `MAX_REQUEST_BODY_BYTES`。业务输入仍必须校验。
* **动作端点例外**：无法表达为资源状态迁移的操作，允许 `POST /<资源>/<动作>`（`/tasks/toggle`、`/tasks/run`、`/skills/refresh`、`/import/apply`、`/mcp/check`、`/restart` 等）。动作名必须是动词性领域词，且不得与标准方法语义重复；能用方法表达的写入一律不许写成动作端点。
* **禁止**：用动作后缀表达 CRUD（`/create`、`/update`、`/delete`、`/save`、`/remove`）——一律改为标准方法 + 资源路径；同一 `(method, path)` 不得重复声明。

**6. API 生成契约**

* 使用根目录 `genapi.config.ts` 的 `dsh-h3/genapi` 与既有 ofetch preset，输入为 `host/server/index.ts`，输出为客户端 `apis/index.ts` 和 `apis/index.type.ts`；禁止恢复本地 `genapi.pipeline.ts` 或手写同一套生成逻辑。
* 注册必须使用直接的 `app.get/post/...` 调用与静态完整路径，不能通过动态循环、路径拼接或注册 helper 隐藏。handler 中的 `getQuery<Query>(event)`、`readBody<Body>(event)` 必须位于 handler 本体，不能藏在嵌套回调内；只用 `as Query` 不足以声明生成契约。
* 响应类型须可 JSON 序列化并由 handler 推导或显式声明。若为 `defineEventHandler` 指定 request 泛型，必须同时保证 response 不退化成 unknown；服务返回值、错误分支与客户端类型须一致。

---

## 五、 自检清单 (Checklist)

* [ ] **装配精简**：`apply.ts` 是否仅包含声明式注册（无逻辑内联/过度嵌套）？
* [ ] **状态收口**：内存 Map/Set 是否收拢于 `config/runtime.ts`？是否存在参数击穿透传？
* [ ] **服务约束**：领域服务是否使用 `defineService`（共享请求中间件除外）？文件名与导出标识符是否一致？方法名是否为该领域的动作动词且全仓无同义词混用？
* [ ] **签名收口**：领域服务参数是否按需声明且不含 `ctx`/`host`（载体 `gate.attach` 除外）？是否仅领域服务内部使用 `getServerContext<HostContext>(server)`，且无独立宿主槽？
* [ ] **路由纯度**：`server/routes/` 是否仅负责协议解析与 DTO 校验？无直接操作 `storage`/宿主对象/系统命令行为？
* [ ] **路由形态**：URL 是否为资源路径 + 标准方法（方法命名文件）；动作端点是否仅限 `POST /<资源>/<动作>`，且路径里没有 `/create`、`/update`、`/delete`、`/save`、`/remove` 这类 CRUD 动作后缀？
* [ ] **存储抽象**：`storage/index.ts` 是否仅导出驱动实例？
* [ ] **工具解耦**：`utils/` 是否无状态、脱离业务上下文且未引入契约宏？
* [ ] **类型/工具归属**：单一模块专属的类型/工具是否与所属模块**同目录同名**（`<module>.types.ts` / `<module>.utils.ts`），`types/`、`utils/` 是否只留真正跨模块共享的文件？
* [ ] **常量归属**：`config/constants.ts` 是否只剩多消费方常量，单一消费方的常量是否已直接定义在消费方文件（import 之后、不导出）？
* [ ] **彻底清理**：废弃代码/兼容层/无用 `index.ts` 是否已清理？重命名是否使用 `git mv`？
* [ ] **工程校验**：`pnpm --filter <pkg> typecheck` 与 `test` 是否全绿通过？