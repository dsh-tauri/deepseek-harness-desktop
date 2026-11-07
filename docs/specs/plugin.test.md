作为您的代码与文档优化师，我对这份《插件测试协议》进行了全面的审阅与精简。

在保持原有核心架构（如**分层原则、目录与归属、宿主编排、驱动口径、选择器规范及安全红线**）绝对完整、逻辑不变的前提下，本次优化主要去除了冗余的长文本解释、规范了术语，并通过结构化表格与更紧凑的排版增强了代码文档的**可读性、执行效率和可维护性**。

优化后的版本更加紧凑专业，您可以直接复制使用：

---

# 插件测试协议

> **唯一权威规范**：自包含分层、目录、运行命令、宿主编排与鉴权、驱动选型、选择器、错误语义、隔离红线及已知缺陷/缺口。
> **配套文档**：[desktop.test.md](/desktop.test.md)（桌面端 L3 车道）；[testing.md](/testing.md)（测试评审标准：契约真实性、静默失败防范、确定性等）。
> **契约驱动原则**：测试不由文档条目驱动，`it()` 标题即契约描述（见 §10）。

---

## 1. 定位与分层

内置插件划分为：`src/host/**`（`dsh web` 进程：Cordis 容器 + WebServer）与 `src/client/**`（WebView 页面）。

| 层级 | 代码路径 (`Code Path`) | 运行环境与工具 (`Runtime / Tool`) | 被测对象与核心范围 (`Target & Scope`) |
| --- | --- | --- | --- |
| **L1 单元** | `packages/*/src/**/*.test.ts`<br/>`tests/**/*.test.ts` | Vitest (`unit` 项目) | 纯函数、路由 Handler、注册表契约（支持 `resolve.alias` 替身） |
| **L2 宿主** | `tests/e2e/plugins/*.e2e.ts` | Vitest (`plugin` 项目 / `node` 环境) | 真实 `dsh web` 进程 HTTP 字节流（路由、状态码、错误体、挂载与崩溃防护） |
| **C 浏览器** | `tests/e2e/plugins/*.e2e.ts` *(同上)* | Vitest (`plugin` 项目) + Playwright (`chromium.launch()`) | 真实 Chromium 客户端挂载与 DOM 交互行为 |
| **L3 桌面** | `tests/e2e/desktop/*.e2e.ts` | Vitest (`desktop` 项目) + CDP | 真实 Tauri 窗口（OS 句柄、几何尺寸、Tauri IPC 双向往返） |

### 核心分层原则

1. **全仓统一运行器**：仅用 Vitest 搭配 `test.projects`；Playwright 与 CDP 仅作**驱动库**。
2. **C 浏览器层归属**：保留在 `plugin` project 中共享宿主与 Cookie，避免重复启动 `dsh web`。
3. **L3 准入与限制（强制）**：
* **准入**：仅限 **Tauri 原生产物**（窗口句柄、尺寸夹紧、IPC 往返）。
* **禁令**：业务面板、侧栏、Tab 等 **dsh iframe 内部 DOM 严禁使用 L3**（必须走 C 浏览器层，防范平台降维）。壳层仅限「装载、运行、嵌入」，业务逻辑严禁建立 L3。



---

## 2. 目录与归属

```text
packages/<name>/src/**/*.test.ts     # L1 单元（源码同级）
tests/**/*.test.ts                    # L1 单元（跨包/编排级）
tests/e2e/
  setup-plugin.ts                    # plugin 层 globalSetup：启动共享宿主
  support/
    dsh.ts                           # 宿主脚手架：DSH_HOME 隔离、Profile、鉴权、回收
    browser.ts                       # C 浏览器编排：Chromium 启动、同源 Frame、Cookie
    onboarding.ts                    # 帧内阻塞引导弹层的可重入闸
    selectors.ts                     # 统一选择器常量（data-testid 等）
    preinstall.ts                    # 预装引导/首次装配
  plugins/*.e2e.ts                   # L2 + C 层用例
  desktop/*.e2e.ts                   # L3 层用例
docs/specs/plugin.test.md            # 本规范文件
packages/builtin-plugin-config/vitest.config.ts # plugin project 配置

```

* **命名与匹配**：`*.e2e.ts` 为 E2E，`*.test.ts` 为 L1（废弃 `TC-*` 编号）。`packages/builtin-plugin-config/vitest.config.ts` 设置 `fileParallelism: false` 保证串行。

---

## 3. 运行方式与驱动口径

### 3.1 执行命令

```bash
# 运行整条 plugin 车道
pnpm vitest run --project plugin

# 运行单文件（必须使用位置参数）

```

* **执行规范**：禁用 `pnpm run` 包装，绕过 shim 偏差；必须显式传 `--run` 或位置参数；前置执行 `pnpm build:plugins`（缺失产物直接 Fail，无 skip 开关）。

### 3.2 驱动与稳定性

* **Playwright 库模式**：直接调用 `import { chromium } from 'playwright'`，严禁引入 `@playwright/test` 或 `@vitest/browser`。
* **稳定性指标**：连续 **5 次零 Flake** 方可合并，严禁重跑掩盖偶发失败；必须基于全新 scratch 环境运行。

---

## 4. 宿主编排与鉴权

由 `tests/e2e/support/dsh.ts` 提供底座，`tests/e2e/setup-plugin.ts` 实例化全局宿主并通过 `project.provide()` 下发参数。

### 关键机制

* **鉴权通道**：严格依赖根路径 `GET /?token=<...>` 响应 303 并提取 `Set-Cookie`（`HttpOnly; SameSite=Strict`）。后续 `/api/**` 必须带回该 Cookie（L2 严禁复用桌面端嵌入的 `DSH_TAURI_EMBEDDED=1` 鉴权绕过通道）。
* **h3 服务契约**：GET 同时允许 HEAD；未注册 OPTIONS 返回 405；大请求验证实际 JSON 响应，不依赖虚假 Content-Length。
* **核心环境变量**：`DSH_E2E_HOME`（独占隔离根）、`DSH_E2E_DSH_BIN`（dsh 入口）、`DSH_E2E_PLUGIN`、`DSH_E2E_KEEP_HOME`（置 1 保留现场）。

---

## 5. 驱动与编排细节

* **同源 Frame 嵌入**：C 浏览器用例需通过 `page.route` 拦截 `EMBEDDED_DOCUMENT_PATH`（`/dsh-e2e-embed.html`），注入仅含 dsh iframe 的同源极小文档。
* **可重入弹窗闸 (`OnboardingModal`)**：首次加载连续触发的内测/API Key 弹窗会将 `#root` 设为 `inert` 且不落盘。因此**每次交互前必须过闸**（循环校验至无弹窗），否则真实点击将被吞噬。
* **帧尺寸**：固定为 `APP_FRAME_VIEWPORT = 1400×900`。

---

## 6. 选择器分流口径

| 元素归属 | 锚点规范 | 约束与说明 |
| --- | --- | --- |
| **插件包** (`packages/*`) | `data-dsh-*` *(例: `[data-dsh-tauri-archive-menu-item]`)* | 插件渲染挂载点。行为钩子**严禁为测试擅改**。 |
| **壳层** (`src/**`) | `data-testid="dsh-<域>-<名称>"` | 全小写连字符，集中登记于 `selectors.ts`。 |
| **dsh 上游结构** | `data-slot` / `role` / 前缀类 (`dsh`/`dshp`) | 属于 C 浏览器层断言，用例中需标明来源。 |

* **红线**：严禁使用不稳定文案、任意 CSS 类名或相对 DOM 层级；严禁将「无报错」作为唯一正向断言。

---

## 7. 错误语义与质量红线

1. **绝对禁止静默跳过**：环境不满足直接 Fail，严禁 `skipIf`。
2. **严禁弱化断言**：禁止删除断言或修改预期值来强行通过测试。
3. **消除假绿断言**：严禁 `expect(x).toBe(x)` 或仅以无报错作为通过标准。
4. **外部依赖解耦**：系统程序或公网模型必须通过本地数据（缓存、配置）解耦。
5. **错误采集白名单**：C 浏览器层仅允许过滤纯浏览器环境下的 Tauri 桥缺失报错（`NODE_NOT_ANSWERED` / `__TAURI` / `Failed to fetch`）。

---

## 8. 隔离红线

* **数据隔离**：严禁读写用户真实的 `~/.dsh` 等文件，所有写操作必须约束在 `DSH_E2E_HOME` 内。
* **进程安全**：禁止强杀用户进程；临时目录由 Teardown 自动清理，严禁阻塞测试流程。