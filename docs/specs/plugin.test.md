> 该文档已被固定，禁止修改

# 插件测试协议

> **唯一权威规范**：自包含分层与归属、目录、运行命令、宿主编排与鉴权、驱动选型、选择器口径、错误语义、隔离红线及已知缺陷/缺口。
> 配套文档：[desktop.test.md](./desktop.test.md)（桌面端 L3 车道）；[testing.md](./testing.md)（测试评审标准：契约真实性、静默失败防范、确定性等）。
> **契约驱动原则**：测试不由「文档条目 ↔ `it()`」驱动，测试文件的 `it()` 标题即契约描述（见 §10）。

---

## 1. 定位与分层

内置插件包含两部分：`src/host/**` 运行于 `dsh web` 进程（Cordis 容器 + WebServer），`src/client/**` 运行于 WebView 页面（前端 Bundle Slot 注册表）。

| 层级 | 代码位置 | 运行方式 | 被测对象 |
| --- | --- | --- | --- |
| **L1 单元** | `packages/*/src/**/*.test.ts`<br>

<br>`test/**/*.test.ts` | Vitest `unit` project | 纯函数、路由 Handler、注册表契约（允许通过 `resolve.alias` 做依赖替身） |
| **L2 宿主** | `test/e2e/plugins/*.e2e.ts` | Vitest `plugin` project（`node` 环境） | 真实 `dsh web` 进程的 HTTP 字节：路由响应、状态码、错误体、挂载校验、崩溃防护 |
| **C 浏览器** | 同上（`plugin` project 内） | Playwright **库 API**（`chromium.launch()`） | 真实 Chromium 内的客户端挂载与 DOM 行为 |
| **L3 桌面** | `test/e2e/desktop/*.e2e.ts` | Vitest `desktop` project + WebdriverIO | 真实 Tauri 窗口（独立 OS 窗口句柄、几何尺寸、Tauri IPC 往返） |

### 分层核心原则

1. **全仓统一运行器**：仅使用 Vitest，通过 `test.projects` 实现分层；Playwright 与 WebdriverIO 仅作为**驱动库**引入。
2. **C 浏览器层归属**：保留在 `plugin` project 中，复用共享宿主、Cookie 与就绪状态，避免新增 project 重新执行 `globalSetup` 导致重复启动 `dsh web` 进程。
3. **L3 准入与限制（强制）**：
* **准入**：仅限 **Tauri 原生产物**（OS 窗口句柄出现/消失、窗口尺寸夹紧、Tauri IPC 往返）。
* **禁令**：业务面板、侧栏、Tab、对话框等 **dsh iframe 内部 DOM** 必须使用 C 浏览器层断言（内部 DOM 不经 Tauri 桥，写入 L3 会退化为仅在 Windows 跑的 DOM 测试）。详情见 [desktop.test.md](./desktop.test.md) §1。
* **职责界限**：壳层职责仅限「将 dsh 装载、运行、嵌入」；配置、语言、档案、插件生命周期等业务逻辑严禁建立 L3。

---

## 2. 目录与归属

```text
packages/<name>/src/**/*.test.ts   # L1 单元（源码同级）
test/**/*.test.ts                  # L1 单元（跨包/编排级）
test/e2e/
  setup-plugin.ts                  # plugin 层的 globalSetup：启动共享宿主，下发地址/Cookie/Home
  support/
    dsh.ts                    # 宿主环境脚手架：DSH_HOME 隔离、Profile 构造、挂载、启动、鉴权与回收
    browser.ts                     # C 浏览器层编排：Chromium 启动、同源 Frame 嵌入、Cookie 注入、报错收集
    onboarding.ts                  # 帧内阻塞引导弹层的可重入闸
    selectors.ts                   # 统一选择器常量（壳层 data-testid 等）
    preinstall.ts                  # 预装引导/首次装配（桌面车道复用）
  plugins/*.e2e.ts                 # L2 + C 层用例
  desktop/*.e2e.ts                 # L3 层用例
docs/specs/plugin.test.md          # 本规范文件
vitest.plugin.config.ts            # plugin project 配置

```

* **命名契约**：`*.e2e.ts` 为 E2E（L2/C/L3），`*.test.ts` 为 L1，严格区分。无独立文档台账层（废弃 `TC-*` 编号与 `[Case ID]` 字段）。
* **匹配策略**：
* `plugin` project: 匹配 `test/e2e/plugins/**/*.e2e.ts`
* `desktop` project: 匹配 `test/e2e/desktop/*.e2e.ts`
* `unit` project: 匹配 `packages/**/*.{test,spec}.*`、`test/**`、`src/**/*.test.ts`（自动排除 `.e2e.ts`）
* `test/archive/**`: 任何 project 均不匹配。

* **文件拆分**：允许同一插件拆分不同层级（如桌宠插件：L2/C 位于 `plugins/dsh-tauri-pet.e2e.ts`，L3 窗口用例位于 `desktop/pet.e2e.ts`；L3 里依赖「侧栏设置菜单入口」的两条已随入口迁到官方账号菜单删除，仅保留尺寸边界一条）。

---

## 3. 运行方式与驱动口径

### 3.1 执行命令

```bash
# 运行整条 plugin 车道
node node_modules/vitest/vitest.mjs run --project plugin

# 运行单文件（必须使用位置参数）
node node_modules/vitest/vitest.mjs run --project plugin test/e2e/plugins/dsh-tauri-pet.e2e.ts

```

* **禁用 `pnpm run <script>**`：绕过脚本直接调用 `node node_modules/vitest/vitest.mjs`，防止 pnpm shim 解析版本偏差。
* **显式传递 `run` 参数**：避免 Vitest 在非 CI 环境进入 watch 模式挂起。若通过 npm scripts 执行，需补充 `-- --run`。
* **单文件过滤**：必须通过位置参数传参。使用 `-- <file>` 会导致参数隔离，引发全车道误执行。
* **前置依赖**：L2/C 仅针对构建产物运行，需预先执行 `pnpm build:plugins`（构建工具包已排除）。缺失产物或环境未就绪时直接 Fail，禁止提供 skip 开关。
* **串行保证**：`vitest.plugin.config.ts` 设置 `fileParallelism: false`，保证单实例共享宿主串行执行。

### 3.2 驱动选型与定位口径

* **Playwright 库模式**：在 `plugin` project（`node` 环境）直接调用 `import { chromium } from 'playwright'`，复用 `globalSetup` 宿主与 Cookie。
* **禁止引入 Runner**：严禁使用 `@playwright/test` 或 `@vitest/browser`（后者会导致页面重定向至 Vitest 域，卸载被测应用）。
* **选择器分流口径**：见 §6。

### 3.3 稳定性指标

* 连续运行 **5 次零 Flake** 方可合并；禁用重跑掩盖偶发失败。
* 失败日志必须精确呈现「用例 - 步骤 - 期望值 vs 实际值」。
* 每次运行必须基于全新的 scratch 环境。

---

## 4. 宿主编排与鉴权

由 `test/e2e/support/dsh.ts` 提供底座，`test/e2e/setup-plugin.ts` 实例化全局单一共享宿主，通过 `project.provide()`（`inject()`）跨 Worker 下发参数。

```
[globalSetup]
  ├── 1. 检查构建产物 (packages/*/dist)
  ├── 2. 解析 dsh 入口路径 (DSH_E2E_DSH_BIN -> 依赖树 -> AppData 装配目录)
  ├── 3. 创建 Scratch DSH_HOME (<tmp>/dsh-e2e-<suite>-<timestamp>)
  ├── 4. 脚手架构造 Profiles (<DSH_HOME>/profiles/web/...)
  ├── 5. 挂载插件 (link 软链 或 cli 模式)
  ├── 6. 执行 assertMountRegistered 校验
  ├── 7. 启动进程 (dsh web --host 127.0.0.1 --port 0 --no-open)
  ├── 8. 交换会话 (GET /?token=<...> 换取 Set-Cookie，校验 303)
  └── 9. 下发配置 (project.provide -> dshBaseUrl, dshCookie, dshHome 等)

```

### 关键细节说明

* **入口解析**：查找优先级为 `DSH_E2E_DSH_BIN` → 仓库依赖树 → 桌面端装配目录。装配目录会匹配新旧两代标识符（`dsh-tauri` / `io.github.hairyf.deepseek-harness-desktop`）。
* **鉴权通道**：严格依赖根路径 `GET /?token=<...>` 响应 303 并提取 `Set-Cookie`（`Path=/; HttpOnly; SameSite=Strict`）。后续所有 `/api/**` 及插件路由必须带回该 Cookie。L2 严禁复用桌面端嵌入的绕过鉴权通道（`DSH_TAURI_EMBEDDED=1`）。
* **生命周期回收**：Teardown 时终止 dsh 进程树并清理临时目录（设置 `DSH_E2E_KEEP_HOME=1` 可保留现场）。

### 关键环境变量

| 环境变量 | 作用 | 默认值 / 回退策略 |
| --- | --- | --- |
| `DSH_E2E_HOME` | 本次运行独占的隔离根 | `<tmp>/dsh-e2e-<suite>-<timestamp>` |
| `DSH_E2E_DSH_BIN` | `dsh` 入口路径（`lib/bin.js`） | 依赖树 → 桌面端装配目录 |
| `DSH_E2E_NODE_BIN` | 执行 Node 二进制路径 | `process.execPath` |
| `DSH_E2E_PLUGIN` | 共享宿主默认挂载插件 | `dsh-tauri-pet` |
| `DSH_E2E_ALSO` | 附加挂载插件（逗号分隔） | 未设置 |
| `DSH_E2E_MOUNT` | 挂载模式 | `link`（可选 `cli`） |
| `DSH_E2E_KEEP_HOME` | 是否保留现场 | `0`（置 `1` 保留） |
| `DSH_E2E_DOWNLOAD_CACHE_DIR` | 桌面端装配下载缓存目录 | `<os.tmpdir()>/dsh-e2e-download-cache` |
| `DSH_E2E_COLD_ASSEMBLY` | 强制冷装配标志 | `0`（置 `1` 禁用缓存） |

---

## 5. 驱动与编排细节

* **同源 Frame 嵌入**：鉴于插件 Client 入口含有 `window.parent === window` 早退逻辑，C 浏览器用例需通过 `page.route` 拦截 `EMBEDDED_DOCUMENT_PATH`（`/dsh-e2e-embed.html`），注入仅含 dsh iframe 的同源极小文档进行断言。
* **可重入弹窗闸 (`OnboardingModal`)**：
* 应用首次加载会连续触发「内测声明」与「配置 API Key」弹窗，此弹窗将 `#root` 设为 `inert`，且无法通过点击遮罩或 Esc 关闭。
* **机制**：关闭状态**不落盘**，iframe 重建即复发。因此每次交互前**必须过闸**（采用结构选择器循环校验至无弹窗）。未过闸会导致真实点击被 `inert` 吞噬。


* **帧尺寸**：固定为 `APP_FRAME_VIEWPORT = 1400×900`，防止侧栏折叠为 Rail 态影响几何断言。

---

## 6. 选择器分流口径

| 元素归属 | 锚点规范 | 约束与说明 |
| --- | --- | --- |
| **插件包** (`packages/*`) | `data-dsh-*`<br>

<br>*(例: `[data-dsh-tauri-pet-menu-item]`)* | 插件渲染的挂载点。某些属性属于**行为钩子**（如 DOM 变更过滤），**严禁为测试擅改**。 |
| **壳层** (`src/**`) | `data-testid="dsh-<域>-<名称>"` | 全小写连字符，集中登记于 `test/e2e/support/selectors.ts`。 |
| **dsh 上游结构** | `data-slot` / `role` / 前缀类 (`dsh`/`dshp`) | 上游 DOM 结构，属于 C 浏览器层断言范畴。用例中需注释来源。 |
| **帧内阻塞弹层** | 结构与类名后缀组合 | 详见 §5，严禁依赖文本内容。 |

* **红线禁止**：禁止使用不稳定文案、任意 CSS 类名或相对 DOM 层级；禁止将「无报错」作为唯一正向断言。
* **已知例外**：`div[class*="_editorActions"] > button`（引导弹窗「稍后配置」按钮）因缺少 `data-*` 锚点且文案含多语言，特许使用类名后缀定位。

---

## 7. 错误语义与质量红线

1. **绝对禁止静默跳过**：环境不满足直接 Fail，严禁使用 `skipIf` 掩盖问题。
2. **严禁弱化断言**：禁止删除断言或修改预期值来强制通过测试。
3. **消除假绿断言**：严禁 `expect(x).toBe(x)`、仅断言元素存在而不验契约、或仅以无报错作为通过标准。
4. **外部依赖解耦**：涉及系统程序（文件管理器、浏览器）或公网/模型的场景，需通过本地数据（自种缓存、配置文件）解耦后再实施自动化；无法解耦的保持手工测试。
5. **错误采集白名单**：C 浏览器层拦截 `pageerror` 及 `console.error`。当前仅允许过滤纯浏览器环境下的 Tauri 桥缺失报错（`NODE_NOT_ANSWERED` / `invoke` / `__TAURI` / `Failed to fetch`）。新增过滤项须逐条说明理由。

---

## 8. 隔离红线

* **数据隔离**：严禁读写用户真实的 `~/.dsh`、`~/.dsh.dev` 及 `.store[.dev].dat` 文件。所有 L2 写操作必须约束在 `DSH_E2E_HOME` 内。
* **副作用限制**：不得擅自拉起系统程序；对外打开断言仅校验请求侧行为。
* **进程安全**：禁止强杀用户进程。若遇端口或进程残留，测试直接 Fail。
* **环境清理**：临时目录由 Teardown 自动清理；若删除被阻碍，允许快速重试后留待下一次运行清理，严禁阻塞测试流程。

---
