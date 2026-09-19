# 编排骨架（批次 01）：真实 dsh 宿主能否被一行代码拉起

> 层级：L2 插件宿主 E2E（真实 `dsh web` 进程；无浏览器、无 Tauri）
> 自动化：`packages/dsh-tauri/test/host-lane.e2e.ts`（待建立；本文件是它的用例来源）
> 前置：`pnpm build:plugins` 已产出 `packages/*/dist`；`DSH_E2E_DSH_BIN` 或桌面端装配目录内存在 `@deepseek-ai/dsh/lib/bin.js`
> 编排：`test/e2e/support/dsh-host.ts`；全局生命周期：`test/e2e/global-setup.ts`
> 运行：`pnpm test:e2e:plugin`（= `vitest --project e2e`）

本批是全套插件用例的地基：**先证明编排本身可信**，再谈插件行为。若这里不成立，后面所有「插件路由 404」都无法区分是插件没挂上还是宿主没起来。

本批内复杂度梯度：**命中就绪判定** → **挂载校验失败** → **产物缺失失败** → **环境变量边界**。

---

## 1. 被测编排的真实行为（事实来源）

| 行为 | 代码位置 |
| --- | --- |
| `startDshHost({ plugin, also, keepHome })` 一行起宿主 | `test/e2e/support/dsh-host.ts:307` |
| scratch 目录：`<tmp>/dsh-e2e-<plugin>-<base36 时间戳>` | `test/e2e/support/dsh-host.ts:313` |
| profile 三件套（`package.json` / `cordis.patch.yml` / `pnpm-workspace.yaml`） | `test/e2e/support/dsh-host.ts:149` |
| 默认 bundle 列表＝`dsh-base` + `dsh-web-app` + 目标包 | `test/e2e/support/dsh-host.ts:316` |
| link 挂载（junction / dir symlink，离线）或 cli 挂载（`dsh plugin add`） | `test/e2e/support/dsh-host.ts:179`、`test/e2e/support/dsh-host.ts:237` |
| 挂载后必须出现在 `dsh.profile.bundles`，否则抛错 | `test/e2e/support/dsh-host.ts:335` |
| 产物预检：`main` 与 `exports["./client"]` 指向的文件必须存在 | `test/e2e/support/dsh-host.ts:127` |
| 启动命令：`dsh web --host 127.0.0.1 --port 0 --no-open --skip-auth` | `test/e2e/support/dsh-host.ts:352` |
| 就绪判定：从日志抓 `http://127.0.0.1:<port>...` 首个匹配 | `test/e2e/support/dsh-host.ts:36`、`test/e2e/support/dsh-host.ts:274` |
| 就绪上限 120s | `test/e2e/support/dsh-host.ts:39` |
| 收尾：Windows `taskkill /T /F`；其余 SIGTERM→SIGKILL | `test/e2e/support/dsh-host.ts:371`、`test/e2e/support/dsh-host.ts:255` |
| 地址下传：`project.provide('dshBaseUrl' / 'dshUrl' / 'dshHome' / 'dshMounted')` | `test/e2e/global-setup.ts:33` |
| project 归属：`packages/*/test/**/*.e2e.ts`，`fileParallelism: false`，超时 120s | `vitest.e2e.config.ts:15`、`vitest.e2e.config.ts:18` |

---

## 2. 用例

### [P1] 验证在隔离 scratch 目录下能挂载目标插件并拉起真实 dsh web

[Case ID] TC-HOST-L2-001
[层级] L2（真实 dsh 进程）
[类型] 正向
[追踪] `docs/specs/plugin.test.md` §8 批次 1；`test/e2e/support/dsh-host.ts:307`
[自动化] 是（`packages/dsh-tauri/test/host-lane.e2e.ts`）
[前置条件] `pnpm build:plugins` 已执行；`DSH_E2E_PLUGIN`（默认 `dsh-tauri-pet`）指向的包已构建；系统临时目录可写；`@deepseek-ai/dsh` 入口可解析
[测试数据] `DSH_E2E_PLUGIN=dsh-tauri`；`DSH_E2E_MOUNT=link`（默认）
[测试步骤] 1. 调用 `startDshHost({ plugin: 'dsh-tauri' })`。2. 读返回的 `url` / `baseUrl` / `home` / `mounted`。3. 对 `baseUrl` 发起 `GET /`。4. 读 `home/dsh-web.log` 末尾内容。
[预期结果] 1. `startDshHost` 在 120s 内 resolve，不抛错。2. `baseUrl` 形如 `http://127.0.0.1:<非 0 端口>`；`mounted` 精确包含 `dsh-tauri`；`home` 路径包含 `dsh-e2e-dsh-tauri-`。3. `GET /` 返回 2xx 且响应体非空。4. 日志内出现与 `url` 一致的就绪行，且未出现 `ERR_MODULE_NOT_FOUND`。
[清理] 用例结束（含失败）必须调用 `stop()`；断言 `home` 目录已被删除

### [P2] 验证宿主启动后目标插件的 bundle 已登记进 profile

[Case ID] TC-HOST-L2-002
[层级] L2（真实 dsh 进程）
[类型] 正向
[追踪] `test/e2e/support/dsh-host.ts:316`、`test/e2e/support/dsh-host.ts:199`
[自动化] 是（同上文件）
[前置条件] 同 TC-HOST-L2-001；未设置 `DSH_E2E_KEEP_HOME`
[测试数据] `DSH_E2E_PLUGIN=dsh-tauri`；`DSH_E2E_ALSO=dsh-tauri-pet`（制造「基础包 + 目标包」两段挂载）
[测试步骤] 1. 用上述环境启动宿主。2. 读 `home/profiles/web/package.json`。3. 取 `dsh.profile.bundles` 与 `dependencies`。
[预期结果] 1. 启动成功。2. `bundles` 同时包含 `dsh-tauri-pet` 与 `dsh-tauri`，且无重复项。3. `dependencies` 中两者的值均以 `link:` 开头并指向仓库 `packages/<name>`。
[清理] 同 TC-HOST-L2-001

### [P3] [反向] 验证挂载未登记进 bundles 时立刻失败，而不是带着半成品起服务

[Case ID] TC-HOST-L2-003
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `test/e2e/support/dsh-host.ts:335`
[自动化] 是（同上文件；用桩 profile 触发）
[前置条件] 手工构造只写了 `package.json` 与链接、但 `dsh.profile.bundles` 缺目标包的 profile；或直接调用内部校验分支
[测试数据] `bundles` 故意缺 `dsh-tauri-pet`
[测试步骤] 1. 以被篡改的 profile 触发挂载校验。2. 捕获抛出的错误文本。3. 检查 scratch 目录是否残留。
[预期结果] 1. 抛错，且错误文本包含 `挂载未注册到 dsh.profile.bundles` 与缺失包名。2. 不产生 `dsh web` 子进程（无就绪 URL）。3. scratch 目录被清理（`dsh-host.ts:340` 的 catch 分支）。
[清理] 无需额外清理

### [P3] [反向] 验证产物缺失时报出可操作的构建指引

[Case ID] TC-HOST-L2-004
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `test/e2e/support/dsh-host.ts:127`
[自动化] 是（同上文件；以未构建的包触发）
[前置条件] 选定一个 `packages/<name>/dist/index.js` 不存在的包（或临时重命名产物）
[测试数据] 未构建的包名，例如 `dsh-tauri-panel-scheduler`
[测试步骤] 1. 对其调用 `startDshHost`。2. 捕获错误文本。
[预期结果] 1. 抛错，文本包含「尚未构建」与 `pnpm build:plugins` 指引。2. 不进入 `dsh web` 启动阶段（无日志文件产生或日志为空）。
[清理] 恢复被重命名的产物

### [P4] 验证环境变量边界：`DSH_E2E_KEEP_HOME` 控制 scratch 去留

[Case ID] TC-HOST-L2-005
[层级] L2（真实 dsh 进程）
[类型] 边界
[追踪] `test/e2e/support/dsh-host.ts:376`、`test/e2e/global-setup.ts:31`
[自动化] 是（同上文件）
[前置条件] 可重复启动宿主两次（串行，`fileParallelism` 已为 false）
[测试数据] 第一轮不设 `DSH_E2E_KEEP_HOME`；第二轮设 `DSH_E2E_KEEP_HOME=1`
[测试步骤] 1. 第一轮启动后 `stop()`，检查 `home` 是否存在。2. 第二轮启动后 `stop()`，检查 `home` 是否存在。3. 手工删除第二轮目录。
[预期结果] 1. 第一轮 `home` 目录不存在（已清理）。2. 第二轮 `home` 目录仍存在，且 `dsh-web.log` 可读。3. 删除成功，无残留锁文件。
[清理] 删除第二轮 scratch 目录

### [P2] 验证 `DSH_E2E_MOUNT=cli` 走真实 CLI 挂载路径

[Case ID] TC-HOST-L2-006
[层级] L2（真实 dsh 进程）
[类型] 回归
[追踪] `test/e2e/support/dsh-host.ts:237`、`docs/specs/plugin.test.md` §5
[自动化] 是（同上文件）
[前置条件] 机器可联网、`pnpm` 可用；`DSH_E2E_PNPM_STORE_DIR` 可选指向本地 store
[测试数据] `DSH_E2E_MOUNT=cli`；`DSH_E2E_PLUGIN=dsh-tauri`
[测试步骤] 1. 以 cli 模式启动宿主。2. 读 `home/profiles/web/package.json`。3. 对 `baseUrl` 发起 `GET /`。
[预期结果] 1. 启动成功（允许明显长于 link 模式）。2. `dependencies` 由 `dsh plugin add` 写入，值指向仓库包路径而非自建链接。3. `GET /` 返回 2xx。
[清理] 同 TC-HOST-L2-001

---

## 3. 本批追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `docs/specs/plugin.test.md` §8 批次 1（骨架挂载 + 随机端口） | TC-HOST-L2-001、TC-HOST-L2-002 | 正向 | 未覆盖「随机端口是否真的每次不同」 |
| `docs/specs/plugin.test.md` §5 步骤 5（挂载校验） | TC-HOST-L2-003 | 异常 | 依赖内部校验分支的可触达性，可能需抽函数后才可测 |
| `docs/specs/plugin.test.md` §5 步骤 1（构建产物） | TC-HOST-L2-004 | 异常 | 会短暂移动产物，串行执行下安全 |
| `docs/specs/plugin.test.md` §9（`DSH_E2E_KEEP_HOME`） | TC-HOST-L2-005 | 边界 | 依赖可重复启动宿主 |
| `docs/specs/plugin.test.md` §5 挂载模式 `link`/`cli` | TC-HOST-L2-006 | 回归 | cli 模式需网络，不作为门禁必跑 |

---

## 4. 缺口与假设

- **假设**：`dsh-tauri` 可作为 bundle 独立挂载（它是其它插件的宿主能力提供方）。若它不能被单独挂载，TC-HOST-L2-001 改用 `dsh-tauri-pet` 作为目标包。
- **缺口**：`assertBuilt`（`dsh-host.ts:127`）当前不可从外部注入，TC-HOST-L2-004 需要临时移动产物或后续把该函数导出。
- **缺口**：本文件不覆盖「端口冲突」「宿主提前退出」分支（`dsh-host.ts:278` 已有错误路径），留待骨架跑稳后补。
- **未纳入范围**：浏览器渲染、Tauri 窗口、插件业务语义——分别属于 02 起的各插件文件与桌面端宿主层。
