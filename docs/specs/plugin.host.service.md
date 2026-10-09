> 该文档已固定，禁止修改。

# 插件宿主端领域服务协议 (Plugin Host Service Protocol)

> 本规范为 [plugin.host.md](./plugin.host.md) 的**子协议**，整体受 [devlopment.md](./devlopment.md) 约束[cite: 1]。
> **适用范围**：`packages/*/src/host/service/`[cite: 1]。
> **核心原则**：通过 **「单一导出 + 动词白名单 + 统一签名」** 消除同义冗余、参数散装与职责穿透[cite: 1]。

---

## 一、 唯一定义宏：`defineService`

所有领域服务统一使用 `dsh-tauri` 导出的 **`defineService`** 声明（共享请求中间件除外）[cite: 1]：

```typescript
import { defineService } from 'dsh-tauri'

```

* **特性与约束**：运行时零开销，仅在编译期约束服务对象成员**必须全为函数**[cite: 1]。散装状态必须留在模块作用域[cite: 1]。
* **铁律**：领域服务严禁自定义/封装其它服务宏，严禁手写裸对象（如 `export const x = {...}`）[cite: 1]。

---

## 二、 三条服务铁律

### 1. 单一导出 (Single Export)

* **一个文件有且仅有一个 `export**`（即服务对象本身）[cite: 1]。
* **导出标识符 = 文件名驼峰化 (kebab-case → camelCase)**，不存在 `name` 属性或第二份字符串身份声明[cite: 1]。
* `service/ledger.ts` $\rightarrow$ `export const ledger`[cite: 1]
* `service/session-context.ts` $\rightarrow$ `export const sessionContext`[cite: 1]


* **禁止导出其它内容**：类型归入 `types/`，常量归入 `config/`[cite: 1]。单模块专属类型与所属模块**同目录同名**（`<module>.types.ts`，见 [plugin.host.md](./plugin.host.md) 第二章）。私有函数统一收敛于文件末尾 `// --- internal ---` 且不导出[cite: 1]。
* **常量归属**：见 [plugin.baisc.md](./plugin.baisc.md) 的《通用协议：常量归属》——单一消费方的常量定义在消费方文件（不导出、放 import 之后），`config/constants.ts` 只留多消费方常量。
* **类型归属**：`config/` 下**不允许**出现 `*.types.ts`；跨模块共享的宿主面类型（`SessionHost` / `PanelExtensionHost` 等）放 `host/types/index.ts`。

### 2. 动词白名单 (Verb Whitelist)

* 服务必须归类为四种角色之一，方法名**只能使用允许的动词**（见第三章）[cite: 1]。
* 允许的动词是**上限**，未被消费的方法一律不写[cite: 1]。禁止出现白名单外的自造动词（如 `getStatus`）[cite: 1]。

### 3. 签名与宿主隔离 (Signatures & Host Isolation)

* **参数扁平**：按业务需求直接传参，不做无意义的单对象包装[cite: 1]。
* **无 `ctx`/`host` 参**：领域服务方法不得透传宿主对象。`apply.ts` 先通过 `ctx.effect(() => server(ctx, options), label)` 激活服务，服务内部从 `dsh-h3/utils` 导入原生 `getServerContext`，使用 `getServerContext<HostContext>(server)` 按需读取宿主能力；不在 `dsh-tauri` 重导出，不建立泛型兼容层或独立的宿主绑定与清除函数。
* **隔离访问**：只有 `service/` 读取业务宿主能力；`server/routes/`、`tools/` 等通过领域服务调用。路由可以通过 `dsh-h3/utils` 的 `getServerOptions<Options>(event)` 读取当前请求所属实例的配置，不得用模块变量代替。
* **基础设施例外**：`dsh-tauri` 的请求安全中间件可以从 event 读取 Context，载体鉴权适配 `gate.attach(ctx)` 可以显式接收 Context；两者不属于业务宿主透传。共享请求中间件不适用领域服务的 `defineService` 宏。

---

## 三、 服务角色与标准范例

### 3.0 词汇表总览

| 服务角色 | 判定特征 | 允许的动词 | 核心约束 |
| --- | --- | --- | --- |
| **持久化** | 业务实体落盘[cite: 1] | `load` / `save` / `remove` / `list`[cite: 1] | **唯一**允许读写 `storage` 的角色；负责 JSON 容错与校验[cite: 1]。 |
| **长任务** | 异步无法同步等待[cite: 1] | `start` / `lookup` / `unsettled`[cite: 1] | 维护内存状态机 (`pending`/`running`...)；禁止同步阻塞[cite: 1]。 |
| **领域编排** | 主流程组合编排[cite: 1] | 领域动词 (`create` / `checkout` / `attach` / `inherit` ...)[cite: 1] | 组合调用其它服务与 `utils/`，自身不落盘、不调底层命令[cite: 1]。 |
| **只读推演** | 从环境推导事实[cite: 1] | `resolve` / `peek`[cite: 1] | 必须无副作用，推导失败直接返回 `null`，**严禁猜测**[cite: 1]。 |

* **领域聚合服务**：一个文件名 = 一个领域名词（`task` / `session` / `skills` / `mcp`），同一领域不再按角色拆成多个服务文件。方法名直接用该领域的动作动词：`list` / `get` / `getDir` / `removeDir` / `openDir` / `create` / `update` / `remove` / `toggle` / `advance` / `getCatalog` / `listSources` / `getSource` / `saveSource` / `removeSource` / `setPolicy`。已按此合并的旧拆分：`tasks.ts` + `task.ts` → `task.ts`；`session-files.ts` + `session-store.ts` → `session.ts`；`skill-catalog.ts` + `skill-root.ts` + `skill-policy.ts` + `skills.ts` → `skills.ts`；`mcp-toggle.ts` → `mcp.ts`。
* **不暴露无消费者的方法**：原先为内部复用而挂在服务上的 `save` / `load` 等，若无外部消费者就下沉为模块级私有函数；模块专属的 utils / types / test 随模块改名（`session-files.utils.ts` → `session.utils.ts`）。

---

### 3.1 持久化 (Persistence)

```typescript
// service/ledger.ts
import { defineService, storage } from 'dsh-tauri'
import type { Binding } from '../types'

export const ledger = defineService({
  async load(sessionId: string): Promise<Binding | null> {
    const raw = await storage.getItem<Binding>(keyOf(sessionId))
    return raw ?? null
  },
  async save(sessionId: string, binding: Binding): Promise<void> {
    await storage.setItem(keyOf(sessionId), binding)
  },
  async remove(sessionId: string): Promise<void> {
    await storage.removeItem(keyOf(sessionId))
  },
  async list(): Promise<Binding[]> {
    const keys = await storage.getKeys('ledger/')
    const items = await Promise.all(keys.map(k => storage.getItem<Binding>(k)))
    return items.filter((item): item is Binding => Boolean(item))
  },
})

// --- internal ---
function keyOf(sessionId: string) { return `ledger/${sessionId}.json` }

```

### 3.2 长任务 (Long Task)

```typescript
// service/cleaner.ts
import { defineService } from 'dsh-tauri'
import type { DiscardJob } from '../types'

export const cleaner = defineService({
  start(sessionId: string, worktreeKey: string): DiscardJob {
    // 登记任务，合并同键在途 Promise，立即返回 jobId（不阻塞）
  },
  lookup(sessionId: string, jobId?: string): DiscardJob | undefined { /* ... */ },
  unsettled(): DiscardJob[] { /* ... */ },
})

// --- internal ---
const jobs = new Map<string, DiscardJob>()

```

### 3.3 领域编排 (Domain Orchestration)

```typescript
// service/workspace.ts
import { defineService } from 'dsh-tauri'

export const workspace = defineService({
  async create(sessionId: string, projectPath: string) { /* 编排 */ },
  async checkout(sessionId: string, branch: string) { /* 编排 */ },
  async attach(sessionId: string) { /* 编排 */ },
})

```

### 3.4 只读推演 (Read-only Inference)

```typescript
// service/session-context.ts
import type { HostContext } from '../types'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { server } from '../server'

export const sessionContext = defineService({
  resolve(sessionId: string): string | null {
    const session = getServerContext<HostContext>(server).sessions.get(sessionId)
    return session?.header.cwd ?? null
  },
  peek(sessionId: string) { /* 只读查看，无副作用 */ },
})

```

---

## 四、 违规反面清单

* ❌ **模糊命名**：文件名出现 `manager` / `helper` / `utils` / `common` / `base`[cite: 1]。
* ❌ **冗余后缀**：使用 `xxxService` / `xxxManager` / `xxxHandler`（只允许领域名词裸名）[cite: 1]。
* ❌ **同义词混用**：同一语义在同一服务里换词（如 `get` / `fetch` / `read` / `query` 混用）。领域动作动词（`getDir` / `getCatalog` / `setPolicy` 等）属于白名单放宽范围，但必须全仓一致[cite: 1]。
* ❌ **常量错位**：单一消费方的常量登记进 `config/constants.ts`，或把模块私有常量放到文件末尾（触发 `ts/no-use-before-define`）[cite: 1]。
* ❌ **类型错位**：在 `config/` 下建 `*.types.ts`；跨模块共享的宿主面类型散落在 `config/`[cite: 1]。
* ❌ **非函数成员**：在服务对象上挂载变量、常量或类型[cite: 1]。
* ❌ **杂物导出**：在 `service/` 文件中导出 `type`、`const` 或内部辅助函数[cite: 1]。
* ❌ **透传宿主**：领域服务方法接收 `ctx` 或 `host` 参数；载体适配 `gate.attach(ctx)` 仅按第二章的基础设施例外处理。

---

## 五、 服务层自检清单

* [ ] 服务是否使用 `defineService` 声明，且未新增其它自定义服务宏[cite: 1]？
* [ ] 文件是否有且仅有一个导出，且导出名等于文件名的驼峰形式[cite: 1]？
* [ ] 服务对象是否全部由函数组成（无散装状态/常量）[cite: 1]？
* [ ] 所有方法名是否为该领域的动作动词、且全仓无同义词混用[cite: 1]？
* [ ] 领域服务参数是否扁平，且未包含 `ctx`/`host` 形参；`gate.attach(ctx)` 是否仅用于载体适配？
* [ ] 是否仅在领域服务内部使用 `getServerContext<HostContext>(server)`，其它业务层通过服务间接调用，基础设施例外是否保持窄边界[cite: 1]？
* [ ] 私有函数是否收纳于 `// --- internal ---` 且未导出；单一消费方的常量是否直接定义在消费方文件的 import 之后[cite: 1]？
* [ ] 类型是否落在模块同名 `.types.ts` 或共享的 `host/types/`；`config/` 下是否已无 `*.types.ts`；`config/constants.ts` 是否只剩多消费方常量[cite: 1]？