# 桌面端测试协议（L3）

> **核心定位**：L3 车道仅验证：**壳层是否将 dsh 正确装配、启动并嵌入**。
> **配套文档**：[plugin.test.md](./plugin.test.md)（插件 L1/L2/C 浏览器层）｜[testing.md](./testing.md)（测试评审标准）。

---

## 1. L3 准入与分层判据

### 准入范围（Electron 原生产物）

* OS 独立窗口（创建/销毁，通过 `__TAURI_INTERNALS__.metadata.currentWindow.label` 识别）。
* 窗口几何属性与尺寸限制。
* Tauri IPC 往返（`__TAURI_INTERNALS__.invoke`）。

### 归属 C 浏览器层（禁止进入 L3）

* 内嵌 dsh 页面内的 DOM（业务面板、侧栏、Tab、对话框等，统一使用 Playwright 库 API）。
* 配置、语言、档案、插件生命周期、更新等非壳层业务。

> **用例来源**：车道由 `config/vitest.desktop.config.ts` 的 `include` 规定。

---

## 2. 平台与环境前置

| 维度 | 规范与约定 |
| --- | --- |
| **车道入口** | `tests/e2e/setup/shell.ts`。用例自行调用 `startShellApp()` / `shellAppScope()` 启动实例，`fileParallelism: false` 保证串行。 |
| **运行平台** | Windows / macOS / Linux 三平台，按发布矩阵逐架构覆盖（`windows-latest` x64、`macos-26` arm64、`macos-26-intel` x64、`ubuntu-22.04` x64、`ubuntu-22.04-arm` arm64，Linux 下强制 `xvfb-run`）。CI 会校验 `runner.arch` 与矩阵声明一致，标签写错直接失败。 |
| **构建产物** | 先构建 renderer (`pnpm --filter dsh-desktop build`) 再构建 Cargo。按调试二进制路径顺序探测，测试中不重新构建。 |
| **前端 fallback** | `dist/` 缺失时回退 `devUrl` (`http://localhost:1420`)。 |
| **端口策略** | **CDP 端口**：`freePort()` 动态获取，通过 `TAURI_RUNTIME_ELECTRON_ARGS=--remote-debugging-port` 注入（严禁硬编码）；**服务端口**自动递增。 |
| **E2E 哨兵** | `TAURI_WEBDRIVER_PORT` 仅作为 Rust 侧 `is_e2e_run()` 开关（触发 `.store.test.dat` 与 `DSH_E2E_HOME` 重定向）。 |
| **多实例与残留** | 使用 `TAURI_RUNTIME_ELECTRON_OWNER=dsh-e2e` 隔离 `userData`。启动前必须创建 `<home>/home`、AppData 子目录及 `<home>/app-data`，否则 Rust 侧 panic (101)。 |
| **网络要求** | 冷装配需联网下载 Node 与内核。 |

---

## 3. 测试隔离策略

* **环境根重定向**：`DSH_E2E_HOME`、`USERPROFILE`、`HOME`、`APPDATA`、`XDG_*` 统一指向 `mkdtemp` 的 scratch 根目录。
* **Store 隔离**：强制使用 `.store.test.dat`。每次启动采用全新 scratch 根，无历史状态污染。
* **下载缓存**：默认指向 `<home>/download-cache`。传入稳定目录 (`shellAppScope({ downloadCacheDir })`) 可复用已下载的运行环境。
* **生命周期清理**：`stop()` 顺序：断开 CDP (`browser.close()`) → 杀进程树 (`taskkill /T /F` 或 `SIGKILL`) → 递归删除 scratch 根。
* **红线规则**：严禁读写真实 `~/.dsh`、`~/.dsh.dev` 或修改真实档案数据。

---

## 4. 驱动与运行机制

```
Vitest (Node) ──> spawn(debug 二进制, TAURI_RUNTIME_ELECTRON_ARGS=--remote-debugging-port=N)
              ──> 轮询 http://127.0.0.1:N/json/list 获取壳层 page target
              ──> playwright chromium.connectOverCDP(127.0.0.1:N)

```

* **驱动组合**：通过 `playwright` 的 `chromium.connectOverCDP` 直连 DevTools 协议（**不使用** WebDriver / `@wdio/*`）。
* **壳层判定**：`SHELL_PAGE = /^(?:tauri:\/\/localhost|https?:\/\/tauri\.localhost|http:\/\/localhost:1420)/`。
* **执行约束**：CDP 就绪检测上限 120s；冷装配超时 `900s`（mac 为 `300s`），普通用例 `180s`。

---

## 5. 断言与稳定性规范

1. **真实产物驱动**：仅针对真实 Electron 窗口、尺寸及 IPC 断言，禁止在 E2E 层 Mock 后端命令。
2. **选择器规范**：
  * **壳层**：`data-testid="dsh-<域>-<元素名>"`（必须引用 `shell.ts` 导出的常量）。
  * **插件注入**：`data-dsh-*`。
  * **严禁依赖**：文本内容、任意 CSS 类名、非稳定 DOM 层级。

3. **稳定性标准**：连续运行 **≥5 次无 Flake**。
4. **异常收集**：通过 `installErrorCollector(page)` 捕获 `error`、`unhandledrejection` 与 `console.error`。
5. **失败取证**：用例失败时由 `shellAppScope()` 自动打印 `diagnose()`（目录树、日志尾部、进程表）。

---

## 6. 命令与 CI

### 本地调试命令

```bash
# 1. 前置构建
pnpm --filter dsh-desktop build
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --features tauri/custom-protocol

# 2. 全量车道运行
vitest run --project desktop

# 3. 单个测试文件运行
vitest run --project desktop apps/desktop/tests/e2e/<域>/<用例>.e2e.ts
```

### CI 流程

* **流水线**：`.github/workflows/ci.yml`（与发布矩阵同构，每个架构各跑一次；见 §2 运行平台）。
* **排查路径**：dsh 服务日志位于 `<DSH_DOWNLOAD_CACHE_DIR>/logs/dsh-web.dev.log`。

---

## 7. 已知坑点与处置方案

| # | 现象描述 | 根本原因 | 标准处置方案 |
| --- | --- | --- | --- |
