# E2E 测试规范（渐进式）

> 适用范围：`deepseek-harness-desktop` 桌面端（`src/` + `src-tauri/`）与内置插件（`packages/*`）。
> 本文是 E2E 的唯一入口规范：工具选型、目录归属、用例文档格式、推进节奏都在此约定。
> 单元测试（Vitest）不在本文范围，仅在第 2.3 节说明边界。
> 推进流程与进度台账：[progressive.md](./progressive.md)。

---

## 1. 目标与原则

1. **渐进式**：一次只加一个用例。每个用例先能稳定跑通、再合并，不写「跑不起来但看起来完整」的批量用例。具体协作流程见 [progressive.md](./progressive.md)。
2. **真实优先**：E2E 必须驱动真实 Tauri 窗口 / 真实进程，不 mock 后端命令（mock 属于单元层）。
3. **可归因**：任何失败都要能直接定位到「哪个用例、哪一步、期望什么、实际什么」，不允许靠重跑掩盖。
4. **文档与代码一一对应**：一个用例文档条目 ⇄ 一个 `it()`；反之亦然。
5. **不污染开发环境**：E2E 跑在独立数据目录与独立端口上，绝不碰用户正在 dev 的实例。
6. **单一运行器**：全仓只有一个测试运行器 **vitest**（`test.projects` 分层）。WebdriverIO / Playwright 只作为**驱动库**被 vitest 用例调用，不引入它们的测试 runner。

---

## 2. 技术选型（Tauri 官方推荐）

### 2.1 主线：WebdriverIO + `@wdio/tauri-service`

Tauri v2 官方推荐的桌面端 E2E 方案是 **WebdriverIO** 配 `@wdio/tauri-service`（见 [Tauri WebDriver 文档](https://v2.tauri.app/develop/tests/webdriver/)）。默认 `driverProvider: 'embedded'`：WebDriver 服务端跑在应用进程内，三平台（Windows WebView2 / macOS WKWebView / Linux WebKitGTK）同一套用例，无需外部 `tauri-driver`。

**分工**：WebdriverIO 在这里只当**驱动库**（`remote()` 建立会话、`browser.$` / `browser.execute` 操作窗口），用例的组织与断言仍由 vitest 承担（`desktop` project）。不引入 `@wdio/cli` 的 runner 与 `wdio.conf.ts`——全仓单一运行器见第 1 节原则 6。

| 组件 | 作用 | 是否必需 |
| --- | --- | --- |
| `webdriverio` | 驱动库：建会话、查元素、执行脚本 | 必需 |
| `@wdio/tauri-service` | 发现应用二进制、拉起应用、把 WDIO 会话接到应用 | 必需 |
| `tauri-plugin-wdio-webdriver`（Rust crate） | 应用内嵌 W3C WebDriver server，`embedded` 提供者的前提 | `embedded` 必需 |
| `@wdio/tauri-plugin` + `tauri-plugin-wdio`（Rust crate） | `browser.tauri.execute()`、IPC mock、前后端日志回流 | 按需 |

Rust 侧注册（`src-tauri/src/lib.rs`，仅在需要时引入）：

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_wdio_webdriver::init())
```

### 2.2 补充：browser mode（快速层）

`@wdio/tauri-service` 的 browser mode 把前端跑在普通 Chrome + Vite dev server 里，拦截 `invoke()` 供 mock，不需要 Tauri 二进制、不需要 driver。用于「只想验证壳层 UI 结构 / 交互」的高频回归，速度快、稳定性高。

**定位**：它是 E2E 的快速层，不是替代品。凡是「进程、端口、文件、托盘、窗口」相关断言，必须走真实层。

### 2.3 与单元测试的边界

| 问题 | 归属 |
| --- | --- |
| 纯函数、状态机、解析、格式化 | Vitest 单元测试 |
| 组件渲染 + 交互（无进程） | browser mode 或 Vitest + `@tauri-apps/api/mocks` |
| 真实窗口、真实进程、真实端口、真实文件落盘 | 真实 E2E（本文） |
| 插件 host 路由契约（handler 直接调用） | Vitest 单元测试（`packages/*/src/**/*.test.ts`） |
| 插件在真实 dsh 进程内被加载后的行为 | 插件 E2E（本文） |

---

## 3. 目录约定

### 3.1 测试代码

| 路径 | 内容 |
| --- | --- |
| `test/archive/*` | 历史测试（原 `test/*.test.ts` 全部迁入），只读参考，**任何 project 都不收** |
| `test/unit/*` | 桌面端单元测试（`unit` project） |
| `test/e2e/support/*` | 共享工具：宿主编排（`dsh-host.ts`）、选择器常量、环境准备 |
| `test/e2e/global-setup.ts` | `e2e` project 的 globalSetup（起停真实宿主） |
| `test/e2e/specs/desktop/*` | 桌面端 E2E 用例（`desktop` project，后续加） |
| `packages/<name>/test/*.e2e.ts` | 插件在真实 dsh 进程内的用例（`e2e` project，见 [plugin.spec.md](./plugin.spec.md)） |
| `packages/<name>/src/**/<logic>.test.ts` | 该插件与源码同名的单元测试（**保持原位**） |
| `packages/.test/test-utils.ts` | 插件测试共享工具（保持原位） |

> 说明：`packages/*/src/**/*.test.ts` 已按「与逻辑同名」落位并被根 `vitest.config.ts` 的 `packages/**` include 覆盖，本次不搬迁，避免无收益的大规模 diff。

### 3.2 用例文档

| 路径 | 内容 |
| --- | --- |
| `docs/testing/e2e/spec.md` | 本文（规范与路线图） |
| `docs/testing/desktop/*.md` | 桌面端用例（按测试项分文件） |
| `docs/testing/plugins/*.md` | 插件用例（按插件名分文件） |

文件命名：`<序号>-<测试项>.md`，序号两位（`01-`、`02-`…），与推进批次对应。例：

- `docs/testing/desktop/01-window-boot.md`
- `docs/testing/desktop/02-shell-navigation.md`
- `docs/testing/plugins/dsh-tauri-pet.md`

---

## 4. 用例文档格式

每个文件开头写测试项元信息，其后每条用例一个 `##` 段：

```markdown
# 窗口启动

> 层级：E2E（真实）
> 自动化：`test/e2e/specs/desktop/01-window-boot.e2e.ts`
> 前置：桌面端二进制已构建；3081 端口空闲；无 dev 实例在跑

## [P1] 验证应用启动后主窗口存在且标题正确
[层级] E2E（真实）
[自动化] 是
[前置条件] 二进制存在；端口空闲
[测试步骤] 1. 启动应用。2. 读取当前窗口句柄与标题。
[预期结果] 1. 会话建立成功。2. 恰好一个窗口，标题为 `Deepseek Harness Desktop`。
```

约定：

- 优先级 `P1`–`P5`：P1 核心正向、P2 基本正向、P3 核心异常、P4 边界、P5 低频。
- 标题以「验证」开头；反向用例标题追加 `[反向]`。
- `[自动化]` 取值 `是` / `否（手工）`；手工用例不得写成 `it()`。
- 步骤与预期结果编号连续且数量一致。
- 一条用例只变一个变量；前置条件必须可独立复现。

---

## 5. 选择器与测试钩子

当前 `src/` 与 `packages/*/src/` **没有任何 `data-testid`**。E2E 一律使用 `data-testid`，禁止依赖 CSS 类名、文案、DOM 层级。

- 命名：`dsh-<域>-<元素>`，全小写连字符。例：`dsh-navbar-root`、`dsh-config-trigger`、`dsh-setup-progress`。
- 位置：直接写在业务组件元素上，值用字面量，不进 `constants/`。
- 约定：每个新用例落地时，**同步**为它需要的新增选择器补 `data-testid`，不允许测试里写脆弱的临时选择器。
- 共享选择器常量集中在 `test/e2e/support/selectors.ts`，供多个用例复用。

---

## 6. 隔离与环境

| 项 | 约定 |
| --- | --- |
| 端口 | debug 构建固定 `3081`（release 为 `3080`）；E2E 只跑 debug 构建，且运行前断言 3081 空闲 |
| 数据目录 | debug 构建固定 `~/.dsh.dev`（忽略继承的 `DSH_HOME`）；E2E 直接使用它，运行前要求无 dev 实例占用 |
| 前置检查 | 用例开始前断言：3081 未被监听、无同名应用进程残留；不满足即 fail（不自动杀用户进程） |
| 收尾 | 每个 spec 结束必须关闭应用并等待进程退出；残留进程由测试自身负责清理 |
| 网络 | 默认允许联网；需要断网的用例单独标注并在文档 `[前置条件]` 写明构造方式 |
| 平台 | Windows 为主开发平台；涉及平台的用例标注 `[平台] Windows` 等 |

> 端口与数据目录由 `cfg!(debug_assertions)` 决定，**不可**在测试内改写；因此隔离靠「debug 构建 + 运行前检查」，而不是改配置。

---

## 7. 推进路线图

从最简单、最稳定、最少依赖的用例起步，逐批合入。**每批只做一条**，跑通后再排下一批。

| 批次 | 用例 | 文档 | 依赖 |
| --- | --- | --- | --- |
| B1 | 应用启动后主窗口存在且标题正确 | `desktop/01-window-boot.md` | 无 |
| B2 | 壳层根节点渲染且页面无未捕获错误 | `desktop/01-window-boot.md` | B1 |
| B3 | 导航栏存在且折叠/展开按钮可点击并生效 | `desktop/02-shell-navigation.md` | B2 |
| B4 | 配置对话框可打开、可关闭 | `desktop/03-config-dialog.md` | B3 |
| B5 | 语言切换后界面文案即时变更 | `desktop/04-locale-theme.md` | B4 |
| B6 | 档案列表展示与新建档案 | `desktop/05-profile.md` | B3 |
| B7 | 内置 dsh 界面 iframe 加载完成 | `desktop/06-harness-embed.md` | B1 |
| B8+ | 安装引导、插件面板、恢复页、桌宠窗口… | 按需新建 | 逐条确认 |

插件侧（与桌面批次并行推进，同样一次一条）：

| 批次 | 用例 | 文档 |
| --- | --- | --- |
| P1 | `dsh-tauri-pet` 在真实 dsh 进程内挂载成功、SSE 路由可连 | `plugins/dsh-tauri-pet.md` |
| P2 | `dsh-tauri-worktree` 面板在壳层中渲染 | `plugins/dsh-tauri-worktree.md` |
| P3+ | 其余插件按「先 host 后 client」逐个补 | 按需新建 |

**准入条件（每条用例都要满足）**：

1. 单独跑通过 ≥ 5 次，无 flake。
2. 失败信息能定位到具体步骤。
3. 文档条目与 `it()` 一一对应。
4. 不依赖「上一次运行留下的状态」。

---

## 8. 执行与 CI

**全仓只有一个测试运行器：vitest。** 分层用 `test.projects` 表达，不引入第二个 runner。

```bash
pnpm test                  # 全部 project（unit + e2e）
pnpm test:unit             # 只跑单元
pnpm test:e2e:plugin       # 只跑插件 L2 E2E（需先 pnpm build:plugins）
vitest --project unit -- <file>   # 单文件
```

| project | 配置文件 | 收什么 | 备注 |
| --- | --- | --- | --- |
| `unit` | `vitest.unit.config.ts` | `packages/**/*.{test,spec}.*`、`test/unit/**`、`src/**/*.test.ts` | 排除 `test/archive/**` |
| `e2e` | `vitest.e2e.config.ts` | `packages/*/test/**/*.e2e.ts` | `globalSetup` 起真实 dsh；`fileParallelism: false` |
| `desktop` | 后续 | `test/e2e/specs/desktop/**/*.e2e.ts` | 驱动真实 Tauri 窗口 |

`pnpm test` 会带上 `e2e` project，因此**未构建插件产物时会整体失败**（`assertBuilt` 的报错会直接指出要跑 `pnpm build:plugins`）；日常迭代用 `pnpm test:unit`。


- E2E 不进 PR 必过门禁（构建耗时长、需要图形环境）；先作为发布前冒烟与本地按需执行。
- CI 接入时机：E2E 用例数 ≥ 5 且连续两周无 flake 后，再挂到发布流程。
- 日志：失败时保留应用 stdout/stderr 与 WDIO 截图，落 `test/e2e/.artifacts/`（不入库）。

---

## 9. 已确认决策

1. 插件单元测试（`packages/*/src/**/*.test.ts`）**保持原位**，`packages/<name>/test/` 只放插件 E2E。
2. `test/archive/*` 是历史用例归档（原 `test/*.test.ts`），任何 project 都不收；壳层用例迁往 `test/unit/`。
3. E2E 形态：**debug 构建**（端口 3081 + `~/.dsh.dev`）。
4. **单一运行器**：全仓只用 vitest（`test.projects`）；WebdriverIO / Playwright 只作驱动库。
5. 插件侧方案见 [plugin.spec.md](./plugin.spec.md)：L2 = vitest `e2e` project + 真实 `dsh web` 进程（浏览器用 Playwright 库 API）；L3 = 本文的桌面端通道。
6. 推进流程与进度台账见 [progressive.md](./progressive.md)。

