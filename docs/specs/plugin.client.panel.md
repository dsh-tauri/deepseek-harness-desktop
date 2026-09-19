# 插件客户端面板协议 (Plugin Client Panel Protocol)

> 本规范是 [plugin.client.md](./plugin.client.md) 在**全局面板**子系统上的协议规范，受 [devlopment.md](./devlopment.md)[cite: 1] 约束。
> **适用范围**：`packages/dsh-tauri/src/client/panel/`（唯一实现）与所有注册面板的插件 `src/client`[cite: 1, 2]。
> **核心门槛：`≥ 0.1.5-rc.1**`。不提供旧核心（`≤ 0.1.2-rc.1`）兼容路径。废弃反射服务（`panel.protocol`）与私有槽位，唯一入口统一为 `definePanel`。

---

## 一、 唯一入口：`definePanel`

### 1. 签名与类型契约

```ts
import { definePanel } from 'dsh-tauri/client'

export const feature1 = defineRegister<SchedulerClientContext>((controller, ctx) => {
  const panel = definePanel(ctx, {
    id: PANEL_ID,
    order: PANEL_ACTION_ORDER,
    locale: locale.NS,
    label: () => locale.text('scheduler'),
    icon: props => <Icon as={Calendar} size={props.size} />,
    render: () => <SchedulerPanel t={t} onClose={panel.close} />,
  })
  controller.add(panel.dispose)
})

```

```ts
export interface PanelIconProps {
  /** 方形边长：wide 16 / 折叠 rail 18 */
  size: number
  /** 当前是否在中间列被选中 */
  active: boolean
}

export interface PanelEntry {
  /** 面板唯一标识：`main` 槽 key 与 `sidebar.panellist` 条目 id（禁止使用 `conversation`） */
  id: string
  /** 面板本体组件；声明 `locale` 后由框架合成 `t` */
  render: ComponentType<{ t?: Translate }>
  /** 入口行文案；支持 thunk 动态求值以跟随语言切换 */
  label: string | (() => string)
  /** 入口行图标；必须消费 ownerProps（静态图标写为 `() => <Icon .../>`） */
  icon: (props: PanelIconProps) => ReactElement
  /** 排序权重，升序，默认 0 */
  order?: number
  /** 面板文案命名空间（`defineLocale` 的 `NS`） */
  locale?: string
}

export interface PanelHandle {
  /** 选中该面板（未注册时自查拦截并记日志，不抛出异常） */
  select: () => void
  /** 回到会话（不切换 Session） */
  close: () => void
  /** 注销入口行与内容条目（幂等） */
  dispose: () => void
}

export function definePanel(ctx: ClientContext, entry: PanelEntry): PanelHandle

```

### 2. 核心约束与机制

* **高阶组装**：一次调用即交齐入口行、内容承载与选中态，消费方无需关注内部槽位细节。
* **注册与生命周期**：在 `defineRegister` 内同步调用，内部自动完成 `ctx.slots.inject`，严禁使用轮询定时器或手动 `ctx.effect` 包裹[cite: 1, 2]；销毁由 `controller.add(panel.dispose)` 托管[cite: 1]。
* **强类型隔离**：类型不匹配时需要的 `as never` 强转**仅允许存在于 `dsh-tauri/client` 内部**，消费方严禁书写。
* **容错自查**：`handle.select()` 内部在触发上游前必须核对 `ctx.slots.entriesOfSlot('main')`，未注册时降级为 `console.error`，严禁直接抛出 `throw`[cite: 1]。

---

## 二、 承载映射与布局机制

`definePanel` 基于底层标准槽位与布局 API 构建，映射关系如下：

| 关注点 | 官方承载 | `definePanel` 内部动作 |
| --- | --- | --- |
| **入口行** | `sidebar.panellist` 槽，条目组件 = 图标，ownerProps = `PanelIconProps` | 自动注入并注册至侧栏清单 |
| **内容** | `main` 槽（`keyed` / `root`），条目 = 面板本体 | 自动注入并注册至主区域 |
| **选中控制** | `ctx.layout.selectPanel(id | null)` | 封装为 `select()` 与 `close()` |
| **状态读取** | `usePanelInfo(info => info.activePanelId)` | 面板根据需要自动读取 |

* **保留 Key 规则**：`conversation` 为官方会话保留 Key，面板 ID 必须避开。
* **作用域与切页**：`main` 槽条目不绑定单 Session，选中面板时布局仅渲染对应 `main` cell，面板需自行从 `ctx.sessions` 维护当前会话。
* **渲染下沉**：侧栏入口由官方侧栏壳原生渲染 `sidebar.panellist` 槽，无需建立克隆侧栏。

---

## 三、 迁移与重构指南

所有面板插件（`dsh-tauri-panel-extension`、`dsh-tauri-panel-scheduler` 等）必须执行以下重构：

1. **常量与类型清理**：
* 删除 `PANEL_SLOT_NAME` / `PANEL_PROTOCOL_NAME` / `PROTOCOL_RETRY_MS`。
* 移除手写的 `PanelProtocol` / `PanelRegistration` 等本地类型，统一使用 `dsh-tauri/client` 导出的标准类型。


2. **握手重构**：
* 彻底删除基于 `setInterval` 重试或 `ctx.slots.inject('sidebar.panel.action', ...)` 的就绪等待逻辑[cite: 2]。
* 将 `protocol.registerPanel(...)` 替换为 `definePanel(ctx, ...)`[cite: 2]。
* 将 `protocol.closePanelContent?.()` 替换为 `panel.close()`。
* 调整图标渲染逻辑，使其正确消费 `{ size, active }` 属性。


3. **面板容器样式**：
* 宿主不再强制包裹面板列宽；面板根节点不再自持列宽，而是由 `definePanel` 的 `render` 外层统一包裹 `dsh-tauri-ui/client` 导出的 `PanelPage`。该页容器逐条对齐官方插件页 `@deepseek-ai/dsh-client-ui-plugin-manager` 的 `.X_2TxG_page`：页根为 `height:100%` + `overflow:auto` 的全宽 flex 列（`align-items:center` + `gap:32px` + `padding:28px clamp(24px,4vw,48px) 48px`），每条直接子项再由 `>*` 规则夹到 `width:100%` + `max-width:960px`。
* 面板自身根节点（如 `.dshp-scheduler__shell`、`.dshp-extension__section`）因此**只负责内容排版**，严禁再声明 `max-width` / `margin-inline:auto` / 纵向 `padding-block` 等页级几何；这些几何已由 `PanelPage` 承担。`--dsh-chat-content-width` 与会话列宽公式对面板不再适用，不要再引用。



---

## 四、 违规反面模式 (Forbidden Patterns)

| 违规形态 | 说明 |
| --- | --- |
| 使用 `panel.protocol` / `ctx.reflect.get('panel.protocol')` | 废弃反射服务；统一使用 `definePanel`[cite: 2] |
| 显式书写私有槽名（`sidebar.panel.action` / `conversation`） | 槽位由 `definePanel` 内部托管，外部禁止直写 |
| 手写 `ctx.slots.register({ name: 'sidebar.panellist' | 'main', ... })` | 必须使用 `definePanel` 进行统一注册 |
| 使用 `setInterval` / `setTimeout` 轮询等待协议就绪 | 就绪状态由槽位声明自动保证[cite: 1, 2] |
| 在消费方代码中使用 `as never` 类型断言 | 类型强转仅限底座内部实现使用 |
| 图标声明为静态 JSX (`icon: <Icon/>`) | 必须声明为函数以接收 `size` 与 `active` 状态 |
| 业务插件直接 `import` 宿主面板包 | 必须且仅能依赖 `dsh-tauri/client` |

---

## 五、 自检清单

* [ ] **入口规范**：面板注册是否仅通过 `definePanel(ctx, entry)` 完成？是否存在遗留的反射获取或私有槽位？
* [ ] **无异步握手**：是否删除了所有轮询重试逻辑？`dispose` 是否通过 `controller.add` 托管[cite: 1]？
* [ ] **类型收拢**：`PanelEntry` / `PanelHandle` / `PanelIconProps` 是否统一从 `dsh-tauri/client` 导入？
* [ ] **图标响应**：`icon` 函数是否正确消费 `{ size, active }`？
* [ ] **关闭链路**：面板内部返回会话是否统一调用 `handle.close()`？
* [ ] **工程校验**：`pnpm typecheck` 与构建流程是否全绿？

