> 该文档已被固定，禁止修改

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
| **`apis/`** | HTTP 出口 | **唯一允许发请求的层**。由 `dsh-h3/genapi` 根据 `host/server/index.ts` 生成请求函数及 DTO，路径、body、query 与服务端注册一致。 |
| **`store/`** | 状态管理 | 包含 `index.ts`（纯聚合）与 `modules/<domain>.ts`（一领域一文件，包含 `state` 与同步 `actions`）[cite: 1]。 |
| **`register/`** | 副作用注册 | **唯一允许登记副作用的层**。使用 `defineRegister` 处理槽位、订阅、观察者与 DOM 补丁[cite: 1]。 |
| **`service/`** | 领域服务 | 包含 Query（`fetch*`/`load*`）与 Action（领域动作）原型，无副作用生命周期。 |
| **`hooks/`** | React 组合 | 跨组件复用的 Hook（含参数化 `useStore` 订阅封装）[cite: 1]。 |
| **`components/`** | 纯 UI 组件 | 一组件一文件；通用控件从 `dsh-tauri-ui` 取用（其样式用 `tv`），包内业务组件直接写 Tailwind `className`；仅读 store、发命令[cite: 1]。 |
| **`styles/`** | 全局样式 | **唯一允许 `.cssr.ts` 的地方**：无组件面的全局样式树，仅导出 `CNode` 对象。 |
| **`config/`** | 只读配置 | 存放静态默认值与初始化标志，**严禁存放可变状态**[cite: 2]。 |
| **`utils/`** | 纯工具函数 | 无状态纯函数，不得认识业务概念，不得导入 `store/`/`service/`/`register/`[cite: 1, 2]。单一模块专属的工具与所属模块**同目录同名**，命名为 `<module>.utils.ts`；此目录仅保留被多个模块共享的纯工具（如 `style.ts`）。 |

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
* effect 标签不得硬编码字符串：按 [plugin.baisc.md](./plugin.baisc.md) 的《通用协议：常量归属》决定落点——多消费方进 `constants/`（如 `LOCALE_EFFECT`），单一消费方留在消费方文件[cite: 2]。

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
* **内核能力差异一律经适配层**：`defineRegister` 第三个参数 `adapter`（由 `defineAdapter(ctx)` 创建）只读能力探测面（`adapter.has('sessions.list')`、`adapter.sessions`、`adapter.workspaces`），按 [plugin.baisc.md](./plugin.baisc.md) 的退级阶梯择路，**不猜核心版本号、不写死槽名**。
* **DOM 补丁**归属于 `register/`（不设 `dom/` 目录），观察器与事件必须经由 controller 托管，选择器仅允许使用稳定属性（`aria-label`、`role`、插件前缀 class）。

### 5. API 层 (`apis/`)

* **唯一允许发请求的层**。JSON 请求使用 `dsh-tauri/client` 导出的 `ofetch`（与既有 `fetch` 为同一 JSON 实例，不是流式传输）；严禁使用 `axios` 或 `window.fetch`。
* `apis/index.ts` 与 `apis/index.type.ts` 由根目录 `genapi.config.ts` 使用 `dsh-h3/genapi` 从 `host/server/index.ts` 生成，修改服务契约后运行 `pnpm genapi`，禁止手改生成结果或恢复 `genapi.pipeline.ts`。插件路径统一为 `/api/tauri/<插件短名>`（如 `/api/tauri/ssh/machines`），生成类型与消费方按新路径同步，不建立旧 URL 或 DTO 名别名。
* 请求函数名使用 `HTTP动词 + 路径领域名词`，通过根配置的 transform/patch 保持必要的既有操作名；body/query 必须传入生成函数对应参数，不能误当请求 options。业务类型可从生成响应的成功分支派生，保留真实错误联合，不复制另一套 DTO。
* 保持现有 JSON 传输：插件生成文件使用 `dsh-tauri/client` 的 `ofetch` 与 type-only `FetchOptions`；桌面壳 SSH 的 `src/apis/remote.ts` 使用 `./http` 的 invoke 适配，不改用浏览器原生 fetch。

### 6. UI 与样式 (`components/`, `styles/`, `hooks/`)

* 组件全小写 kebab-case，仅读 store 和调用 service，禁止直接修改 store 或发网络请求[cite: 1]。
* **资源化优先 `dsh-tauri-ui`**：通用控件（按钮、图标按钮、chip、tag、开关、复选框、下拉菜单、输入、分段控件、面板容器）与图标一律从 `dsh-tauri-ui/client` 取用；严禁在包内自建同名通用组件，也严禁直接 import 官方 `@deepseek-ai/dsh-client-ui-primitives`（官方组件的跨内核版本差异由 `dsh-tauri-ui` 统一吸收）。缺什么就补进 `dsh-tauri-ui` 的组件层，不在消费包里各写一份。
* 包内 `components/` 只保留业务组件与包专属布局样式；任何可能被第二个包复用的组件，上提到 `dsh-tauri-ui`。
* **样式选型按「通用 / 业务」二分**：
  * **通用控件一律用 `tv`（`tailwind-variants`）+ Tailwind 工具类**：变体即类型（`VariantProps` 推导，禁止手写变体/尺寸类型），多部件用 `slots`，条件态用布尔变体与 `compoundSlots`。
  * **业务组件直接写 `className`**：一次性布局与配色不建 variant 层、不抽象 `tv`。
  * 颜色优先用 `tailwind.plugins.config.js` 已登记的语义 token（`text-primary`、`bg-layer-1`、`border-border-l3`、`shadow-focus-ring`）；未登记的官方变量才回退任意值 `bg-[var(--dsw-*)]`。新增主题键必须同步该配置文件。
  * 新写的工具类只有在插件 Tailwind 产物里存在才生效——产物是 `dsh-tauri-ui` 的 `src/client/styles/index.ts`（由 `scripts/taiwindcss.ts` 消费同目录 `index.css`、扫描 `packages/*/src` 生成、lightningcss 压缩后内嵌，并由 `dsh-tauri-ui` 自己 `mountStyle`）；dev 下 watcher 自动重生成，提交前跑 `pnpm build:taiwindcss`；漏生成不会报错，只是静默无样式。
  * **叠加同类工具类必须消歧**：Tailwind 里同属性谁生效由**产物顺序**决定，不由 className 里的先后决定。`bg-transparent font-normal` 这类「基础态」不要与条件类同列叠加（`bg-transparent` 在产物里更靠后，会盖掉条件分支的 `bg-[…]`）；手写 `className` 用 `cn()`（`dsh-tauri/client` 转出的 tailwind-merge）合并，或三元整段互换；`tv` 内部已走 merge，无需额外处理。
  * **禁止用 `font` 简写**：`[font:inherit]` 是 shorthand，会把同列 `text-[13px]` 的 `font-size` 一起重置（产物里 arbitrary property 排在字号工具类之后 → 字号变大）。要继承字体只写 `[font-family:inherit]`。
* **`.cssr.ts` 仅用于全局样式**（`styles/` 下的公共样式树，如 `global.cssr.ts`）：组件级样式一律不进 cssr；只导出 `CNode`，挂载统一通过 `mountStyle` / `register/styles.ts`[cite: 1]。
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
* [ ] **请求纯度**：所有网络请求集中于 `apis/`，JSON 请求统一使用 `dsh-tauri/client` 的 JSON 实例 `ofetch`/`fetch`，不把该实例作为流式传输。
* [ ] **依赖与本地化**：无第三方库直接 import；本地化统一采用 `defineLocale`[cite: 1]。
* [ ] **类型/工具归属**：单一模块专属的类型/工具是否与所属模块**同目录同名**（`<module>.types.ts` / `<module>.utils.ts`），`types/`、`utils/` 是否只留真正跨模块共享的文件？
* [ ] **零无意义封装**：不存在 `function f(x) { return lodashFn(x) }` 这类纯转调包装；手写处理逻辑（裁剪、比较、排序、去重、取值、判空）一律改用 `dsh-tauri/client` 转出的 `lodash-es`。
* [ ] **组件资源化**：通用控件与图标全部来自 `dsh-tauri-ui/client`，包内无重复实现、无对官方 `@deepseek-ai/dsh-client-ui-primitives` 的直连 import。
* [ ] **工程校验**：`pnpm --filter <pkg> typecheck` / `lint` / `test` / `build` 全部通过[cite: 2]。