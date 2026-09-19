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

$$\text{apply.ts (装配)} \longrightarrow \begin{bmatrix} \text{routes/} \\ \text{tools/} \\ \text{events/} \\ \text{prompts/} \end{bmatrix} \longrightarrow \text{service/ (业务领域)} \longrightarrow \begin{bmatrix} \text{storage/} \\ \text{utils/} \end{bmatrix}$$



---

## 二、 目录结构与规范

各插件 `src/host/` 物理落点定义如下：

| 目录/文件 | 职责说明 | 关键约束 |
| --- | --- | --- |
| **`apply.ts`** | 装配入口 | 仅做声明式组装（工具/事件/提示词/路由），控制在 30~50 行以内，不含业务逻辑。 |
| **`config/`** | 配置与单例 | `runtime.ts`: 导出内存单例及 `setCurrentHostInstance`/`getCurrentHostInstance` 宿主绑定。<br>

<br>`constants.ts`: 静态常量与配置，严禁硬编码 Magic Number/String；只登记**两个及以上模块**消费的常量（单一消费方的常量归属见 [agents.plugins.md](./agents.plugins.md) 的《通用协议：常量归属》），`config/` 下不允许出现 `*.types.ts`。 |
| **`types/`** | 类型定义 | 导出领域模型、DTO、输入输出接口（纯类型定义）。单一模块专属的类型与所属模块**同目录同名**，命名为 `<module>.types.ts`（如 `service/worktree.types.ts`）；此目录仅保留被多个模块共享的类型（如 `index.ts`）——跨模块共享的**宿主面类型**（`SessionHost` / `PanelExtensionHost` 等）统一放 `types/index.ts`。 |
| **`storage/`** | 持久化实例 | `index.ts` 纯粹导出持久化驱动实例，不包含任何业务读写逻辑。 |
| **`routes/`** | HTTP 路由层 *(可选)* | 遵循“文件路径 = URL 路径”，且**目录层级 = URL 层级**（`routes/session/open/path/post.ts` → `<前缀>/session/open/path`）。仅做协议解析、DTO 校验与 Service 调用，不含业务实现。`disposer.*({ kind, path })` 的 `path` **一律直接写字面量**（统一前缀 `/api/desktop/<plugin-id>`），禁止为路由路径定义 `*_ROUTE` 常量，也不再使用 `API_PREFIX` 之类的拼接常量。 |
| **`tools/`** | Agent 工具层 *(可选)* | 单工具单文件，包含声明、JSON Schema 与 execute 编排。 |
| **`prompts/`** | 系统提示词层 *(可选)* | 拆分为常驻提示词 (`*-section.ts`) 与动态单次上下文注入 (`*-context.ts`)。 |
| **`events/`** | 事件监听层 *(可选)* | 宿主生命周期事件处理（如 `turn/end`、工具前置拦截等）。 |
| **`service/`** | 领域服务层 | 全员使用 `defineService`。唯一可读写 storage 和访问宿主能力（`ctx`/`host`）的层。 |
| **`utils/`** | 底层工具纯函数 | 纯粹、无状态，不包含业务上下文与契约宏。返回标准操作结果 `{ ok: boolean, ... }`。单一模块专属的工具与所属模块**同目录同名**，命名为 `<module>.utils.ts`；此目录仅保留被多个模块共享的纯函数（如 `git.ts`、`paths.ts`）。 |

---

## 三、 结构范例 (`dsh-tauri-worktree`)

```text
packages/dsh-tauri-worktree/src/host/
├── apply.ts                   # 平铺装配器
├── config/ (runtime.ts | constants.ts)
├── types/index.ts             # 仅跨多模块共享类型；单模块专属类型与其模块同目录同名
├── storage/index.ts           # 仅导出 storage 实例
├── routes/                    # RESTful 文件路由 (例: delete.ts -> DELETE /api/worktree)
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
export function apply(ctx: HostContext): void {
  setCurrentHostInstance(ctx) // 1. 绑定宿主能力（仅 service 层可通过 getCurrentHostInstance() 读取）

  ctx.tools.register(createWorktreeTool())
  ctx.tools.register(checkoutWorktreeTool())
  ctx.on('session/event', (session, event) => handleSessionEvent(session, event))
  ctx.on('tools/execute', (exec, next) => handleToolsExecute(exec, next))
  ctx.systemPrompt.context(checkoutContextProvider)
  ctx.systemPrompt.section(worktreeSectionProvider)
  
  ctx.effect(() => routes(ctx), 'plugin: routes')
}

```

**2. 配置与状态层 (`config/`)**

* `runtime.ts` 导出内存单例与宿主绑定函数 (`setCurrentHostInstance` / `getCurrentHostInstance`)。宿主进程按 `--profile` 启动，单进程内插件仅挂载一次，模块级单例安全。必须包含清除/销毁机制以防内存泄漏。

**3. 持久化层 (`storage/`)**

* `storage/index.ts` 仅负责创建并导出驱动实例（如 `createStorage({ driver: fsAtomicDriver(...) })`）。
* 禁止在 `storage/` 目录下编写业务增删改查，存取逻辑统一收拢于 `service/` 对应的持久化服务中。

**4. 业务领域服务层 (`service/`)**

* 统一使用 `dsh-tauri` 的 `defineService` 宏声明，禁止自造宏。
* `routes/`、`tools/`、`events/`、`prompts/` 严禁直接接触宿主对象或底层 `storage`，必须通过服务层间接访问。

**5. 路由形态 (`routes/`)**

* **默认 RESTful 资源化**：URL 只描述资源，动作由 HTTP 方法承担。文件按方法命名（`get.ts` → `GET`、`post.ts` → `POST`、`put.ts` → `PUT`、`delete.ts` → `DELETE`），同一资源路径的多个方法在 `routes/index.ts` 里分行声明、由 `defineRoutes` 收敛为一行注册（例：`tasks/get.ts` + `tasks/post.ts` + `tasks/put.ts` + `tasks/delete.ts` → `GET|POST|PUT|DELETE <前缀>/tasks`）。
* **动作端点例外**：无法表达为资源状态迁移的操作，允许 `POST /<资源>/<动作>`（`/tasks/toggle`、`/tasks/run`、`/skills/refresh`、`/import/apply`、`/mcp/check`、`/restart` 等）。动作名必须是动词性领域词，且不得与标准方法语义重复；能用方法表达的写入一律不许写成动作端点。
* **禁止**：用动作后缀表达 CRUD（`/create`、`/update`、`/delete`、`/save`、`/remove`）——一律改为标准方法 + 资源路径；同一 `(kind, path)` 不得重复声明。

---

## 五、 自检清单 (Checklist)

* [ ] **装配精简**：`apply.ts` 是否仅包含声明式注册（无逻辑内联/过度嵌套）？
* [ ] **状态收口**：内存 Map/Set 是否收拢于 `config/runtime.ts`？是否存在参数击穿透传？
* [ ] **服务约束**：是否全员使用 `defineService`？文件名与导出标识符是否一致？方法名是否为该领域的动作动词且全仓无同义词混用？
* [ ] **签名收口**：服务方法参数是否按需声明且不含 `ctx`/`host`？是否仅 `service/` 内部使用 `getCurrentHostInstance()`？
* [ ] **路由纯度**：`routes/` 是否仅负责协议解析与 DTO 校验？无直接操作 `storage`/宿主对象/系统命令行为？
* [ ] **路由形态**：URL 是否为资源路径 + 标准方法（方法命名文件）；动作端点是否仅限 `POST /<资源>/<动作>`，且路径里没有 `/create`、`/update`、`/delete`、`/save`、`/remove` 这类 CRUD 动作后缀？
* [ ] **存储抽象**：`storage/index.ts` 是否仅导出驱动实例？
* [ ] **工具解耦**：`utils/` 是否无状态、脱离业务上下文且未引入契约宏？
* [ ] **类型/工具归属**：单一模块专属的类型/工具是否与所属模块**同目录同名**（`<module>.types.ts` / `<module>.utils.ts`），`types/`、`utils/` 是否只留真正跨模块共享的文件？
* [ ] **常量归属**：`config/constants.ts` 是否只剩多消费方常量，单一消费方的常量是否已直接定义在消费方文件（import 之后、不导出）？
* [ ] **彻底清理**：废弃代码/兼容层/无用 `index.ts` 是否已清理？重命名是否使用 `git mv`？
* [ ] **工程校验**：`pnpm --filter <pkg> typecheck` 与 `test` 是否全绿通过？