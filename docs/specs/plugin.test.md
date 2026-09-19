# 插件测试规范（渐进式）

> 配套文档：[desktop.test.md](./desktop.test.md)（桌面端测试总规范）。
> 本规范专注于**内置插件（`packages/*`）的 E2E 测试**。
> 用例文档存放于 `docs/testing/plugins/<序号>-<插件名>.md`；测试代码存放于 `packages/<name>/test/`。

---

## 1. 宿主分层与测试策略

内置插件由两部分组成，运行于不同宿主：

| 部分 | 运行位置 | 提供宿主 | 生命周期 |
| --- | --- | --- | --- |
| `src/host/**` | `dsh web` 进程（Node） | Cordis 容器 + WebServer | 随 `dsh` 进程 |
| `src/client/**` | WebView 页面 | 前端 Bundle Slot 注册表 | 随页面 |

插件 E2E 包含两个真实宿主层，其价值定位如下：

* **dsh 宿主（默认选型）**：真实 `dsh web` 进程 + 真实浏览器页面。无需 Tauri 与桌面端二进制，具备**启动快、可并行、支持无头模式**的优势，为门禁测试的主要覆盖层。
* **桌面端宿主（补充选型）**：桌面端壳层嵌 dsh iframe。**仅用于依赖 Tauri 桥的插件**（如 `dsh-tauri-pet` 桌宠窗口、`dsh-tauri-worktree` native 能力、`dsh-tauri-ui` 壳层注入），复用 [desktop.test.md](./desktop.test.md) 的 WebdriverIO 通道。

---

## 2. 三层测试模型

| 层级 | 代码位置 | 驱动/运行器 | 断言对象 | 必选场景 |
| --- | --- | --- | --- | --- |
| **L1 单元测试** | `packages/<name>/src/**/*.test.ts` | Vitest (`unit` project) | 纯函数、路由 Handler、注册表契约 | 无条件必选 |
| **L2 插件宿主 E2E** | `packages/<name>/test/*.e2e.ts` | Vitest (`e2e` project) + Playwright API | 真实 `dsh web` 进程：路由响应、客户端挂载点、崩溃防护 | 每个产品可见插件 |
| **L3 桌面端宿主 E2E** | `test/e2e/specs/desktop/*.e2e.ts` | Vitest (`desktop` project) + WebdriverIO | 桌面端壳层 + 内嵌 dsh iframe | 仅依赖 Tauri 桥的插件 |

> **分工原则**：L1 允许 Mock 宿主；L2/L3 下游全真，仅允许 Mock 外部服务（网络、模型、时钟）。

---

## 3. 技术选型与运行机制

### 3.1 统一单运行器（Vitest Projects）

全仓**统一使用 Vitest 作为唯一测试运行器**，通过 `test.projects` 实现分层隔离：

* **命令隔离**：使用 `vitest --project unit` 或 `--project e2e` 指定层级；`pnpm test` 运行全部。
* **独立配置**：通过 `vitest.unit.config.ts` 与 `vitest.e2e.config.ts` (`defineProject`) 维护各自配置。
* **全局报告**：由根目录 `vitest.config.ts` 统一管理报告与覆盖率（Project 级不支持配置 Reporters）。
* **生命周期**：利用 Project 的 `globalSetup` 完成真实宿主的单次启停，通过 `project.provide()` 注入服务地址。
* **浏览器驱动**：L2 采用 **Playwright 库 API** (`chromium.launch()`) 驱动浏览器，不引入 Playwright Test Runner。

### 3.2 驱动搭配

* **L2（Playwright + Chromium）**：轻量无头、可并行、支持 Trace/Screenshot 追踪，兼顾速度与稳定性。
* **L3（WebdriverIO + `@wdio/tauri-service`）**：唯一支持驱动真实 WebView 的方案，专用于桌面端集成。
* **纯 Node (`node:test` / Vitest)**：仅用于**无 UI 插件**的 HTTP 路由覆盖。

---

## 4. 目录结构与命名规范

```text
packages/<name>/
├── src/**/*.test.ts          # L1 单元测试（保持原位）
├── test/
│   ├── *.e2e.ts              # L2 插件宿主 E2E（由 e2e project 匹配）
│   └── support/              # 插件专属 Fixture / Stub
test/e2e/
├── global-setup.ts           # e2e project 的 globalSetup（启动 dsh web 并传递地址）
├── support/dsh-host.ts       # 共享环境脚手架（Scratch DSH_HOME、挂载、启动、清理）
└── specs/desktop/*.e2e.ts    # L3 桌面端宿主 E2E
test/archive/*                # 历史用例归档（只读参考，不被任何 project 匹配）
vitest.config.ts              # 根配置：包含 Projects 清单与全局别名
vitest.unit.config.ts         # unit project 配置
vitest.e2e.config.ts          # e2e project 配置（插件 L2）
docs/testing/plugins/<name>.md # 插件测试文档

```

* **命名约定**：L2 文件必须使用 `*.e2e.ts`，与 L1 的 `*.test.ts` / `*.spec.ts` 严格区分。
* **匹配策略**：`unit` 匹配 `*.{test,spec}.*`（自动排他 `.e2e.ts`）；`e2e` 显式指定 `packages/*/test/**/*.e2e.ts`。
* **映射关系**：文档中的每条用例条目必须与代码中的 `test()` 一一对应。

---

## 5. L2 执行流程

执行 L2 测试前，必须先完成构建（`pnpm build:plugins`），E2E 测试仅针对构建产物运行。

```
1. 构建产物      ──> 执行 pnpm build:plugins（禁止直接测试 TS 源码）
2. 创建隔离环境  ──> 创建独立根 DSH_E2E_HOME=<tmp>/dsh-e2e-<suite>-<timestamp>；L2 的 DSH_HOME=<DSH_E2E_HOME>/dsh
3. 初始化 Profile──> 构建 <DSH_HOME>/profiles/web/{package.json, cordis.patch.yml, pnpm-workspace.yaml}
4. 挂载插件      ──> [link 模式] 自建软链接至 profile/node_modules + 配置 dsh.profile.bundles
                     [cli 模式]  执行 dsh plugin --profile web add link:<repo>/packages/<name>
5. 校验挂载      ──> 确认 dsh.profile.bundles 包含目标插件（未找到则立即报错抛出）
6. 启动服务      ──> 执行 dsh web --host 127.0.0.1 --port 0 --no-open --skip-auth
7. 解析端点      ──> 捕获日志中的 `http://127.0.0.1:<port>/?token=<...>` 并解析 URL
8. 执行测试      ──> 运行 vitest --project e2e，测试用例通过 inject() 提取服务地址
9. 资源回收      ──> 触发 Teardown：终止 dsh 进程树，清空临时目录

```

> **参数说明**：
> * `--skip-auth`：跳过浏览器一次性 Token 校验，避免误把“未鉴权”当作“路由丢失”。
> * `--profile`：`dsh web` 内置为 `--profile web` 别名，无需显式传参。
> * `fileParallelism`：`e2e` project 设置为 `false`，确保单实例下串行断言的稳定性。
> 
> 

---

## 6. 断言准则

### 必须断言项（底线要求）

1. **可见产物挂载**：
* **自渲染 DOM 插件**：根节点必须绑定 `data-dsh-<plugin>` 属性，断言其 `attached` / `visible`。
* **槽位/补丁注入插件**：断言对应宿主槽位产物（如设置分区标题、侧栏入口）正常呈现。


2. **零崩溃保证**：校验 `pageerror` 为空、插件错误条（`fail()` / `RenderBoundary`）为空、带插件前缀的 `console.error` 为空。
3. **路由真实响应**：直接向插件自有 HTTP 路由发起请求，断言状态码与响应体格式。

### 禁止项

* 严禁使用 CSS 类名、非稳定文案或 DOM 层级作为选择器（必须使用 `data-dsh-*`）。
* 严禁将“无报错”直接等同于“测试通过”，必须存在正向的产物断言。
* 严禁依赖上一次运行遗留的状态（每次运行必须是干净的 Scratch 环境）。

---

## 7. 依赖 Mock & Stub 规范

1. **优先使用真包**：环境支持安装时，优先使用真实依赖。
2. **Playwright 层不替身**：L2 运行于真实前端 Bundle 中，天然包含宿主依赖，无需 Stub。
3. **仅限 L1 单元测试替身**：在 Vitest 中通过 `resolve.alias` 将重量级包重定向至 `test/support/<pkg>-stub.ts`。Stub 必须与原包保持接口契约一致，并在文件头声明维护注释。

---

## 8. 渐进式推进路线

批次号 = `docs/testing/plugins/` 下的文档序号，完整清单见该目录 `00-overview.md` §3。

| 批次 | 目标插件 | 测试内容 | 对应层级 | 前置条件 |
| --- | --- | --- | --- | --- |
| **1** | 编排骨架 | 脚手架挂载 `dsh-tauri` 并成功启动 `dsh web` 随机端口 | L2 基础设施 | 无 |
| **2** | `dsh-tauri`（核心桥接） | 共享路由契约：OPTIONS / 405 / 403 / 413 | L2（纯 HTTP） | 1 |
| **3** | `dsh-tauri-pet` | SSE 路由 `/api/desktop/dsh-tauri-pet/session/stream` 建立连接并收到首帧 | L2（纯 HTTP） | 1 |
| **3** | `dsh-tauri-pet` | 页面成功渲染 `data-dsh-tauri-pet` 挂载点且无崩溃报错 | L2（浏览器） | 上一条 |
| **4+** | `04`–`18` | 先 Host 后 Client 逐条补齐；`18` 为跨插件与壳层集成收尾 | L2 → L3 | 逐项确认 |
| **L3** | `dsh-tauri-pet` | 桌面端壳层成功创建桌宠窗口 | **L3** | 桌面端 `01` 批次通道 |

**准入标准**：连续运行 $\ge 5$ 次无 Flake；失败信息精准定位至具体步骤；文档与 `test()` 一一对应；环境完全隔离独立。

---

## 9. 环境变量与运行命令

### 常用命令

```bash
pnpm test                 # 执行所有 Project
pnpm test:unit            # 仅执行 L1 单元测试
pnpm test:e2e:plugin      # 仅执行 L2 插件 E2E 测试（需先执行 pnpm build:plugins）

```

### 关键环境变量

| 环境变量 | 作用描述 | 默认值 / 回退策略 |
| --- | --- | --- |
| `DSH_E2E_HOME` | 本次运行独占的独立根，全部测试数据必须落在其下 | `<tmp>/dsh-e2e-<suite>-<timestamp>` |
| `DSH_E2E_DSH_BIN` | `dsh` 可执行入口路径 (`lib/bin.js`) | 自动解析包路径或回退至桌面端装配目录 |
| `DSH_E2E_NODE_BIN` | 执行 `dsh` 的 Node 二进制路径 | `process.execPath` |
| `DSH_E2E_PLUGIN` | `globalSetup` 指定挂载的目标插件 | `dsh-tauri-pet` |
| `DSH_E2E_MOUNT` | 插件挂载模式 (`link` 或 `cli`) | `link` |
| `DSH_E2E_KEEP_HOME` | 设置为 `1` 时保留独立根以便调试 | 未设置（自动清理） |

### 数据目录约束（强制）

**禁止**读写用户真实 `~/.dsh`、`~/.dsh.dev`，**禁止**读写 `%APPDATA%/io.github.hairyf.deepseek-harness-desktop` 下的真实目录。

* **L2**：`DSH_HOME` 一律指向 `<DSH_E2E_HOME>/dsh`；落在 `DSH_E2E_HOME` 之外的 profile 视为编排缺陷。
* **L3**：debug 构建的 `get_dsh_data_path` 恒为 `<home>/.dsh.dev` 且忽略 `DSH_HOME`（`src-tauri/src/config/runtime.rs:471`），应用数据目录另由 `app_data_dir()` 决定（`src-tauri/src/config/runtime.rs:17`）。因此启动应用前必须重定向两个根——`USERPROFILE`(Windows)/`HOME`(Unix) → `<DSH_E2E_HOME>/home`，`APPDATA`(Windows)/`XDG_DATA_HOME`(Unix) → `<DSH_E2E_HOME>/appdata`。
* **失败关闭**：脚手架在启动应用前必须断言解析出的 `data_dir` 与 app-data 根均位于 `DSH_E2E_HOME` 之下；不满足即 Fail，不得降级到真实目录。