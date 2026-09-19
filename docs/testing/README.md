# 测试文档索引

本目录是桌面端与内置插件的测试用例与推进台账的唯一入口。测试代码在 `test/` 与 `packages/*/test/`，本目录只放**规范、用例文档与进度**。

---

## 1. 文档索引

| 文档 | 内容 |
| --- | --- |
| [`../specs/desktop.test.md`](../specs/desktop.test.md) | 桌面端测试规范：分层、驱动选型、`data-testid`、环境隔离、执行命令 |
| [`../specs/plugin.test.md`](../specs/plugin.test.md) | 插件测试规范：L2/L3 宿主分层、真实挂载流程、断言准则、依赖替身规则 |
| [`progressive.md`](./progressive.md) | 推进规则与**进度台账**：单批单卡、审核阻塞、批次状态 |
| [`desktop/00-overview.md`](./desktop/00-overview.md) | 桌面端总览：环境事实、前置校验、数据目录隔离、追踪矩阵、缺口 |
| [`desktop/01-window-boot.md`](./desktop/01-window-boot.md) … [`29-system-integration.md`](./desktop/29-system-integration.md) | 桌面端用例，单文件即一个批次 |
| [`plugins/00-overview.md`](./plugins/00-overview.md) | 插件总览：分层策略、可立即运行的部分、追踪矩阵、缺口 |
| [`plugins/01-host-lane-skeleton.md`](./plugins/01-host-lane-skeleton.md) … [`18-cross-plugin-desktop.md`](./plugins/18-cross-plugin-desktop.md) | 插件用例，单文件即一个批次 |

**用例规模**：桌面端 29 个文件 / **273** 条；插件 18 个文件 / **170** 条。每个 `00-overview.md` 只承载总览与矩阵，不含用例本体。

---

## 2. 分层模型

| 层 | 用例位置 | 运行器 | 驱动 / 宿主 |
| --- | --- | --- | --- |
| **L1** 单元 | `packages/<name>/src/**/*.test.ts` | Vitest `unit` project | 无宿主，允许 Mock |
| **L2** 插件宿主 E2E | `packages/<name>/test/*.e2e.ts` | Vitest `e2e` project | 真实 `dsh web` 进程；需浏览器时用 Playwright 库 API |
| **L3** 桌面端宿主 E2E | `test/e2e/specs/desktop/*.e2e.ts` | Vitest `desktop` project | 真实 Tauri 窗口；WebdriverIO + `@wdio/tauri-service` |

全仓**只有一个测试运行器**（Vitest，通过 `test.projects` 分层）。WebdriverIO 与 Playwright 只作为**驱动库**被用例调用，不引入各自的 runner。

---

## 3. 目录约定

```
test/
├── unit/                     # L1 桌面端单元测试
├── e2e/
│   ├── global-setup.ts       # e2e project 生命周期：起停真实 dsh
│   ├── support/              # 共享编排与选择器常量
│   └── specs/desktop/        # L3 桌面端用例
├── archive/                  # 历史用例归档，任何 project 都不收
vitest.config.ts              # 根：projects 清单与全局别名
vitest.unit.config.ts
vitest.e2e.config.ts
vitest.desktop.config.ts
```

---

## 4. 运行命令

```bash
pnpm test                 # 全部 project
pnpm test:unit            # 仅单元（日常迭代）
pnpm test:e2e:plugin      # 仅插件 L2（需先 pnpm build:plugins）
vitest --project desktop -- <file>   # 单条 L3 用例
```

> 插件 L2 只对**构建产物**运行，未构建时 `dsh-host.ts` 会直接失败并提示要跑的命令，不静默跳过。

---

## 5. 环境隔离

| 层 | 隔离根 | 关键点 |
| --- | --- | --- |
| L2 | `DSH_E2E_HOME` | `DSH_HOME` 指向其下的 scratch profile，独立端口 |
| L3 | `$E2E_HOME` | 重定向 `USERPROFILE`/`HOME` 与 `APPDATA`（debug 构建忽略 `DSH_HOME`） |

**禁止**读写用户真实的 `~/.dsh`、`~/.dsh.dev` 与 `%APPDATA%/io.github.hairyf.deepseek-harness-desktop`。脚手架必须在启动前断言解析出的数据目录位于隔离根之下，不满足即 Fail，不降级到真实目录。端口或进程残留同样直接 Fail，**不自动强杀用户进程**。

---

## 6. 推进方式

1. 批次号 = 用例文档序号，一次只推进**一个**批次（单批单卡）。
2. 批内先写用例文档，再写测试代码，同批交付；文档条目与 `it()` 一一对应。
3. 每批必须可独立运行并给出确切命令；交付后**停下来**等人审查与实跑。
4. 失败就地修复，不带病推进。
5. 状态实时登记到 [`progressive.md`](./progressive.md) §4 台账。

用例编写口径（优先级、标题、步骤/预期编号对应、选择器）以两个 `../specs/*.test.md` 为准；e2e 一律用 `data-testid` 定位，禁止依赖 CSS 类名、文案与 DOM 层级。
