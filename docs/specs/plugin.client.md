# 插件客户端架构规范 (Plugin Client Architecture Protocol)

> 本规范是 [通用软件开发规范与协议 (devlopment.md)](./devlopment.md)[cite: 1] 在 **DeepSeek Harness 插件客户端半区（Browser Runtime）** 的具象化工程落地协议。所有插件的 `src/client` 实现必须严格遵循本规范。
> **姊妹协议**：[插件宿主端架构规范 (plugin.host.md)](./plugin.host.md)[cite: 2] 与 [插件宿主端领域服务协议 (plugin.host.service.md)](./plugin.host.service.md)。两端共享 SSOT、零无用中间层与单向依赖流哲学[cite: 2]，但客户端使用 React 与浏览器生命周期词汇表。

---

## 一、 核心架构原则

1. **唯一事实来源 (SSOT)**
* UI 读取的可变共享状态只能存放在 `store/modules/<domain>.ts`（`defineStore` 定义）[cite: 1]。
* **禁止在 `service/` / `register/` / 组件中持有模块级可变状态**。跨调用留存数据必须进入 store 或 `defineRegister` 的 controller 闭包。


2. **零无用中间层**
* `src/client/index.ts` 只做装配，不放状态、监听、初始化或请求[cite: 2]。
* 严禁建立纯转发的 barrel；`service/` 与 `utils/` 按文件名直接引用[cite: 2]。
* **禁止薄别名**：业务层必须直接调用 `apis/` 函数，不得建立改名转发函数。


3. **彻底删除与零包袱**
* 彻底删除旧注册写法、过渡包装与兼容 re-export[cite: 2]；重命名与搬迁统一使用 `git mv`[cite: 1, 2]。
* 注册函数统一使用 `register*` 前缀，**不保留 `install***`。


4. **单向依赖流**
* 依赖严格自上而下流动，严禁跨层反向依赖或同级环状引用[cite: 2]：



$$\text{client/index.ts} \longrightarrow \begin{bmatrix} \text{register/} \\ \text{hooks/} \\ \text{components/} \end{bmatrix} \longrightarrow \text{service/} \longrightarrow \begin{bmatrix} \text{apis/} \\ \text{store/} \end{bmatrix} \longrightarrow \text{dsh-tauri/client}$$

* **`apis/` 不得导入 `store/**`，**`utils/` 不得导入任何上层目录**[cite: 1]。

5. **生命周期声明式收敛**
* 副作用统一由 `defineRegister` 的 `controller` 托管（订阅、`timeout`、`interval`、`observe`、`listen`）[cite: 1]。
* 禁止裸写 `setTimeout` / `setInterval` / `addEventListener` / `new MutationObserver` 等原生副作用[cite: 1]。命令式白名单写法需标注 `// keep:effect <原因>`[cite: 1]。



---

## 二、 目录结构与决策树

每个插件的 `src/client` 必须严格遵循以下职责边界[cite: 1, 2]：

| 目录/文件 | 职责说明 | 关键约束 |
| --- | --- | --- |
| **`index.ts`** | 装配入口 | 仅平铺装配 feature 与样式（<40 行），无业务逻辑与初始化请求[cite: 2]。 |
| **`constants/`** | 静态常量 | 声明 slot 名、注册 ID、storage key、排序权重；跨 half 常量放 `src/shared/`[cite: 2]。 |
| **`types/`** | 类型定义 | 导出跨文件共享的 interface / type，纯类型无实现[cite: 2]。单一模块专属的类型不入此目录，而是与所属模块**同目录同名**，命名为 `<module>.types.ts`（如 `components/sidebar.types.ts`、`store/modules/settings.types.ts`）；此目录仅保留被多个模块共享的类型。 |
| **`locales/`** | 本地化字典 | 纯词典定义与 `defineLocale` 导出，无业务代码。 |
| **`apis/`** | HTTP 出口 | **唯一允许发请求的层**。路径匹配路由，导出 `get*`/`post*`/`delete*` 函数及 DTO。 |
| **`store/`** | 状态管理 | 包含 `index.ts`（纯聚合）与 `modules/<domain>.ts`（一领域一文件，包含 `state` 与同步 `actions`）[cite: 1]。 |
| **`register/`** | 副作用注册 | **唯一允许登记副作用的层**。使用 `defineRegister` 处理槽位、订阅、观察者与 DOM 补丁[cite: 1]。 |
| **`service/`** | 领域服务 | 包含 Query（`fetch*`/`load*`）与 Action（领域动作）原型，无副作用生命周期。 |
| **`hooks/`** | React 组合 | 跨组件复用的 Hook（含参数化 `useStore` 订阅封装）[cite: 1]。 |
| **`components/`** | 纯 UI 组件 | 一组件一文件，配同名 `.cssr.ts`（若有样式）；仅读 store、发命令[cite: 1]。 |
| **`styles/`** | 公共样式 | 无组件面的公共 cssr 树，仅导出 `CNode` 对象。 |
| **`config/`** | 只读配置 | 存放静态默认值与初始化标志，**严禁存放可变状态**[cite: 2]。 |
| **`utils/`** | 纯工具函数 | 无状态纯函数，不得认识业务概念，不得导入 `store/`/`service/`/`register/`[cite: 1, 2]。单一模块专属的工具与所属模块**同目录同名**，命名为 `<module>.utils.ts`；此目录仅保留被多个模块共享的纯工具（如 `cssr.ts`、`style.ts`）。 |

**落点决策树**：

1. 可变且驱动渲染？→ `store/`；只读配置/常量？→ `config/` 或 `constants/`[cite: 1]。
2. 发送网络请求？→ `apis/`（裸请求）或 `service/`（业务编排）。
3. 跨多次事件存活（订阅/定时器/DOM观察）？→ `register/`；仅纯逻辑调度？→ `service/`[cite: 1]。
4. 仅在 React 渲染周期内使用？→ `hooks/`；返回 JSX？→ `components/`[cite: 1]。
5. 纯数据处理且脱离业务概念？→ `utils/`[cite: 1]。
6. 类型/工具只服务于单一模块？→ 与该模块**同目录同名**：`<module>.types.ts` / `<module>.utils.ts`；被多个模块共享？→ 才落入 `types/`、`utils/`。

---

## 三、 各层通用实现规范

### 1. 装配入口 (`src/client/index.ts`)

* 平铺调用 `ctx.effect(feature, LABEL)` 与 `ctx.slots.register()`，禁止内联回调 >2 行，禁止启动期异步请求[cite: 2]。
* effect 标签不得硬编码字符串：按 [agents.plugins.md](./agents.plugins.md) 的《通用协议：常量归属》决定落点——多消费方进 `constants/`（如 `LOCALE_EFFECT`），单一消费方留在消费方文件[cite: 2]。

### 2. 状态层 (`store/`)

* 导出标识符匹配文件名驼峰化（如 `worktree.ts` $\rightarrow$ `worktree`）。
* 使用 `defineStore({ state, actions })`：`state` 存数据，`actions` **仅做同步状态迁移**[cite: 1]。禁止请求与 `try/catch`。
* 缺席态必须使用模块级常量以保障引用稳定；内容投影至 store 时必须比较值而非引用。
* **禁止建立转发层**：外部直接使用 `store.<domain>.<field>`、`useStore(store.<domain>)` 或 `store.<domain>.<action>()`。严禁自造 `select*` / `use*State` / `patch*` 等单行转发函数。
* `store/index.ts` **仅导出聚合对象**；参数化 selector 一律落入 `utils/` 并显式接收 state[cite: 1]。

### 3. 领域服务层 (`service/`)

只允许以下两种函数原型，签名统一为 `(input: X) => Promise<R>`：

* **Query**：只读数据并更新 store，使用 `fetch*` / `load*` 前缀，返回 `Promise<Data>`。
* **Action**：响应用户意图并更新 store，使用领域动词（`create` / `attach` / `checkout`），返回 `Promise<{ ok: boolean, error?: string }>`。

**约束**：无模块级可变状态，无副作用生命周期（不得调用 `setTimeout`/`subscribe`），乐观更新与失败回滚必须在同一个 Action 内完成[cite: 1]。

### 4. 注册层 (`register/`)

* 一个 feature 一个文件，导出 `export const <feature> = defineRegister(...)`。
* 资源必须通过 `controller.add()` / `observe()` / `interval()` / `timeout()` / `listen()` 托管，彻底避免手动清理[cite: 1]。
* 长流程必须显式检查 `controller.isDisposed()`。代码超过 150 行时，必须将纯状态机逻辑下沉至 `service/`。
* **DOM 补丁**归属于 `register/`（不设 `dom/` 目录），观察器与事件必须经由 controller 托管，选择器仅允许使用稳定属性（`aria-label`、`role`、插件前缀 class）。

### 5. API 层 (`apis/`)

* **唯一允许发请求的层**。使用 `dsh-tauri/client` 导出的 `fetch`，严禁使用 `axios` 或 `window.fetch`。
* 命名格式为 `HTTP动词 + 领域名词`（如 `getBindings`、`postCreate`）。DTO 存放在 `apis/index.type.ts`，领域模型存放在 `types/`[cite: 2]。

### 6. UI 与样式 (`components/`, `styles/`, `hooks/`)

* 组件全小写 kebab-case，仅读 store 和调用 service，禁止直接修改 store 或发网络请求[cite: 1]。
* `.cssr.ts` **只导出 `CNode**`，挂载统一通过 `useMountStyle` 或收敛至 `register/styles.ts`[cite: 1]。
* Hook 命名为 `use-<thing>.ts`，优先复用 `@reause/core` 原语（如 `useIntervalFn`）[cite: 1]。

### 7. 依赖与本地化 (`locales/`, 依赖关系)

* 使用 `defineLocale(PLUGIN_ID, { zh, en })` 声明语言包，通过 `ctx.effect(locale.registerLocale, LOCALE_EFFECT)` 安装。
* 禁止自建 locale store、`let activeLocale` 或在 DOM 选择器中使用文案[cite: 1]。通用动词直接复用 `common` 命名空间。
* **依赖隔离**：第三方库（`unstorage` / `ofetch` / `valtio-define` / `@reause/core` / `lodash-es`）统一由 `dsh-tauri/client` 转出，严禁插件直接 import；需要白名单外的 `lodash-es` 方法时，先补进 `packages/dsh-tauri/src/client/modules/lodash-es.ts`。

---

## 四、 客户端封闭原型总表

| 原型 | 宏 / 落点 | 动词白名单 / 结构 | 状态持有 | 副作用权限 |
| --- | --- | --- | --- | --- |
| **Store** | `defineStore` @ `store/modules/<domain>.ts` | `state` + `actions`（同步迁移） | 持有（唯一真值）[cite: 1] | **严禁**[cite: 1] |
| **Query / Action** | 纯函数 @ `service/<domain>.ts` | Query: `fetch*`/`load*`<br>

<br>Action: 领域动词 | 严禁模块级 | **严禁**[cite: 1] |
| **Feature** | `defineRegister` @ `register/<feature>.ts` | `controller.add/observe/interval/timeout/listen` | 允许闭包状态 | **唯一合法持有者**[cite: 1] |

**禁止出现的违规形态**：

* `service/` 下出现 `.tsx` 文件或 `handle*`/`*Manager` 命名。
* 根目录放置功能文件或设立独立的 `dom/` 目录。
* 建立仅有转发作用的 `index.ts` 或 store 访问代理函数（如 `select*` / `use*State`）。
* 插件直接 import 第三方工具库或在各包中自建 locale 管理器。

---

## 五、 重构与质量自检清单

* [ ] **装配精简**：`client/index.ts` <40 行，无逻辑内联与启动期异步请求[cite: 2]。
* [ ] **状态收口**：模块级可变状态（Map/Set/let）已全部收拢至 store 或 controller 闭包[cite: 1]。
* [ ] **Store 纯度**：`store/modules/*.ts` 仅有 `state` 与同步 `actions`；`store/index.ts` 仅做聚合导出，无转发函数[cite: 1]。
* [ ] **服务原型**：`service/` 函数严格划分为 Query 与 Action 原型，无副作用 API[cite: 1]。
* [ ] **副作用收敛**：无裸写原生定时器、DOM 观察器或事件监听，全部由 controller 托管[cite: 1]。
* [ ] **注册层薄度**：`register/*.ts` 仅做登记编排，>150 行的代码已将逻辑下沉至 `service/`。
* [ ] **请求纯度**：所有网络请求集中于 `apis/`，统一使用 `dsh-tauri/client` 导出的 `fetch`。
* [ ] **依赖与本地化**：无第三方库直接 import；本地化统一采用 `defineLocale`[cite: 1]。
* [ ] **类型/工具归属**：单一模块专属的类型/工具是否与所属模块**同目录同名**（`<module>.types.ts` / `<module>.utils.ts`），`types/`、`utils/` 是否只留真正跨模块共享的文件？
* [ ] **零无意义封装**：不存在 `function f(x) { return lodashFn(x) }` 这类纯转调包装；手写处理逻辑（裁剪、比较、排序、去重、取值、判空）一律改用 `dsh-tauri/client` 转出的 `lodash-es`。
* [ ] **工程校验**：`pnpm --filter <pkg> typecheck` / `lint` / `test` / `build` 全部通过[cite: 2]。