> 该文档已被固定，禁止修改

# 桌面端测试协议（L3）

> **权威来源**：本文件自包含 L3 准入原则、环境配置、隔离策略、驱动规范、断言要求及已知踩坑点。
> **配套文档**：[plugin.test.md](/plugin.test.md)（插件 L1/L2/C 浏览器层）；[testing.md](/testing.md)（测试评审标准）。

---

## 1. 定位与 L3 准入原则

### 核心定位

L3 车道仅验证：**壳层是否将 dsh 正确装配、启动并嵌入**。

### 准入与分层判据（强制机检）

* **允许进入 L3**：断言对象必须是 **Tauri 原生产物**。
* OS 独立窗口句柄（创建/销毁）；
* 窗口几何属性与尺寸限制；
* Tauri IPC 通信。

* **禁止进入 L3（归属 C 浏览器层）**：
* 嵌入在 dsh iframe 内的 DOM（业务面板、侧栏、Tab、对话框等），统一使用 Playwright 库 API 断言；
* 配置、语言、档案、插件生命周期、更新等非壳层职责的业务行为。

### 当前车道用例（2 文件 / 2 条）

| 文件 | 说明 |
| --- | --- |
| `test/e2e/desktop/boot.e2e.ts` | **启动冒烟**：显式冷装配 → 触发真实下载落盘 → 内核启动 → 页面无报错 |
| `test/e2e/desktop/pet.e2e.ts` | **桌宠尺寸边界（1条）**：范围内接受 / 越界拒绝且不改状态（原「侧栏入口联动」两条随入口迁到官方账号菜单删除） |

---

## 2. 平台与环境前置

| 维度 | 规范与约定 |
| --- | --- |
| **车道入口** | `test/e2e/setup-desktop.ts` 是本 project 的 `globalSetup`（`vitest.desktop.config.ts` 的 `globalSetup`）：整条车道只跑一次——清理上一轮遗留的 scratch 根，并校验 debug 二进制存在、WebDriver 与 debug 端口空闲，让「端口被占 / 二进制缺失」在车道开始前一次性报错，而不是每个用例文件各报一次。应用实例仍由各用例文件自己 `startDesktopApp()` 起（`fileParallelism: false` 保证串行、一次一个实例）。 |
| **平台** | **Windows 优先**（WebView2 + 内嵌 W3C WebDriver）。CI 作业 `desktop-e2e` (windows-latest) 为 PR 必过门禁。 |
| **构建与二进制** | 执行 `pnpm build:debug`；产物为 `src-tauri/target/debug/deepseek-harness-desktop.exe`，**缺失即 Fail**，不在测试中重新构建。 |
| **前端产物** | `dist/` 缺失将导致应用回退至 `devUrl` 且页面为空。 |
| **端口策略** | **应用端口**：默认 3081（release 3080），被占用时自动递增；<br>

<br>**WebDriver 端口** (`TAURI_WEBDRIVER_PORT`)：默认 4445（整机唯一），仅设置该变量时启动内嵌服务。 |
| **多实例并存** | 本机已存在实例时，指定 `TAURI_WEBDRIVER_PORT=<空闲端口>` 启动，**严禁杀用户进程**。 |
| **残留与目录** | 同路径存在残留进程即 Fail。必须预先创建 `<home>/AppData/Local` 和 `Roaming` 目录，否则触发 Rust panic (exit 101)。 |
| **环境与网络** | 避免在前台终端执行（防止抢焦点导致窗口激活断言假失败）。默认允许联网（冷装配依赖下载）。 |

---

## 3. 测试隔离

* **环境根重定向**：重定向 `USERPROFILE` (Win) / `HOME` (Unix) 到 `<E2E_HOME>/home`，实现 dsh 数据与 AppData 同步隔离。
* *注意*：Debug 模式下 `get_dsh_data_path` 强制指向 `<home>/.dsh.dev` 且忽略 `DSH_HOME`，切勿依赖 `DSH_HOME` 做隔离。

* **App Data 路径**：`<home>\AppData\Roaming\dsh-tauri`（旧标识符仅在 release 下自动迁移，debug/E2E 禁用迁移）。
* **Store 隔离**：设置 `TAURI_WEBDRIVER_PORT` 时进入 E2E 模式，自动使用 `.store.test.dat`（隔离生产/开发配置）。启动前须调用 `resetTestStore()` 清理旧状态。
* **WebView2 隔离**：必须设置 `DSH_E2E_WEBVIEW_DATA_DIR` 指向 `<home>/webview2`，防止与开发会话的 `EBWebView-dev` 相互污染。
* **下载缓存**：
* **默认共享**：`$DSH_E2E_DOWNLOAD_CACHE_DIR`（默认 `<os.tmpdir()>/dsh-e2e-download-cache`）；
* **冷装配（测试真实下载）**：设置 `coldCache: true`，使用独占目录 `<home>/download-cache`。

* **生命周期清理**：测试结束平滑关闭应用、销毁 Session (`DELETE /session/<id>`)、清理遗留进程及临时目录。
* **禁止行为**：严禁读写真实 `~/.dsh`，严禁修改真实档案数据，严禁杀用户进程。

---

## 4. 驱动与运行机制

```
Vitest (Node 环境) ──> WebdriverIO (Standalone) ──> @wdio/tauri-service (embedded) ──> 内嵌 WebDriver Server
```

* **驱动组合**：`webdriverio` + `@wdio/tauri-service` (`driverProvider: 'embedded'`) + Rust 侧补丁插件 `tauri-plugin-wdio-webdriver`。
* **运行器集成**：采用 **Standalone 模式**，由 Vitest（`vitest.desktop.config.ts`）统一调度，**不引入** `@wdio/cli` 和 `wdio.conf.ts`。
* **跨域 iframe 补丁**：壳层与内嵌 dsh 跨域，上游模拟帧逻辑会导致超时。本仓使用 `vendor/tauri-plugin-wdio-webdriver` 补丁，底层直接调用原生 `ICoreWebView2Frame2::ExecuteScript`。
* **执行约束**：
* 建会话后必须显式执行 `switchToWindow('main')`；
* `browser.execute` 内部无法读取外部模块变量，需通过参数显式传入；
* 就绪检测探测 `GET /status`；超时设置为 180s（装配用例可放宽至 900s）。

---

## 5. 断言与稳定性规范

1. **真实产物驱动**：仅针对真实 Tauri 窗口、尺寸及 IPC 进行断言，禁止在 E2E 层 Mock 后端命令或使用进程内替身。
2. **定位与排查**：失败必须精准定位到「用例 - 步骤 - 预期 vs 实际」，严禁依赖重跑遮蔽 Flake。稳定通过标准为**连续运行 ≥5 次无 Flake**。
3. **元素选择器规范**：
  * **壳层**：`data-testid="dsh-<域>-<元素名>"`（统一收录于 `test/e2e/support/selectors.ts`）；
  * **插件注入**：`data-dsh-*`（禁止为了测试修改行为钩子属性）；
  * **dsh 上游结构**：优先使用 `data-slot` / `role` / `dsh`·`dshp` 前缀类；
  * **严禁依赖**：文本内容、任意 CSS 类名、非稳定 DOM 层级。
4. **异常与报错收集**：
  * 必须监听 `pageerror` 与 `console.error`，过滤清单必须保持极窄且附带说明；
  * 针对 iframe 加载期报错盲区，使用「iframe 挂载 + `#root` 有内容 + 未落入失败页」进行间接兜底。
5. **平台条件一致性**：跨跨平台跳过用例时（如 Win-only），统一使用相符的 `skipIf` 表达式，避免因环境变量差异产生假绿。
---

## 6. 命令与 CI

### 本地运行命令

```bash
# 1. 前置步骤：编译二进制文件
pnpm build:debug

# 2. 执行整条 desktop 车道
node node_modules/vitest/vitest.mjs run --project desktop

# 3. 运行单个测试文件（必须使用位置参数，勿传 `--` 参数）
node node_modules/vitest/vitest.mjs run --project desktop test/e2e/desktop/boot.e2e.ts
```

> **注意**：请勿使用 `pnpm run test:e2e:desktop`，避免触发依赖校验与 `.bin` shim 问题。

### CI 流程 (`desktop-e2e`)

* **运行环境**：`.github/workflows/ci.yml` (`windows-latest`)，PR 必过门禁。
* **构建步骤**：恢复缓存 → `pnpm install --frozen-lockfile` → `build:plugins` → `vite build` → `tauri build --debug --no-bundle` → 运行 E2E。
* **排查产物**：失败日志与 WDIO 截图默认约定落盘至 `test/e2e/.artifacts/`，同时可参考 `<home>/logs/dsh-web.dev.log`。

---

## 7. 已知坑点与处置方案

| # | 现象描述 | 根本原因 | 标准处置方案 |
| --- | --- | --- | --- |
| **1** | 目录清理触发 `EPERM` | WebView2 子进程延迟释放导致文件锁 | 调用 `purgeStaleHomes()` 基于 `mtime` 择期清理，禁止阻塞当前用例 |
| **2** | Invoke 被拒后等待 46~56s | 驱动将拒绝回包为 HTTP 500 触发 WDIO 指数退避重试 | 在断言逻辑外围临时将 `connectionRetryCount` 设为 `0`，`finally` 中还原 |
| **3** | 非 Windows 环境假绿 | `skipIf` 判断条件不统一 | 统一桌面车道的平台判据表达式 |
| **4** | 端口冲突或漂移 | 端口被占用触发自动递增 | 校验逻辑改用「实时空闲检测」，禁止硬编码 3081 端口 |
| **5** | 前台终端夺焦 | 窗口失去 Focus 导致交互断言失败 | 强制要求在独立后台终端运行 |
| **6** | 应用启动崩溃 (exit 101) | 缺少 AppData 基础目录结构 | 测试脚手架前置创建 `Local` 与 `Roaming` 目录 |
| **7** | 冷装配环境超时/失败 | 依赖网络下载 Node 与内核 | 属于预期行为，确保测试环境具备外网连通性 |

---
