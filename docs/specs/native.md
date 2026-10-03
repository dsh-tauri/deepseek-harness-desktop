# DeepSeek Harness 移动端（DSH Bridge）规范

> **定位**：移动端是与桌面端同仓维护的 Expo / React Native 子工程，用于在局域网内发现 DSH 主机并以全屏 WebView 承载 Harness 网页。它不替代桌面端，只在**官方未推出移动端服务期间**维护。
> **根目录**：`src-native/` 为源码根；Expo / Metro / 类型 / 测试配置位于仓库根目录，与桌面端（`src/`、`src-tauri/`）共用同一 `package.json`。

---

## 1. 技术栈与常用命令 (Tech Stack & Commands)

* **运行时**：Expo SDK 57 / React Native 0.86.3 / React 19
* **路由**：`expo-router`（文件路由，根为 `src-native/app`）
* **UI**：HeroUI Native（`heroui-native`）+ Uniwind（Tailwind 语法，CSS 入口 `src-native/global.css`）
* **状态**：`valtio-define`（客户端状态）+ `@tanstack/react-query`（服务端状态，见 §5）
* **开发命令**：
```bash
pnpm install            # 仓库根安装（移动端依赖使用 catalog:native）

pnpm dev:native         # expo start --dev-client
pnpm android            # expo run:android（需本地 Android SDK / JDK 17）
pnpm build:native       # expo export --platform android --output-dir .temp/native-android-export
pnpm prebuild:native    # expo prebuild --platform android --no-install
pnpm test:native        # vitest run --config vitest.native.config.ts
pnpm typecheck:native   # tsc --project tsconfig.native.json --noEmit
```

* 路径别名 `@/*` 指向 `src-native/*`，同时配置于 `tsconfig.native.json` 与 `vitest.native.config.ts`，并由 `metro.config.js` 自定义解析器兜底（见 §2）。
* `pnpm build:native` 只导出 Android JS / Hermes bundle（产物在 `.temp/native-android-export`），`pnpm prebuild:native` 只生成原生工程（`android/`），二者都**不**产出 APK。

---

## 2. 配置文件与路径映射 (Config & Path Mapping)

| 文件 | 作用 |
| --- | --- |
| `app.json` | Expo 静态配置：应用名 `DSH Bridge`、slug `dsh-bridge`、`expo.version`、Android 包名 `com.dshtauri.dshbridge`、`versionCode`、plugins、权限 |
| `app.config.js` | Expo 动态配置（ESM）：把 `THIRD_PARTY_NOTICES.md` 全文注入 `extra.thirdPartyNotices` |
| `metro.config.js` | Metro 配置：`expo/metro-config.js` 全扩展名导入、`withUniwindConfig` 接入 CSS 入口、自定义 `resolver.resolveRequest` 钉住 `@/x`、`blockList` 屏蔽 `src-tauri` / `source` / `dist` 等大目录 |
| `src-native/entry.ts` | 移动端应用入口（只 `import 'expo-router/entry'`），由 `package.json` 的 `"main"` 指向 |
| `tsconfig.native.json` | 移动端类型检查工程，`extends: expo/tsconfig.base`，开启 `strict` 与 `noUncheckedIndexedAccess` |
| `vitest.native.config.ts` | 移动端测试工程，`include: ['src-native/**/*.test.{ts,tsx}']`，`environment: 'node'` |
| `assets/native/` | 图标、自适应图标、启动图与通知图标（`icon.png` / `adaptive-icon.png` / `splash-icon.png` / `notification-icon.png`） |

* **路由根不是默认的 `src/app`**，由 `app.json` 的 `plugins` 显式指定：
```json
["expo-router", { "root": "src-native/app" }]
```
* `package.json` 的 `"main"` 是 `./src-native/entry.ts`（**不是** `expo-router/entry`）：pnpm 符号链接下 Expo 会把入口解析成 `node_modules/expo-router/entry` 这类工程内相对路径，Metro 解析不到；改用工程内真实文件，再由它按包名引入官方 entry。scheme 为 `dshbridge`。
* `metro.config.js` 必须写完整的 `expo/metro-config.js`：仓库根 `package.json` 是 `"type": "module"`，Node 的 ESM 解析不做扩展名补齐，而 `expo` 包没有 `exports` 字段。
* 工程根 `tsconfig.json` 是桌面端配置（`"@/*": ["src/*"]`），而 Expo CLI 的 tsconfig paths 解析器读的正是工程根 tsconfig ⇒ native 的 `@/x` 会被错误解析到 `src/x`（同名模块还会静默串味）。因此 `metro.config.js` 在用户解析器里先行短路，把 `@/x` 钉到 `src-native/x`，与 `tsconfig.native.json` 的 paths 一致。
* `app.json` 的 `expo.version` **跟随桌面端版本**，Android `versionCode` 与之同步递增（由 §8.4 的 bumpp 补丁写入）。
* `experiments` 开启 `typedRoutes` 与 `reactCompiler`，因此移动端同样**禁止**手写 `useCallback` / `useMemo`。

---

## 3. 目录结构 (Directory Layout)

```
src-native/
├── app/          # expo-router 路由：_layout.tsx / index.tsx / scan.tsx
├── apis/         # HTTP 访问层：getAuthStatus / getManifest
├── components/   # 品牌与装饰组件（鲸鱼、字标、状态点、脉冲动画等）
├── config/       # 常量、React Query client 与 query key
├── hooks/        # 原生能力封装（通知、应用状态、主机健康轮询）
├── i18n/         # i18next 实例、语言检测与静态语言资源
├── services/     # 主机探测（probe-bridge）与候选扫描（scan-candidates）
├── store/        # valtio-define 状态模块（modules/connection）
├── styles/       # 主题变量（variables.css）
├── test/         # 配置级测试
├── ui/           # 页面级视图与 WebView 容器
├── utils/        # 协议解析、候选生成、WebView 桥接、通知策略
├── entry.ts      # 应用入口（见 §2）
├── env.d.ts      # Expo / Uniwind 类型入口
└── global.css    # Uniwind 样式入口
```

* 路由测试与生产路由分离：路由级测试放在 `src-native/ui/`，不写进 `src-native/app/`，避免 Expo Router 把测试文件当作路由。

### 3.1 i18n

* `i18next` + `react-i18next` + `expo-localization`；`src-native/i18n/index.ts` 导出与应用同寿的 `i18n` 实例，非 React 模块（store、通知处理器）直接 `i18n.t('connection.xxx')`。
* 语言资源静态打包进 bundle：`src-native/i18n/locales/zh-CN.json` 与 `en-US.json`，扁平 dot-notation key，并关闭 `keySeparator` / `nsSeparator`（与桌面端 `src/i18n` 约定一致）；`initAsync: false` 保证模块作用域内 `i18n.t` 立即可用。
* `src-native/i18n/index.detector.ts` 是**同步**语言检测：`getLocales()[0].languageTag` 前缀 `zh` → `zh-CN`，否则 `en-US`。
* **不持久化语言、没有语言切换入口**：语言唯一来源是设备区域设置。
* 文案禁止硬编码在组件里，key 同步维护两个 locale 文件。

### 3.2 apis

* `src-native/apis/index.types.ts` 是宿主 HTTP 契约的类型 SSOT（`AuthStatus`、`BridgeManifest`、路径参数类型）。
* `src-native/apis/index.ts` 提供 `getAuthStatus` / `getManifest`：内部 `fetch` + 校验，非 2xx、响应体不合法或校验失败一律返回 `null`（含义是「这个 origin 不是 DSH Bridge 宿主」）。
* `src-native/utils/bridge-protocol.ts` 以 **type-only** 方式引用这些类型，避免协议工具与访问层耦合。

---

## 4. 启动与连接流程 (Startup & Connection)

* **首次进入**（无成功连接历史）：只展示连接方式选择——「自动扫描局域网」「扫码连接」「最近连接」，**不**自动连接、**不**隐式扫描。
* **再次进入**（历史中有主机）：只探测历史主机并自动连接可用项，检测期文案为「寻找可用连接」；全部不可用时停在连接方式选择，**不**退化为局域网扫描。
* **主动发现**由用户操作触发：点击「自动扫描局域网」，或断开连接后紧接的那轮扫描。
* 探测成功由可信 DSH 文档就绪消息确认，不以原生 `onLoad` 或 HTTP 200 判定。
* 超时与预算集中在 `src-native/config/constants.ts`：默认端口 `3082` / `3080`、并发 40、单次探测 600 ms、历史探测 3 s、整体扫描预算 20 s、前台健康检查间隔 15 s。
* 服务识别走上游公开的 `/__dsh_bridge__/auth-status`，旧响应缺少身份字段时再校验 `/manifest.webmanifest`；不把任意 HTML 200 当作 DSH 服务。
* 探测与扫描拆成两个模块：`src-native/services/probe-bridge.ts` 的 `probeBridge(address, signal, timeoutMs?)` 探测单个地址（超时、网络错误、非 2xx、响应体不合法一律返回 `null`），`src-native/services/scan-candidates.ts` 的 `scanCandidates(candidates, { signal, concurrency, timeoutMs, budgetMs, onFound })` 以有界并发遍历候选地址并受总预算约束（参数非法直接抛 `RangeError`）。
* 断开会清空当前连接并保留历史，紧接着的扫描跳过刚断开的精确 origin。

---

## 5. 持久化与凭据 (State & Credentials)

* **连接元数据**：valtio-define 持久化插件 + `@react-native-async-storage/async-storage`，存储键 `dsh-bridge/connections`，保存版本化快照（历史记录、引导标记等）。
* **访问令牌**：**只**存 `expo-secure-store`，按 origin 派生的键名逐条保存；AsyncStorage 中不出现令牌。
* 快照解析失败、令牌读写失败或存储不可用时，不静默丢弃：降级为空历史并给出「无法读取或保存连接记录」提示。
* 历史最多保留 20 条，抽屉只展示最近 5 条；未被保留的 origin 对应令牌会被删除。

### 5.1 状态分层

* **客户端状态**：`valtio-define` 单例 store，`src-native/store/modules/connection/index.ts` 只导出唯一实例 `connection`（**没有** `createConnectionStore()` 工厂）。
* **服务端状态**：`@tanstack/react-query`。`src-native/config/client.ts` 建 `queryClient`（`queries: { retry: false }`——局域网直连没有瞬时抖动的重试价值），并用 `focusManager.setEventListener` 把 RN `AppState` 接到查询焦点：退到后台即失焦，配合 `refetchIntervalInBackground: false` 暂停轮询，回前台立即重取活跃查询。`src-native/config/query-keys.ts` 注册 key（`hostsHealth: ['hosts_health']`，与桌面端 `src/config/query-keys.ts` 同为单元素 snake_case 数组）。
* `src-native/hooks/use-hosts-health.ts` 用 `useQuery({ queryKey: queryKeys.hostsHealth, enabled: hydrated, refetchInterval: HEALTH_INTERVAL_MS, refetchIntervalInBackground: false })` 轮询已保存主机；查询函数显式返回 `null`（React Query 对 `undefined` 结果告警），手动刷新按钮仍直接调用 `refreshHealth()`。
* `@reause/core` 只承担副作用 / DOM 类逻辑，例如 `src-native/ui/webview.tsx` 用 `useWhenever(documentReady && !state.loadError && appState === 'active', …)` 触发通知授权。

### 5.2 持久化实现

* 连接元数据由 `valtio-define/plugins/persist` 落盘：`src-native/store/modules/connection/index.ts` 内的 `connectionStorage` 适配 `@react-native-async-storage/async-storage`；store 上声明 `persist: { key: 'dsh-bridge/connections', storage: connectionStorage, paths: ['version', 'history', 'guidedHosts'] }`，文件末尾 `connection.use(persist({ hydrate: false }))` 关闭自动水合，改由 `restoreConnections()` 手动 `$persist.rehydrate()`（保证「令牌读完」才算恢复完成）。
* 磁盘载荷与迁移前**逐字节兼容**：`{ version: 1, history, guidedHosts }`。适配器在读写两侧都做归一化（版本校验、按 id 去重取最新、按历史上限截断），并做**负载去重**：`persistedPayload` 记录最近一次已知落盘内容，载荷不变就不写盘——插件会在**每次** state 变更后调用 `setItem`，瞬时 UI 状态（notice / drawerOpen / health）不应产生写盘。
* 令牌与快照解耦：`src-native/store/modules/connection/storage.ts` 的 `restoreConnections()` = `$persist.rehydrate()` → 逐条按 origin 派生键读 SecureStore → `markHydrated(tokens)`；`bindConnectionPersistence()` 只订阅 state 同步令牌（新增写、未被保留的删，串行队列 + 按 payload 去重）。

---

## 6. 网络与安全边界 (Network & Security)

* 局域网 HTTP 通过 `expo-build-properties` 的 `usesCleartextTraffic: true` 支持；HTTP 不提供传输保密性，仅用于可信局域网，公网优先 HTTPS。
* 自动发现基于当前 IPv4 推导 `/24` 网段，不保证跨网段、VPN、访客 Wi-Fi 隔离或非默认端口；此时改用桌面端 / Bridge 生成的二维码，或在 `EXTRA_SCAN_PORTS` 追加端口。
* 通知与 WebView 消息入口校验类型白名单、精确 scheme / host / port origin、原生事件 URL 与每个 WebView 的随机 nonce；外站顶层链接交由外部浏览器打开。
* 密码登录保留在 WebView 内由 cookie jar 管理，**不**通过 RN `fetch` 登录。
* 上游没有独立的远程推送端点：系统挂起、进程被杀或关闭 App 后**不保证**继续收到新任务通知。

---

## 7. 测试与类型检查 (Tests & Typecheck)

| 检查 | 命令 |
| --- | --- |
| 单元测试 | `pnpm test:native` |
| 类型检查 | `pnpm typecheck:native` |
| Android bundle 导出 | `pnpm build:native` |
| Android 原生工程生成 | `pnpm prebuild:native` |

* 移动端测试使用独立 Vitest 工程（`vitest.native.config.ts`），不进入桌面端的 `unit` / `plugin` / `desktop` project。
* store 是**进程级单例**，因此测试必须显式复位共享状态（顺序固定）：`connection.$persist.meta.hydrated = false` → `connection.$persist.meta.mounted = false` → `connection.$patch(createConnectionState())` → `resetConnectionStorageCache()` → `vi.clearAllMocks()`。其中 `createConnectionState()` 供 `$patch` 复位，`resetConnectionStorageCache()` 只复位适配器的去重缓存（`keep:test`，生产不得调用）。
* 任何 import store 或 i18n 的用例都要 mock `expo-localization`（node 环境下真实 import 会崩在 `expo-modules-core`）与 `@react-native-async-storage/async-storage`；断言用 `i18n.t('key')` 而不是硬编码文案。
* 测试数量、变异测试、bundle 校验值与真机验收结论记录在迁移前的验证记录中，**不作为当前事实引用**；本轮迁移后的结果见源码与 CI。
* `expo export` / `expo prebuild` 成功**不等同于** APK 或真机验收。
* CNG（Continuous Native Generation）模式下 `android/`、`ios/`、`.expo/` 不入库。

---

## 8. Android 构建与发版 (Android Build & Release)

### 8.1 三个 workflow

| Workflow | `name` | 触发 | 职责 |
| --- | --- | --- | --- |
| `.github/workflows/release-native.yml` | `Release Android APK (Native)` | 桌面端 `Build & Release` 完成（`workflow_run`）+ 手动 `workflow_dispatch`（输入 `tag`） | prepare → build → publish：构建 release APK，并把资产上传到**已存在的**GitHub Release |
| `.github/workflows/build-android.yml` | `Android Native Build` | push `main`（按 `src-native/**`、`app.json`、`package.json` 等 paths 过滤）+ 手动 | 常规构建，只上传 Actions artifact `android-apk-${VERSION}`（retention 14），**不碰**Release |
| `.github/workflows/build-android-test.yml` | `Build Android Test` | 仅手动 `workflow_dispatch` | 校验 native 工程能真编译，只出 debug APK，artifact `android-apk-debug`（retention 7） |

* **发版只由桌面端 Release 驱动**：`release-native.yml` 只执行 `gh release upload --clobber`，**从不** create / edit Release——`release.yml` 的 finalize 是 Release 的单一 writer。该 workflow 只保留 `types: [completed]`，并在 job 级校验 `conclusion == 'success'` 与「触发运行来自本仓库」。
* `build-android-test.yml` **不跟随 CI 自动触发**（与 build-test.yml 同样只保留 `workflow_dispatch`），避免 Android SDK / NDK / Gradle 全量编译挤占 PR 队列；需要验证 native 可编译时手动触发即可。
* `build-android-test.yml` 的 debug APK 不依赖任何签名 secret；debug 产物只做基础对齐与签名校验，16 KB 页对齐（`zipalign -P 16`）只在正式产物上强制。

### 8.2 版本与资产名

* 三个 workflow 都从 `app.json` 的 `expo.version` 读取版本，并断言它等于 `package.json` 的 `version`，不一致直接 `::error::` 失败。
* 资产名模板 `Deepseek.Harness.Android_<version>.apk`；debug 校验构建为 `Deepseek.Harness.Android_<version>_debug.apk`。版本跟随桌面端（见 §8.4）。
* 发布资产同时包含 `SHA256SUMS.txt` 与 `THIRD_PARTY_NOTICES.md`；`app.config.js` 注入的声明会在签名校验步骤里与仓库内文件比对，缺全文即失败。
* **只有提交了 `app.json` 的 tag 才能发版**：prepare 用 `git cat-file -e "${tag_commit}:app.json"` 守卫，早于本次迁移、不含 `app.json` 的历史 tag（如 `v0.21.0`）会被正确跳过；手动指定 tag 时用 `::error::`，`workflow_run` 触发时用 `::warning::` 跳过。
* 手动触发要求 dispatch 的 ref 就是 tag 指向的提交；`release.yml` 的手动试跑（`test-<ref>-<run>` 预发布）不指向其构建提交，因此不会触发 Android 发版。

### 8.3 签名 secrets

* 需要 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`（与迁移前的移动端仓库同名）。
* **四项全有** → 用正式 key 重新签名；**四项全无** → 使用 Android 开发证书，并在日志与 Step Summary 里 `::warning::` 提示（不改变 Release 的 draft / prerelease 状态，那是 `release.yml` finalize 的职责）；**部分配置** → `::error::` 并失败。
* 当前仓库**尚未**添加这四个 secret。

### 8.4 构建环境与其它约定

* 远端构建环境：JDK 17 + Android SDK（`android-36` / `build-tools 36.0.0` / NDK / CMake）；`pnpm run prebuild:native` 生成原生工程后由 Gradle 编译，无需本地安装 SDK。
* `app.json` 被列入 `bump.config.ts` 的 `files`，由 `patches/bumpp.patch` 增补的 `app.json` 分支在 bump 流程中同步：写入 `expo.version`，并把 `expo.android.versionCode` 递增 1（Android 要求 versionCode 严格递增），因此 `app.json` 会和 `package.json` 一起进入 release commit，不需要 `execute` 脚本或 `all`。
* 本仓库根依赖由共享 catalog 固定，`react` / `react-dom` / `typescript` 与 Expo 57 期望版本不一致，`expo install --check` 在本机与 CI 上必然非零退出，因此**不**把它当门禁；原生兼容性以 `prebuild` + Gradle 编译为准。
* **iOS 尚未发布**，`bundleIdentifier` 已配置为 `com.dshtauri.dshbridge`，但无构建与发布流程。

---

## 9. 与桌面端的关系 (Relationship to Desktop)

* 移动端是**只读承载 + 连接管理**层：UI 主体仍是桌面端提供的 Harness 网页，移动端负责发现、鉴权、WebView 容器与原生通知。
* 桌面端与移动端各自独立构建：移动端改动不进入 `pnpm build` / `tauri build`，桌面端改动也不进入 `pnpm build:native`。
* 两者共享仓库根 `package.json` 与依赖 catalog（移动端依赖集中在 `catalog:native`），因此依赖升级需同时确认两端可构建。
