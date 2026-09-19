> 该文档大部分已固定，仅允许添加少量注释。

# DeepSeek Harness Desktop 开发规范文档

> **架构概览**：基于 Tauri 2 + React 19，内嵌服务运行于 `[http://127.0.0.1:3080](http://127.0.0.1:3080)` (Debug 环境默认 `3081`)。

---

## 1. 技术栈与常用命令 (Tech Stack & Commands)

* **前端**：React 19, TypeScript, Tailwind CSS v4, Vite (`src/`)
* **后端**：Rust, Tauri v2 (`src-tauri/`)
* **开发命令**：
```bash
pnpm install && pnpm dev    # 前端开发
pnpm typecheck              # 前端 TS 类型检查 (改动前端后必跑)
pnpm tauri dev              # 桌面端完整 Debug 模式
cargo check && cargo test   # Rust 检查与单元测试 (src-tauri 目录下)

```

---

## 2. 核心架构设计原则 (Architecture Principles)

* **端口与数据隔离**：
* **端口**：Release 默认 `3080`；Debug 默认 `3081`（通过 `cfg!(debug_assertions)` 隔离，防止端口争用）。
* **数据**：Debug 环境数据目录为 `~/.dsh.dev`，Store 文件为 `.store.dev.dat`。Debug 下 `terminate_stale_harness_processes` 为 no-op，改用 `.dsh.dev/.harness.pid` 精确回收进程，且不执行旧数据迁移与 PATH 注册。

* **内置插件宿主依赖边界**：
* `packages/*/src/host/` 运行于独立的 `resources/node_modules`。
* **禁止**静态引用任何 `@deepseek-ai/*` 运行时包（如 `import`/`require`），仅允许 `type-only import`。
* 必须通过宿主上下文 `loader.import()` 解析模块，并按需使用 `loader.unwrapExports()`。

* **Windows 极简模式**：
* 修复项 `dsh-win-terminal-inspector` 确认后从 GitHub 动态安装（桌面端不内置源码）。
* 自动挂载 `cordis.patch.yml` 并生成 `$DSH_HOME/.agent-presets/minimal-win/` 预设。

* **桌宠模块 (`src/pet` + `dsh-tauri-pet`)**：
* 预设宠物**不下载不安装**，由 `preset-pets.json` 登记远端 URL 并直连播放，落 IndexedDB 缓存。
* `src/pet/main.tsx` 使用 `@tauri-apps/plugin-http` 的 `fetch` 实现绕过 CORS。
* macOS 自动使用 `.mov` (HEVC-alpha) 格式。

---

## 3. 前端编码规范 (Frontend Specifications)

### 3.1 编码基础与函数声明 (Basics & Function Syntax)

* **组件与函数声明**：命名函数必须使用 `function` 关键字，箭头函数仅用于回调参数。
```tsx
// ✅ 正确
function UserProfile() {
  function handleSave() { /* ... */ }
  return <button onClick={handleSave}>Save</button>;
}

// ✅ 正确：回调中使用箭头函数
useQuery({ queryFn: async () => fetchData() });

```

* **自动记忆化**：已接入 `react-compiler`（target 19），**禁止使用** `useCallback` / `useMemo`。
* **UI 组件优先**：优先使用 `src/components` 和 HeroUI 组件，减少自定义 CSS 类。
* **i18n 规范**：禁止硬编码字符串。key 必须拍平（扁平点号命名，如 `setting.title`），同步维护 `src/i18n/locales/en-US.json` 与 `zh-CN.json`。

### 3.2 Hooks 使用指南 (`@reause/core`)

壳层副作用**统一使用 `@reause/core**`。已移除 `react-use` 与 `@hairy/react-lib`，禁止引入。

> ⚠️ **`useEffect` 是最后手段**：仅在“必须注册/注销 reause 未涵盖的外部资源”时使用。

| 场景 | 推荐 API | 禁用方式 |
| --- | --- | --- |
| 观察值变化 | `useWatch` / `useWhenever` | `useEffect(deps)` |
| 仅 Mount 时执行 | `useMount` | `useEffect(..., [])` |
| Tauri 事件订阅 | `useListen` (含自动注销/防竞态) | `useEffect` + `listen` |
| DOM 事件 | `useEventListener` | `addEventListener` |
| 定时轮询 / 延时 | `useIntervalFn` / `useTimeoutFn` | `setInterval` / `setTimeout` |
| 异步延时 | `promiseTimeout` | `new Promise(r => setTimeout(r, ms))` |
| 深色模式判定 | `usePreferredDark` / `useMediaQuery` | `matchMedia` 手写监听 |
| 开关状态 | `useToggle` | `useState(false)` 手写逻辑 |
| 跨组件事件 | `createEventHook` + `useListener` | 全局 EventBus |
| 设置变更失效查询 | `useInvalidateOnSettingUpdated(key)` | 手写监听 `setting_updated` |
| iframe 消息通信 | `useIframePost` / `useIframeMessage` | 手写 `postMessage` |

### 3.3 条件渲染规范 (Conditional Rendering)

禁止使用三元运算符与 `&&`，统一使用 `react-if-lite` 包中的 `<If>`、`<Then>`、`<Else>`。

```tsx
<If cond={!isLoading} else={<LoadingSpinner />}>
  <Content />
</If>

<If cond={hasData}>
  <Then><DataTable data={data} /></Then>
  <Else><Empty /></Else>
</If>

```

### 3.4 样式与 Variant 设计 (`tv`)

变体多或包含多 Slot 的组件统一使用 `tailwind-variants (tv)`，并使用主题 Token。

```tsx
export const cardStyle = tv({
  slots: { base: 'relative p-4', icon: 'size-6 rounded-full' },
  variants: {
    intent: {
      success: { icon: 'bg-success-100 text-success' },
      warning: { icon: 'bg-warning-100 text-warning' },
    },
  },
  defaultVariants: { intent: 'success' },
});

```

---

## 4. 状态与数据流控制 (State & Data Management)

### 4.1 Store 组织规范 (`src/store/modules/<name>/`)

使用 `valtio-define`，按模块封装，`index.ts` 作为**唯一**暴露出口。`defineScope` / `useScope` 已废弃。

```
src/store/modules/user/
├── index.ts      # 唯一出口 (barrel)：export { user } from './store'; export type ...
├── store.ts      # defineStore({ state, getters, actions })
├── types.ts      # 模块类型定义
└── utils.ts      # 纯逻辑工具函数

```

* 复杂派生状态写在 `getters` 中（需显式声明返回值类型）。
* Store 间的协作只能通过对方的 `index.ts` 调用，禁止越级引用 `store.ts`。

### 4.2 数据请求与查询 (`TanStack Query`)

* 查询键 (Query Keys) **必须**集中注册在 `src/config/query-keys.ts` 中。
* 单一消费者查询内联在组件中；跨组件共享数据由 `layout/index.tsx` 或指定管理者统一更新缓存。
* 复杂服务封装文件置于 `services/` 目录，命名遵循 `use-get-{resource}.ts` 规范。

### 4.3 弹窗规范 (`@overlastic/react`)

命令式弹窗统一放在 `src/ui/dialog/`，业务组件结合 `useDisclosure` 实现：

```tsx
import { useDisclosure, type PropsWithOverlays } from '@overlastic/react';

export interface ConfirmDialogProps extends PropsWithOverlays<{ title: string }, boolean> {}

function ConfirmDialog(props: ConfirmDialogProps) {
  const disclosure = useDisclosure({ props, delay: 300 });
  return (
    <Modal isOpen={disclosure.visible} onClose={() => disclosure.cancel()}>
      <Button onPress={() => disclosure.confirm(true)}>Confirm</Button>
    </Modal>
  );
}

```

---

## 5. 后端与 Rust 规范 (Backend Rules)

1. **注释要求**：仅使用中文注释。模块头用 `//!`，函数说明用 `///`（侧重阐述原因）。
2. **错误处理**：`Result<_, String>` 的错误信息必须包含大写前缀（如 `NODE_NOT_FOUND: ...`）。
3. **Windows 适配**：
* 子进程启动必须使用 `CREATE_NO_WINDOW (0x08000000)`。
* 停止服务时使用 `taskkill /T /F` 杀掉进程树，防止 DLL 锁死。
* 更新 PATH 后需广播 `WM_SETTINGCHANGE`。


4. **CLI Shim (`service/cli`)**：
* 脚本存放路径：Win `%LOCALAPPDATA%\deepseek-harness\bin`，Unix `~/.local/bin`。
* 优先使用本地 Node (v22.19+ / v24+，不支持 v23)，回退到捆绑 Node。
* Shim 文本**必须全英文**，避免编码页乱码。



---

## 6. 关键踩坑与修复避坑指南 (Pitfalls & Fixes)

* **原生模块 ABI 校验**：`prepare_active_runtime` 在启动前会运行 `NATIVE_PROBE_SCRIPT` 探测 ABI。若匹配失败，将自动补齐依赖或切至捆绑 Node 运行时。
* **pnpm Store 绑定冲突**：为防止全局 `store-dir` 冲突导致插件安装失败，`build_plugin_envs` 会将档案记录的 `storeDir` 显式注入为**两个**环境变量 `npm_config_store_dir` 与 `pnpm_config_store_dir`。两个前缀都要设：pnpm 11 起不再读取 `npm_config_*`（`config/reader` 的 `parseEnvVars` 只认 `pnpm_config_`，其余静默丢弃），只设前者对捆绑版 pnpm 11 是空操作，档案记录的 store 根本没下传；pnpm 10 只认 `npm_config_*`，所以两个都设、值相同。注入的是**去掉末尾 `v10`/`v11` 版本段的基目录**（`strip_store_version`）——pnpm 的 `getStorePath` 只在传入路径已以自身 `STORE_VERSION` 结尾时原样使用，否则追加自己的版本段，传完整路径会在主版本不一致时拼出 `store/v10/v11` 这种嵌套路径。若本机没有任何 store 主版本匹配的 pnpm（pnpm 10↔11 布局互不兼容），`ensure_pnpm` 会删除该档案的 `node_modules/.modules.yaml`（`reset_incompatible_modules_metadata`；pnpm 只在该文件存在时做 `checkCompatibility`），让当前 pnpm 重建安装树，而不是明知必败仍发车。报错可见性由 `install/diagnose.rs::store_mismatch_hint` 兜底：pnpm 正文里的两条 store 路径都不含 `ERR_`/`error`/`failed` 标记，会被 `pick_error_message` 全部丢掉。
* **YAML 补丁层错误 (Issue #525)**：损坏的 `cordis.patch.yml` 会被隔离为 `<Name>.broken-<Timestamp>`。若隔离/重命名失败，程序将直接中止并返回 `PATCH_LAYER_QUARANTINE_FAILED`，要求用户手动处理。
* **补丁层悬空 insert 条目**：手写的 `insert` 条目在包被卸载（市场会拒绝卸载「仍被用户补丁引用」的插件，用户于是改走手工删依赖 / `pnpm remove`）或本地 `link:` 源被删后仍留在补丁层里，loader 会在 import 时抛 `ERR_MODULE_NOT_FOUND` 让**整棵插件树**加载失败——应用彻底起不来。`service::plugin::patch_entries` 在 spawn 前预检「顶层没有 `id` 的 insert」（这类必然挂载；带 `id` 的只在目标 group 存在时生效，不猜测），用 `PATCH_LAYER_ENTRY_UNRESOLVED` 报出「文件 / 行号 / 包名」，错误页据此给出「移除悬空条目」入口（只剥离解析不到的条目，原文件先备份为 `.bak-<Timestamp>`）。判定复用 loader 的解析规则（Node 的 `node_modules` 逐级向上 + dsh 安装树），宁可漏报也不误拦能起来的启动。
* **pnpm Workspace 多文档修复 (Issue #526)**：若 `pnpm-workspace.yaml` 被意外包含 `---` 多文档，解析器会自动尝试解析并合并为单文档落盘自愈（日志标记 `PROFILE_WORKSPACE_MULTI_DOCUMENT`）。
* **pnpm `link:` 回读失败兜底 (Issue #264)**：pnpm 建好内置插件目录链接后回读 `package.json` 可能**恒定**失败（libuv `UV_UNKNOWN` / 退出码 -4094，实时防护 / EDR / 云盘 / 重解析点过滤驱动所致），重试无法越过且会让启动永久卡在 Plugin installation 阶段；此时由桌面端自建链接并补齐清单（`service::plugin::internal::materialize`，日志标记 `INTERNAL_PLUGIN_OFFLINE_LINK_*`），**仅在诊断里的失败路径确属本轮待装入口时**才兜底（同一签名也可能来自用户自己的 `link:` 依赖，路径不可归因时只给排除项提示、绝不吞成成功）。该路径不写 `pnpm-lock.yaml` 的 importers 条目，由下一次 pnpm 操作补齐。
* **旧版 WebKit 缺失 Iterator 补丁 (Issue #539)**：在非 Windows 平台的 WebView 初始化时注入 `compat_iterator.js.inc` 垫片，补齐 ES2025 Iterator Helpers（在 `Object.getPrototypeOf(...)` 上挂载），防止旧 macOS WebKit 崩溃。
* **Windows `.cmd` shim 行尾 (Issue #581)**：`.gitattributes` 把 `.rs` 固定为 LF，生成的 `dsh.cmd`/`pnpm.cmd` 必须在返回前统一转 CRLF（`normalize_cmd_line_endings`），LF-only 会让部分环境下 cmd.exe 解析错位、内置插件安装全部失败。
* **本地核心低于内置插件基线 (Issue #596)**：内置插件在构建期按 catalog 的 dsh 版本编译，`scripts/build-plugins.ts` 会把整个 `@deepseek-ai` scope 从产物里删掉，client bundle 只能靠运行时模块表解析这些模块。核心低于该基线时模块表里根本没有它们（`@deepseek-ai/dsh-client-store` 首版为 dsh 0.1.2-alpha.2，0.1.5 起才是平台种子词），插件加载必然失败并把应用卡在启动阶段。`service::core::source::core_supports_bundled_plugins` 以 `version-recommend.json` 的推荐核心版本为基线（与 catalog 同源）：低于基线的本地核心不参与「本地优先」并回退预打包核心（日志标记 `CORE_LOCAL_UNSUPPORTED`），`set_active("local")` 同样拒绝；持久化的 `active_core` 不改写，用户升级本地核心后自动恢复。核心面板据此标注「不兼容」并给出更新提示。
* **macOS 媒体权限配置 (Issue #214)**：必须同时在 `Info.plist` (声明 Usage Description) 与 `Entitlements.plist` (声明 `com.apple.security.device.*`) 中配置，相对路径基于 tauri bundle 运行时的 CWD 目录。
* **Linux 托盘点击适配 (Issue #386/#438)**：Linux 环境下通过 `linux_tray.rs` 基于 `tray-icon 0.25 (ksni)` 单独构建托盘，避免 muda 依赖版本冲突，通过 `Box::leak` 保活并在独立线程中处理事件。