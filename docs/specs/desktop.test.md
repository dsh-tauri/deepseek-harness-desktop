# 桌面端测试规范

> **适用范围**：`deepseek-harness-desktop` 桌面端（`src/` + `src-tauri/`）与内置插件（`packages/*`）。
> **核心定位**：测试唯一入口规范。进度台账与协作流程见 [progressive.md](../testing/progressive.md)。

---

## 1. 核心原则

1. **渐进迭代**：单次仅合入单个稳定用例，禁止批量引入未验证用例。
2. **真实环境**：必须驱动真实 Tauri 窗口/进程，禁止在 E2E 层 Mock 后端命令。
3. **严格归因**：失败日志需精准定位定位至「用例 - 步骤 - 期望 vs 实际」，禁止依赖重跑掩盖。
4. **单元映射**：文档条目与测试用例 (`it()`) 必须保持 1:1 映射。
5. **环境隔离**：运行于独立数据目录与端口，严禁污染开发环境。
6. **单一运行器**：全仓统一使用 **Vitest** (`test.projects`)；WebdriverIO / Playwright 仅作为驱动库引入。

---

## 2. 技术选型

### 2.1 桌面端主线：WebdriverIO + `@wdio/tauri-service`
采用 Tauri v2 官方推荐方案，使用 `driverProvider: 'embedded'` 驱动内嵌 WebDriver 服务，实现跨平台（Windows WebView2 / macOS WKWebView / Linux WebKitGTK）统一测试。

* **运行机制**：WebdriverIO 仅充当驱动库（负责会话管理与 DOM 操作），由 Vitest (`desktop` project) 统一组织执行与断言。不引入 `@wdio/cli` 及 `wdio.conf.ts`。

| 组件 | 作用 | 必选性 |
| :--- | :--- | :--- |
| `webdriverio` | 驱动库：提供会话建立、元素查找与脚本执行 | 必需 |
| `@wdio/tauri-service` | 进程管理：发现并拉起应用二进制，绑定 WDIO 会话 | 必需 |
| `tauri-plugin-wdio-webdriver` | Rust 插件：应用内嵌 W3C WebDriver Server | `embedded` 模式必需 |
| `tauri-plugin-wdio` | Rust 插件：提供 `browser.tauri.execute()`、IPC Mock 及日志回流 | 按需 |

```rust
// src-tauri/src/lib.rs (仅在需要时注册)
tauri::Builder::default()
    .plugin(tauri_plugin_wdio_webdriver::init())

```

### 2.2 辅助层与测试边界

* **Browser Mode（快速层）**：将前端托管于 Vite Dev Server 并拦截 `invoke()`，专用于高频 UI/交互逻辑回归。**涉及进程、端口、文件落盘、系统托盘的断言必须走真实层**。

| 测试归属 | 对应方案 |
| --- | --- |
| 纯函数 / 状态机 / 格式化解析 | Vitest 单元测试 |
| 纯 UI 组件渲染与交互 | Browser Mode 或 Vitest + `@tauri-apps/api/mocks` |
| 插件 Host 路由契约 | Vitest 单元测试 (`packages/*/src/**/*.test.ts`) |
| **真实窗口 / 进程 / 端口 / 文件落盘 / 插件集成** | **桌面端/插件 E2E（本文规范）** |

---

## 3. 目录与归属约定

### 3.1 测试代码目录

* `test/unit/*`：桌面端单元测试 (`unit` project)
* `test/archive/*`：归档历史测试（仅作只读参考，不纳入任何 project）
* `test/e2e/support/*`：E2E 共享工具（宿主编排 `dsh-host.ts`、选择器常量等）
* `test/e2e/global-setup.ts`：E2E 全局生命周期管理（启动/关闭宿主进程）
* `test/e2e/specs/desktop/*`：桌面端 E2E 用例 (`desktop` project)
* `packages/<name>/test/*.e2e.ts`：插件真实进程 E2E 用例 (`e2e` project)
* `packages/<name>/src/**/*.test.ts`：插件源码同级单元测试（保持原位）

### 3.2 用例文档目录

* `docs/specs/desktop.test.md`：本规范文档
* `docs/testing/desktop/<序号>-<测试项>.md`：桌面端用例（如 `01-window-boot.md`）
* `docs/testing/plugins/<序号>-<插件名>.md`：插件用例（如 `03-dsh-tauri-pet.md`）

---

## 4. 用例文档规范

每个文档需包含元信息区，并按 `##` 划分具体用例：

```markdown
# 窗口启动

> 层级：E2E（真实）
> 自动化：`test/e2e/specs/desktop/01-window-boot.e2e.ts`
> 前置：桌面端 Debug 二进制已构建；3081 端口空闲；无 Dev 实例运行

## [P1] 验证应用启动后主窗口存在且标题正确
[层级] E2E（真实）
[自动化] 是
[前置条件] 二进制存在；端口 3081 空闲
[测试步骤] 1. 启动应用。 2. 读取当前窗口句柄与标题。
[预期结果] 1. 会话建立成功。 2. 存在唯一窗口，标题为 `Deepseek Harness Desktop`。

```

* **规范约束**：
* **优先级**：`P1`（核心正向）、`P2`（基本正向）、`P3`（核心异常）、`P4`（边界）、`P5`（低频）。
* **命名**：标题以「验证」开头，反向用例标注 `[反向]`。手工用例标记 `[自动化] 否（手工）`，严禁编写为 `it()`。
* **断言**：步骤与预期结果须编号严格对应；单用例仅变更单一变量。



---

## 5. 选择器规范 (`data-testid`)

E2E 测试**必须**使用 `data-testid` 进行元素定位，严禁依赖 CSS 类名、DOM 层级或文本内容。

* **命名格式**：`dsh-<业务域>-<元素名>`（全小写连字符，如 `dsh-navbar-root`）。
* **维护原则**：字面量直接写入业务组件；跨用例复用的选择器常量统一收录于 `test/e2e/support/selectors.ts`。新增用例必须同步补全元素 `data-testid`。

---

## 6. 环境隔离与规则

| 维度 | 规范约定 |
| --- | --- |
| **端口策略** | Debug 构建默认使用 `3081`（Release 为 `3080`）。测试运行前断言默认端口空闲。 |
| **数据目录** | **全部测试数据必须落在本次运行独占的独立根 `$E2E_HOME` 之下，严禁读写用户真实的 `~/.dsh`、`~/.dsh.dev` 与 `%APPDATA%/io.github.hairyf.deepseek-harness-desktop`。** |
| **前置校验** | 测试前检查端口与进程；存在残留直接 Fail，**不自动强杀用户进程**。 |
| **测试收尾** | 单个 Spec 结束必须主动关闭应用并等待进程平滑退出；异常残留由测试脚本自行清理。 |
| **运行网络** | 默认允许联网。断网测试需在用例 `[前置条件]` 中单独标注并构造环境。 |

### 6.1 独立根 `$E2E_HOME`（强制）

`$E2E_HOME` = `<tmp>/dsh-e2e-desktop-<时间戳>`，由桌面端宿主编排创建，运行结束递归删除。用例文档中的 `~/.dsh.dev`、`~/.dsh`、`AppData/` 均为其下的相对简写：

| 简写 | 实际路径 |
| --- | --- |
| `~/.dsh.dev` | `$E2E_HOME/home/.dsh.dev` |
| `~/.dsh` | `$E2E_HOME/home/.dsh` |
| `AppData/` | `$E2E_HOME/appdata/io.github.hairyf.deepseek-harness-desktop/` |

**实现方式**：应用以 `USERPROFILE`(Windows)/`HOME`(Unix) 指向 `$E2E_HOME/home`、以 `APPDATA`(Windows)/`XDG_DATA_HOME`(Unix) 指向 `$E2E_HOME/appdata` 启动。

**失败关闭**：脚手架必须在启动应用前断言解析出的 `data_dir` 与 app-data 根均在 `$E2E_HOME` 之下；不满足即 Fail，不得降级到真实目录。

**为什么不能只设 `DSH_HOME`**：`get_dsh_data_path` 在 debug 构建下恒返回 `<home>/.dsh.dev` 并**忽略** `DSH_HOME`（`src-tauri/src/config/runtime.rs:471`、`:472`）；home 根取自 `USERPROFILE`/`HOME`（`src-tauri/src/config/runtime.rs:455`）。应用数据目录另由 `app_handle.path().app_data_dir()` 决定，debug 再追加 `dev` 子目录（`src-tauri/src/config/runtime.rs:17`、`:22`）。因此只能用上述两个根重定向实现隔离。

**禁止事项**：不得设置 `DSH_HOME` 来「隔离」桌面端；不得在用例中创建或删除 `web`、`tauri`、`safe` 档案。

---

## 7. 推进路线图

必须按批次**单条推进**，验证无 Flake 后方可进入下一批次。批次号 = `docs/testing/desktop/` 下的文档序号，完整清单见该目录 `00-overview.md` §3。

### 桌面端路线图

* **1**：应用启动后主窗口存在且标题正确 (`desktop/01-window-boot.md`)
* **2**：壳层根节点渲染且页面无未捕获错误 (`desktop/01-window-boot.md`)
* **3**：导航栏存在且折叠/展开按钮响应正常 (`desktop/02-shell-navigation.md`)
* **4**：配置对话框的打开与关闭 (`desktop/03-config-dialog.md`)
* **5**：语言切换即时生效 (`desktop/04-locale-theme.md`)
* **6**：档案列表展示与新建操作 (`desktop/05-profile.md`)
* **7**：内置 DSH 界面 Iframe 加载完成 (`desktop/06-harness-embed.md`)
* **8+**：`07`–`29` 按文档序号逐条推进（服务生命周期、装配、隔离、隐私、错误矩阵、状态机、插件生命周期、更新内部、系统集成）

### 插件侧路线图

批次号 = `docs/testing/plugins/` 下的文档序号，清单见该目录 `00-overview.md` §3。

* **1**：编排骨架——脚手架挂载并拉起 `dsh web` 随机端口 (`plugins/01-host-lane-skeleton.md`)
* **2**：共享路由契约（OPTIONS/405/403/413）(`plugins/02-dsh-tauri-core.md`)
* **3**：`dsh-tauri-pet` SSE 路由连上并收到首帧，随后客户端挂载与 L3 窗口 (`plugins/03-dsh-tauri-pet.md`)
* **4+**：`04`–`18` 先 Host 后 Client 逐条推进，`18` 为跨插件与壳层集成收尾
* **准入标准**：独立运行 ≥ 5 次无 Flake、失败时能精确定位步骤、文档与 `it()` 严格对应、不依赖上一次运行遗留状态。

---

## 8. 执行与 CI 集成

### 8.1 本地命令

全仓统一由 Vitest 进行 Project 分层调度：

```bash
pnpm test                 # 执行全量测试 (unit + e2e)
pnpm test:unit            # 仅执行单元测试
pnpm test:e2e:plugin      # 仅执行插件 E2E (需提前运行 pnpm build:plugins)
vitest --project unit -- <file> # 运行指定单文件测试

```

### 8.2 Vitest Project 配置

| Project | 配置文件 | 匹配范围 | 说明 |
| --- | --- | --- | --- |
| `unit` | `vitest.unit.config.ts` | `packages/**/*.{test,spec}.*`<br>

<br>`test/unit/**`<br>

<br>`src/**/*.test.ts` | 排除 `test/archive/**` |
| `e2e` | `vitest.e2e.config.ts` | `packages/*/test/**/*.e2e.ts` | `globalSetup` 拉起真实 DSH；设置 `fileParallelism: false` |
| `desktop` | *(待配置)* | `test/e2e/specs/desktop/**/*.e2e.ts` | 驱动真实 Tauri 桌面窗口 |

### 8.3 CI 与产物管理

* **CI 挂载时机**：E2E 用例总数 ≥ 5 且连续两周无 Flake 后，接入发布流水线（不作为 PR 必过门禁）。
* **失败产物**：测试失败时，自动保存应用 `stdout`/`stderr` 及 WDIO 截图至 `test/e2e/.artifacts/`（该目录 Git Ignore）。
