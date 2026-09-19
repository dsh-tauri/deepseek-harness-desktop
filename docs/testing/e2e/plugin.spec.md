# 插件 E2E 测试规范（渐进式）

> 配套文档：[spec.md](./spec.md)（桌面端 E2E 总规范）。
> 本文只解决一件事：**内置插件（`packages/*`）的 E2E 怎么测**。
> 用例文档放 `docs/testing/plugins/<plugin>.md`；测试代码放 `packages/<name>/test/`。

---

## 1. 为什么不能照搬桌面端方案

内置插件不是一个进程，它由两半组成，且两半跑在不同宿主里：

| 半边 | 运行位置 | 谁提供宿主 | 生命周期 |
| --- | --- | --- | --- |
| `src/host/**` | `dsh web` 进程（Node） | dsh 的 cordis 容器 + webServer | 随 dsh 进程 |
| `src/client/**` | dsh 的 WebView 页面 | dsh 前端 bundle 的 slot 注册表 | 随页面 |

因此插件的 E2E 有**两个真实宿主**可选，价值完全不同：

- **dsh 宿主**：真实 `dsh web` 进程 + 真实浏览器页面。不需要 Tauri，不需要桌面端二进制，启动快、可并行、可无头。社区主流插件（better-sidebar、dsh-im、dsh-rewind）都在这一层做门禁。
- **桌面端宿主**：桌面端壳层里嵌的 dsh iframe。只有「插件依赖 Tauri 桥」时才有额外价值（`dsh-tauri-pet` 的桌宠窗口、`dsh-tauri-worktree` 的 native 能力、`dsh-tauri-ui` 的壳层注入）。

**结论：插件 E2E 默认在 dsh 宿主层做；桌面端宿主层只给「确实依赖 Tauri 桥」的插件补，且复用 [spec.md](./spec.md) 的 WebdriverIO 通道。**

---

## 2. 参考方案对照（2026-09 调研）

| 仓库 | 分层 | 驱动 | 挂载方式 | 关键取舍 |
| --- | --- | --- | --- | --- |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 单元 / 覆盖率 / 真实 API e2e / 期望输出 / 快照 / Web 浏览器快照 | vitest + Chromium 快照 | Loader 启动 `cordis.yml` | 官方硬要求：**产品可见插件必须有「非单元的真实组合测试」**，且「真实入口路径」指**已构建产物**（`lib/bin.js` 由纯 node 跑），不是 TS 源码 |
| [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | 单元（`tests/*.spec.ts`）+ 挂载冒烟（`tests/e2e/*.e2e.ts`） | **Playwright + Chromium** | `pnpm build && pnpm pack` → `dsh plugin --profile web add file:<tarball>` → 真实 `dsh web --port 0` | 编排脚本负责起服务并把 `DSH_E2E_URL` 注入 spec；断言「插件挂载点存在 + 无 crash strip + 无 pageerror/console error」；e2e 命名 `*.e2e.ts` + vitest `exclude` 双保险 |
| [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im) | 单元（`test/**/*.test.mjs`，node:test） | 无浏览器 | — | 用 `scripts/verify-*.mjs` 做真实进程校验；浏览器相关只在 `test/browser/*.fixture.js` 里做 DOM 替身 |
| [SiriLee/dsh-rewind](https://github.com/SiriLee/dsh-rewind) | 单元（`tests/**/*.test.ts`，vitest + jsdom） | 无浏览器 | — | 用 `vitest.config.ts` 的 alias 把装不动的宿主重量级包（`dsh-client-ui-primitives`）替身成同契约 stub；`verify:host` 脚本做真实 host 校验 |

**取三者之长**：官方要求的「真实组合 + 构建产物」+ better-sidebar 的「Playwright 无头渲染挂载冒烟」+ rewind 的「宿主重量级依赖 stub」。

---

## 3. 三层测试模型

| 层 | 位置 | 驱动 | 断言对象 | 何时必须有 |
| --- | --- | --- | --- | --- |
| L1 单元 | `packages/<name>/src/**/*.test.ts`（**保持原位**） | vitest（`unit` project） | 纯函数、路由 handler 直接调用、注册表契约 | 永远 |
| L2 插件宿主 E2E | `packages/<name>/test/*.e2e.ts` | vitest（`e2e` project）+ Playwright 的浏览器 API（纯 HTTP 用例不开浏览器） | 真实 `dsh web` 进程：宿主路由响应、客户端挂载点、无崩溃 | **每个产品可见插件** |
| L3 桌面端宿主 E2E | `test/e2e/specs/desktop/*.e2e.ts` | vitest（`desktop` project，后续加）+ WebdriverIO/`@wdio/tauri-service` | 桌面端壳层 + 内嵌 dsh iframe | 仅「依赖 Tauri 桥」的插件 |

L1 与 L2/L3 的分工不重叠：L1 允许 mock 宿主，L2/L3 只 mock 外部服务（网络、模型、时钟），下游全真。

---

## 3.1 为什么是 vitest projects 而不是第二个测试运行器

全仓**只有一个测试运行器**（vitest）。分层靠 `test.projects` 表达，而不是引入 Playwright Test / Jest 之类的第二套 runner：

| 关注点 | 做法 |
| --- | --- |
| 跑哪一层 | `vitest --project unit` / `--project e2e`；`pnpm test` 跑全部 |
| 各层不同配置 | `vitest.unit.config.ts` / `vitest.e2e.config.ts`（`defineProject`） |
| 报告 / 覆盖率 | 根 `vitest.config.ts` 统一（project 级不支持 reporters） |
| 起停真实宿主 | project 的 `globalSetup`（起一次）+ `project.provide()` 下传地址 |
| 浏览器 | 用 Playwright 的**库 API**（`chromium.launch()`）在 vitest 用例里驱动，不用 Playwright Test 的 runner |

**为什么不直接用 vitest browser mode**：browser mode 的页面来自 vite dev server + 测试入口，而 L2 的页面必须由真实 `dsh web` 进程伺服（那是被测对象的一部分）。因此 L2 用「vitest 管用例 + Playwright 库 API 开浏览器访问真实 URL」，既拿到统一 runner，又拿到真实页面。

---

## 4. 驱动选型

| 选项 | 评价 |
| --- | --- |
| **Playwright + Chromium**（L2 首选） | 一个 devDependency；无头、可并行、失败有 trace/screenshot；与 better-sidebar 的用例可直接对照复现。**推荐** |
| WebdriverIO + `@wdio/tauri-service`（L3 必需） | 桌面端只有它能驱动真实 WebView；对 L2 过重（要内嵌 WebDriver 插件、要 Tauri 二进制） |
| 纯 node（`node:test` / vitest） | 只覆盖宿主 HTTP 路由，不覆盖客户端渲染。**仅当该插件没有 UI** 时可作为 L2 的形态 |

> L2 与 L3 用两套驱动是刻意的：L2 追求「快、稳、可并行」，L3 追求「真」。不为统一而牺牲任一侧。

---

## 5. 目录与命名

```
packages/<name>/
├── src/**/*.test.ts          # L1 单元（保持原位，不搬迁）
├── test/
│   ├── *.e2e.ts              # L2 插件宿主 E2E（e2e project 收；unit project 天然不收）
│   └── support/              # 该插件专属 fixture / 替身
test/e2e/
├── global-setup.ts           # e2e project 的 globalSetup：起一次真实 dsh web，provide 地址
├── support/dsh-host.ts       # 共享：scratch DSH_HOME、profile 脚手架、挂载、启动、解析 URL、teardown
└── specs/desktop/*.e2e.ts    # L3 桌面端宿主 E2E（后续加 desktop project）
test/archive/*                # 历史用例归档（只读参考，任何 project 都不收）
vitest.config.ts              # 根：只放 projects 清单与跨 project 全局项
vitest.unit.config.ts         # unit project
vitest.e2e.config.ts          # e2e project（插件 L2）
docs/testing/plugins/<name>.md
```

命名约定：

- L2 一律 `*.e2e.ts`，与 L1 的 `*.test.ts` 严格区分。
- `unit` project 的 include 是 `*.{test,spec}.*`，**天然不收 `.e2e.ts`**；`e2e` project 显式 `include: ['packages/*/test/**/*.e2e.ts']`，两边都不靠默认值。
- 一条用例文档条目 ⇄ 一个 `test()`，与桌面端同一约定。

---

## 6. L2 执行流程（真实挂载）

```
1. 构建产物：pnpm build:plugins                    # 官方要求：E2E 打构建产物，不打 TS 源码
2. scratch 环境：DSH_HOME=<tmp>/dsh-e2e-<plugin>-<ts>（绝不碰 ~/.dsh / ~/.dsh.dev）
3. 脚手架 profile：<DSH_HOME>/profiles/web/{package.json,cordis.patch.yml,pnpm-workspace.yaml}
4. 挂载（DSH_E2E_MOUNT=link 默认）：目录链接进 profile/node_modules + 写 dsh.profile.bundles
   挂载（DSH_E2E_MOUNT=cli）：dsh plugin --profile web add link:<repo>/packages/<name>
5. 校验挂载：profile package.json 的 dsh.profile.bundles 含该插件名（缺则立即 fail，不静默）
6. 起服务：dsh web --host 127.0.0.1 --port 0 --no-open --skip-auth
7. 就绪解析：日志里的 `dsh web: http://127.0.0.1:<port>/?token=<...>`；正则只取 URL 本体且必须吃到空白
8. 跑用例：vitest --project e2e（地址经 project.provide() 下传，用例用 inject() 取）
9. teardown：杀 dsh 进程树 → 删 scratch 目录（globalSetup 返回的 teardown 函数）
```

**为什么 `--skip-auth`**：dsh 的 `/api/**` 浏览器信任围栏默认要求「一次性 token 换 cookie」，无 cookie jar 的纯 HTTP 调用一律 401——那会让「路由没挂载」和「没鉴权」不可区分。桌面端是内嵌 UI，插件宿主路由本来就是给 Tauri 进程用普通 fetch 调的，所以 L2 跳过鉴权、只留 Host/Origin 围栏，断言才落在「路由存在与否」上。

**为什么 `dsh web` 不带 `--profile`**：`dsh web` 就是 `--profile web` 的别名，两者同时给会被 CLI 直接拒绝；因此 scratch profile 的目录名固定为 `web`。

`dsh` 与 `node` 的来源优先级：`$DSH_E2E_DSH_BIN` → `require.resolve('@deepseek-ai/dsh/lib/bin.js')` → 桌面端已装配的 `%APPDATA%/io.github.hairyf.deepseek-harness-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`；node 用 `$DSH_E2E_NODE_BIN`，缺省 `process.execPath`。

**并发与占用**：`DSH_HOME` 与端口都是每次调用独占，可并行；`e2e` project 仍设 `fileParallelism: false`——整个 project 共享一个真实 dsh 实例（globalSetup 起一次），串行执行让断言有意义。`DSH_E2E_MOUNT=cli` 会跑 pnpm，需显式传 `DSH_E2E_PNPM_STORE_DIR`（同时注入 `npm_config_store_dir` 与 `pnpm_config_store_dir`，与桌面端 `build_plugin_envs` 同源）。

---

## 7. 断言规范

**必须断言的（每个 L2 用例的底线）**：

1. **可见产物存在**，二选一（按插件形态）：
   - 插件**自己渲染 DOM**（面板、卡片、按钮）：根节点写稳定属性 `data-dsh-<plugin>`，E2E 断它 attached/visible。这是插件对外唯一稳定的寻址面。
   - 插件**只注册槽位/补丁**（如 `dsh-tauri-pet` 往 dsh 原生设置分区与侧栏注入，不自建根节点）：断言宿主里对应的槽位产物存在（如设置分区标题、侧栏入口），不能只断言「页面打开了」。
2. **无崩溃**：`pageerror` 为空 + 插件错误条（`fail()` / RenderBoundary 渲染的 strip）为空 + 带插件前缀的 `console.error` 为空。**不许只断言「页面能打开」**。
3. **宿主路由真实响应**：直接对插件自有路由发请求，断言状态码 + 响应体形状（不看 UI 的自我报告）。

**禁止的**：

- 用 CSS 类名 / 文案 / DOM 层级做选择器（用 `data-dsh-*`）。
- 断言「没报错就等于对」——必须有一个正向的可见/可读产物。
- 依赖上一次运行残留的状态（每次都是 scratch）。
- 对未修改的文件不比对（官方规则：未触碰的文件要逐字节一致）。

**L2 的测试数据**：workspace 与 session 通过 dsh 自身的 RPC 播种（与 UI 同一条路径），不手工写 JSONL。

---

## 8. L2 的依赖替身规则

插件 checkout 里装不动宿主重量级包（`dsh-client-ui-primitives` 的 `shiki`/`anser`/`katex`，宿主由预构建前端 bundle 满足）。处理方式，按优先级：

1. **优先真包**：能装就装，别替身。
2. **Playwright 层不替身**：L2 跑在真实页面里，宿主 bundle 自带这些包，不需要替身。
3. **仅 L1 单元层替身**：vitest 里用 `resolve.alias` 指向 `test/support/<pkg>-stub.ts`，stub 必须与真包同契约，并在文件头注明「新增导出时同步这里」。

---

## 9. 渐进推进路线

与桌面端同一节奏：**一次一条，跑通再排下一条**。建议从「纯宿主、无 UI」开始，把编排骨架先跑稳。

| 批次 | 插件 | 用例 | 层 | 依赖 |
| --- | --- | --- | --- | --- |
| PP0 | — | 编排骨架自证：scratch profile 能挂载 `dsh-tauri` 并让 `dsh web` 起在随机端口 | L2 基础设施 | 无 |
| PP1 | `dsh-tauri-pet` | 宿主 SSE 路由 `/api/desktop/dsh-tauri-pet/session/stream` 连上并收到首帧（无浏览器） | L2（纯 HTTP） | PP0 |
| PP2 | `dsh-tauri-pet` | 客户端在真实 dsh 页面里渲染出 `data-dsh-tauri-pet` 挂载点，且无崩溃标记 | L2（浏览器） | PP1 |
| PP3 | `dsh-tauri-worktree` | 面板在真实 dsh 页面渲染 + 宿主 `/worktree/*` 路由真实响应 | L2 | PP0 |
| PP4 | `dsh-tauri-pet` | 桌宠窗口在桌面端壳层里被创建（真实 Tauri 窗口） | **L3** | 桌面端 B1 通道 |
| PP5+ | 其余 8 个插件 | 先 host 后 client，逐个补 | L2 → L3 | 逐条确认 |

**准入条件**：单独跑通过 ≥ 5 次无 flake；失败信息能定位到具体步骤；文档条目与 `test()` 一一对应；不依赖上一次运行残留。

---

## 10. 已确认决策（2026-09）

1. **运行器**：全仓只有一个——**vitest**。分层用 `test.projects` 表达：`unit` / `e2e`（插件 L2）/ 后续 `desktop`（L3）。**不引入第二个测试运行器**。
2. **浏览器**：需要真实页面时用 **Playwright 的库 API**（`chromium.launch()`，devDependency `@playwright/test`，catalog `testing`）在 vitest 用例内驱动；**不用 Playwright Test 的 runner**。L3 的桌面端 WebView 驱动仍归 `@wdio/tauri-service`。
3. **首批范围**：PP0（编排骨架）+ PP1（`dsh-tauri-pet` 会话流路由连上并收到就绪帧）一起做。
4. **构建前提**：L2 **不自建**。使用前先跑一次 `pnpm build:plugins`；产物缺失时 `dsh-host.ts` 的 `assertBuilt()` 直接 fail 并给出命令，不静默。

### 10.1 落地形态

| 文件 | 作用 |
| --- | --- |
| `vitest.config.ts` | 根：只放 `projects` 清单与跨 project 全局项（`@` 别名） |
| `vitest.unit.config.ts` | `unit` project：`packages/**` + `test/unit/**` + `src/**` |
| `vitest.e2e.config.ts` | `e2e` project：`packages/*/test/**/*.e2e.ts`，`globalSetup`，`fileParallelism: false` |
| `test/e2e/global-setup.ts` | 起一次真实 dsh web，经 `project.provide()` 下传地址；返回 teardown 停服务清 scratch |
| `test/e2e/support/dsh-host.ts` | 编排：scratch `DSH_HOME` → 脚手架 profile → 挂载 → `dsh web --port 0 --skip-auth` → 解析就绪 URL |
| `packages/<name>/test/*.e2e.ts` | L2 用例（`unit` project 天然不收） |

运行：

```bash
pnpm test                  # 全部 project
pnpm test:unit             # 只跑单元
pnpm test:e2e:plugin       # 只跑插件 L2 E2E（需先 pnpm build:plugins）
```

### 10.2 挂载模式

`DSH_E2E_MOUNT` 二选一：

- **`link`（默认）**：自建目录链接（Windows junction）把仓库包接进 `profile/node_modules`，并直接写 `dsh.profile.bundles`。离线、快、不碰 pnpm store，也不与用户正在 dev 的实例争 pnpm。
- **`cli`**：走真实 `dsh plugin --profile web add link:<pkg>`（需要网络与 pnpm）。用于验证「真实安装路径」本身；跑之前设 `DSH_E2E_PNPM_STORE_DIR` 以免 store 主版本冲突。

两种模式都会在挂载后校验 `dsh.profile.bundles` 确实包含该插件，缺则立即失败。

### 10.3 环境变量

| 变量 | 用途 |
| --- | --- |
| `DSH_E2E_DSH_BIN` | dsh 入口（`lib/bin.js`）；缺省先试 `require.resolve('@deepseek-ai/dsh/lib/bin.js')`，再回退桌面端装配目录 |
| `DSH_E2E_NODE_BIN` | 跑 dsh 的 node；缺省 `process.execPath` |
| `DSH_E2E_PLUGIN` / `DSH_E2E_ALSO` | globalSetup 挂载哪个插件 / 额外依赖（默认 `dsh-tauri-pet`） |
| `DSH_E2E_MOUNT` | `link`（默认）/ `cli` |
| `DSH_E2E_KEEP_HOME` | `1` 保留 scratch 目录（调试） |

