# 总览与前置（00）：桌面端插件测试用例集

> 层级：总览（不承载可执行用例本体）
> 规范来源：[插件 E2E 测试规范](../../specs/plugin.test.md)、[桌面端 E2E 测试规范](../../specs/desktop.test.md)
> 流程来源：[渐进式测试推进规则](../progressive.md)
> 状态：提案中（文档已提交，等待授权与运行验证）

---

## 1. 任务理解

- **被测对象**：仓库内置插件（`packages/*`）在两层真实宿主中的可观察行为，以及桌面端壳层对插件的装配结果。
- **两级宿主**（来自 `docs/specs/plugin.test.md` §2）：

| 层级 | 宿主 | 驱动方式 | 覆盖对象 |
| --- | --- | --- | --- |
| L2 插件宿主 E2E | 真实 `dsh web` 进程（+ 真实浏览器页面） | Vitest `e2e` project；HTTP 断言先行，浏览器断言待接线 | 宿主路由、客户端挂载点、崩溃防护 |
| L3 桌面端宿主 E2E | 真实 Tauri 窗口（`deepseek-harness-desktop.exe`） | Vitest `desktop` project + WebdriverIO（内嵌 WebDriver server） | 依赖 Tauri 桥的插件与壳层集成 |

- **纳入范围**：`packages/` 下 10 个产品可见插件、核心桥接包 `dsh-tauri`、编排骨架、插件生命周期治理（清单/监控、禁用启用、升级卸载、快照、预装引导、异常修复、档案与补丁隔离、内置插件自愈）。
- **不纳入范围**：`source/`（vendored dsh 核心）、`archive/`、`test/archive/`、上游核心自身的功能正确性；以及同构桌面端套件已覆盖的**界面层断言**（`../desktop/08`–`../desktop/11`、`../desktop/13`）。

**覆盖策略**：按「先证明地基、再证明插件自报产物、最后证明桌面端集成」推进；每条用例只断言外部可观察事实（HTTP 字节、DOM 标记、窗口集合），不接受插件自我报告。

---

## 2. 多源输入与冲突处理

| 来源 | 提供的规则 |
| --- | --- |
| `docs/specs/plugin.test.md` | L1/L2/L3 分层、批次 1–18 路线图、断言准则、环境变量表、L2 执行流程 |
| `docs/specs/desktop.test.md` | 用例文档字段与优先级口径、`data-testid` 规范、端口/数据目录隔离、目录归属 |
| `docs/testing/progressive.md` | 单批单卡、状态定义与台账位置 |
| 源码事实 | `packages/*/src/**`、`src/**`、`src-tauri/src/**`、`test/e2e/support/**` |
| 现有测试 | `test/e2e/plugins/session-stream.e2e.ts`（SSE 首帧已落地） |

**已记录的冲突与取舍**：

1. **用例文档目录**：`desktop.test.md` §3.2 写 `docs/testing/plugins/<插件名>.md`，`plugin.test.md` §4 写 `docs/testing/plugins/<name>.md`；两者一致。本次额外要求「从 00 编号开始」，故统一采用 `<序号>-<主题>.md`。
2. **优先级口径**：用例编写通用口径为 P0–P3，本仓规范为 P1–P5。**以本仓规范为准**（见 §4），不混用。
3. **L2 浏览器驱动**：`plugin.test.md` §3.2 指定 Playwright 库 API；当前 `package.json` 与 `pnpm-lock.yaml` 中均无 `playwright`（见 §8 缺口 G2），因此浏览器类用例在本套文档中保留设计，但标注为**未接线**。
4. **桌面端端口是否固定**：`desktop.test.md` §6 称 debug 固定 `3081`、不可动态修改；实现侧存在端口占用后递增的逻辑（`src-tauri/src/service/workflow/launch.rs:874`，`src-tauri/capabilities/default.json:4` 注释亦声明 port is NOT fixed）。**本套文档以「默认 3081 + 运行前实测空闲」为准**，不假设端口绝对不变（见 §8 G5）。
5. **插件客户端只在内嵌 frame 内生效**：`dsh-tauri`、`dsh-tauri-pet` 的 client 入口均有 `window.parent === window` 早退（`packages/dsh-tauri/src/client/apply.ts:29`、`packages/dsh-tauri-pet/src/client/index.ts:24`）。因此「客户端用例」必须构造 iframe 环境，不能在顶层页面断言槽位（见 §8 G6）。

---

## 3. 编号与文件清单（渐进顺序）

编号即推进顺序：编号越大，依赖越多、断言面越宽。

| 编号 | 文件 | 被测对象 | 主层级 | 对应批次 |
| --- | --- | --- | --- | --- |
| 00 | `00-overview.md` | 总览、前置、追踪矩阵 | — | — |
| 01 | `01-host-lane-skeleton.md` | 编排骨架（scratch 宿主 + 挂载 + 随机端口） | L2 | 批次 1 |
| 02 | `02-dsh-tauri-core.md` | 核心桥接包 `dsh-tauri` | L2 | 批次 2（本套新增） |
| 03 | `03-dsh-tauri-pet.md` | 桌宠插件（SSE → 客户端挂载 → 桌面端窗口） | L2 → L3 | 批次 3 |
| 04 | `04-dsh-tauri-rightclick.md` | 右键菜单与外部打开 | L2 → L3 | 批次 4+ |
| 05 | `05-dsh-tauri-session.md` | 会话归档与打开目录 | L2 → L3 | 批次 4+ |
| 06 | `06-dsh-tauri-worktree.md` | 工作树面板与路由 | L2 → L3 | 批次 4+ |
| 07 | `07-dsh-tauri-ui.md` | 壳层槽位注入（导航/侧栏/设置） | L2 → L3 | 批次 4+ |
| 08 | `08-dsh-tauri-panel-extension.md` | 扩展管理面板（技能 / MCP / 市场） | L2 → L3 | 批次 4+ |
| 09 | `09-dsh-tauri-panel-scheduler.md` | 定时任务面板 | L2 → L3 | 批次 4+ |
| 10 | `10-dsh-tauri-turnrewind.md` | 回合级回滚 | L2 → L3 | 批次 4+ |
| 11 | `11-dsh-tauri-model-config.md` | 模型配置 | L2 → L3 | 批次 4+ |
| 12 | `12-plugin-inventory-and-watch.md` | 插件清单真值、文件监控与事件推送 | L3 | 批次 4+ |
| 13 | `13-plugin-lifecycle-commands.md` | 禁用/启用/升级/卸载/快照的落盘副作用 | L3 | 批次 4+ |
| 14 | `14-preinstall-and-preset.md` | 预装引导、预设字段与指纹判定 | L3 | 批次 4+ |
| 15 | `15-plugin-error-and-recovery.md` | 异常落盘、日志定位、修复与安全模式 | L3 | 批次 4+ |
| 16 | `16-profile-and-patch-isolation.md` | 跨档案隔离与补丁层 / pnpm-workspace 治理 | L3 | 批次 4+ |
| 17 | `17-internal-plugins.md` | 内置插件离线物化、自愈与弃用清理 | L3 | 批次 4+ |
| 18 | `18-cross-plugin-desktop.md` | 跨插件共存、禁用与降级 | L3 | 批次 4+ |

> `dsh-tauri-bundle`、`dsh-tauri-tsdown` 是打包/构建工具包（无 `exports["./client"]`，见各自 `package.json`），不属于产品可见插件，不在本套用例范围。

---

## 4. 优先级定义（按仓规范）

| 优先级 | 含义 |
| --- | --- |
| P1 | 核心正向：插件在真实宿主里被用户看见/可用的主路径 |
| P2 | 基本正向：次要入口、幂等重复、可恢复路径 |
| P3 | 核心异常：拒绝、超时、缺少依赖、非法入参 |
| P4 | 边界：空值、极值、并发、环境变量边界 |
| P5 | 低频：跨平台差异、罕见组合 |

单条用例只变更**一个变量**；标题以「验证」开头，反向用例前缀 `[反向]`。

---

## 5. 全局前置与环境隔离

### 5.1 L2（可立即运行的部分）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 构建前置 | `pnpm build:plugins`（**当前 `packages/*/dist` 均不存在**） | `test/e2e/support/dsh-host.ts:127` |
| 入口解析 | `DSH_E2E_DSH_BIN` → PATH → 桌面端装配目录 | `test/e2e/support/dsh-host.ts:83` |
| Node 入口 | `DSH_E2E_NODE_BIN`（默认 `process.execPath`） | `test/e2e/support/dsh-host.ts:106` |
| 目标插件 | `DSH_E2E_PLUGIN`（默认 `dsh-tauri-pet`） | `test/e2e/global-setup.ts:29` |
| 附加挂载 | `DSH_E2E_ALSO`（逗号分隔） | `test/e2e/global-setup.ts:30` |
| 挂载模式 | `DSH_E2E_MOUNT=link`（默认）/ `cli` | `test/e2e/support/dsh-host.ts:322` |
| 保留现场 | `DSH_E2E_KEEP_HOME=1` | `test/e2e/global-setup.ts:31` |
| 运行 | `pnpm test:e2e:plugin`（= `vitest --project e2e`） | `package.json:21` |
| 隔离 | 每次运行独占 `<tmp>/dsh-e2e-<plugin>-<时间戳>`，不触碰用户真实 `DSH_HOME` | `test/e2e/support/dsh-host.ts:313` |

---

## 6. 建议执行顺序

1. **冒烟子集**（最小可信集）：`01` 全部 → `02` 全部 → `03` 的 `TC-PET-L2-001` / `TC-PET-L2-002`。
2. **核心扩展（L2 可立即运行）**：`04`–`11` 中全部 `-L2-*` 用例；每条只依赖 `pnpm build:plugins` 与 scratch 宿主。
3. **桌面端集成**：`03`、`04`、`06`、`07`、`18` 的 `-L3-*` 用例（需先补 `data-testid` 与 `desktop` project，见 §8 G3/G4）。
4. **客户端渲染层**：全部 `-C-*` 用例（需先引入浏览器驱动，见 §8 G2）。
5. **需真实会话/凭据的用例**：`07` 的 `TC-UI-L2-003/004`、`10` 的 undo 业务码、`11` 的端点探测成功路径（见 §8 G9）。
6. **治理批次**：`12` → `13` → `14` → `15` → `16` → `17`。
7. **跨插件集成**：`18`。

---

## 7. 追踪矩阵

### 7.1 文件 → 用例编号

| 文件 | Case ID 前缀 | 条数 | 层级分布 |
| --- | --- | --- | --- |
| `01-host-lane-skeleton.md` | `TC-HOST-L2-*` | 6 | L2 |
| `02-dsh-tauri-core.md` | `TC-CORE-L2-*` | 6 | L2 |
| `03-dsh-tauri-pet.md` | `TC-PET-L2-*` / `-C-*` / `-L3-*` | 13 | L2 → L3 |
| `04-dsh-tauri-rightclick.md` | `TC-RC-L2-*` / `-C-*` / `-L3-*` | 11 | L2 → L3 |
| `05-dsh-tauri-session.md` | `TC-SESS-L2-*` / `-C-*` / `-L3-*` | 11 | L2 → L3 |
| `06-dsh-tauri-worktree.md` | `TC-WT-L2-*` / `-C-*` / `-L3-*` | 10 | L2 → L3 |
| `07-dsh-tauri-ui.md` | `TC-UI-L2-*` / `-C-*` / `-L3-*` | 10 | L2 → L3 |
| `08-dsh-tauri-panel-extension.md` | `TC-EXT-L2-*` / `-C-*` / `-L3-*` | 13 | L2 → L3 |
| `09-dsh-tauri-panel-scheduler.md` | `TC-SCH-L2-*` / `-C-*` / `-L3-*` | 11 | L2 → L3 |
| `10-dsh-tauri-turnrewind.md` | `TC-REW-L2-*` / `-C-*` / `-L3-*` | 8 | L2 → L3 |
| `11-dsh-tauri-model-config.md` | `TC-MC-L2-*` / `-C-*` / `-L3-*` | 9 | L2 → L3 |
| `12-plugin-inventory-and-watch.md` | `TC-INV-L3-*` | 8 | L3 |
| `13-plugin-lifecycle-commands.md` | `TC-LIFE-L3-*` | 12 | L3 |
| `14-preinstall-and-preset.md` | `TC-PRE-L3-*` | 9 | L3 |
| `15-plugin-error-and-recovery.md` | `TC-REC-L3-*` | 9 | L3 |
| `16-profile-and-patch-isolation.md` | `TC-ISO-L3-*` | 8 | L3 |
| `17-internal-plugins.md` | `TC-INT-L3-*` | 8 | L3 |
| `18-cross-plugin-desktop.md` | `TC-XP-L3-*` / `TC-XP-L2-001` | 8 | L2 + L3 |

合计 **170** 条。`-C-*` 表示客户端浏览器层（当前未接线），`-L3-*` 表示桌面端宿主层（当前待接线）。

### 7.2 关键来源 → 覆盖位置

| 来源条目 | 覆盖文件 | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `plugin.test.md` §5（L2 执行流程 1–9 步） | `01` | 正向 / 异常 / 边界 | 端口冲突、宿主提前退出分支未覆盖 |
| `plugin.test.md` §6（必须断言项、禁止项） | `02`–`11` | 正向 / 异常 | 「零崩溃」需浏览器层，见 G2 |
| `plugin.test.md` §8 批次 3（pet） | `03` | 正向 / 异常 | 客户端渲染用例依赖 Playwright |
| `plugin.test.md` §8 批次 4+（worktree） | `06` | 正向 / 异常 | 真实 git 创建链路未覆盖 |
| `plugin.test.md` §8 批次 4+（其余插件） | `04`、`05`、`07`–`11` | 正向 / 异常 / 边界 | 各文件末节列出未覆盖分支 |
| 归档 `06-plugin/01`（列表与监控） | `12` | 正向 / 异常 / 边界 | 界面层由 `../desktop/09` 承接 |
| 归档 `06-plugin/02`（升级与卸载） | `13` | 正向 / 异常 | 界面层由 `../desktop/09` 承接 |
| 归档 `06-plugin/04`、`01-install/04`（预装引导） | `14` | 正向 / 异常 / 边界 | 界面层由 `../desktop/08` 承接 |
| 归档 `06-plugin/03`、`01-install/05`（异常与恢复） | `15` | 正向 / 异常 / 边界 | 界面层由 `../desktop/10`、`../desktop/11` 承接 |
| 归档 `05-profile/05`、`06-plugin/03`（档案与补丁治理） | `16` | 正向 / 异常 / 边界 | 权限类分支标为手工 |
| `src-tauri/resources/README.md:76`（内置插件随包分发与自愈） | `17` | 正向 / 异常 / 边界 | 归档套件无对应用例 |
| `desktop.test.md` §5（`data-testid`） | 全部 L3 用例 | 前置约束 | 壳层当前 0 个 `data-testid`，见 G3 |
| `desktop.test.md` §6（端口/目录隔离） | `01`、`12`、`16`、`18` | 边界 | 端口「固定」表述与实现冲突，见 G5 |
| `progressive.md` §1（单批单卡） | 全部文件 | 流程约束 | 每个编号文件视为一个批次 |

### 7.3 高风险路径的正向 / 异常 / 边界覆盖

| 高风险路径 | 正向 | 异常 | 边界 |
| --- | --- | --- | --- |
| 宿主编排（挂载 + 启动） | TC-HOST-L2-001 | TC-HOST-L2-003、TC-HOST-L2-004 | TC-HOST-L2-005 |
| 共享路由契约 | TC-CORE-L2-001、TC-CORE-L2-002 | TC-CORE-L2-003、TC-CORE-L2-004、TC-CORE-L2-006 | TC-CORE-L2-005 |
| 桌面端窗口与启动 | TC-XP-L3-001、TC-XP-L3-007 | TC-XP-L3-003、TC-XP-L3-005 | TC-XP-L3-004、TC-XP-L3-006 |
| 插件路由真实响应 | 各文件 L2 正向 | 各文件 L2 异常 | 各文件 L2 边界 |
| 客户端挂载产物 | 各文件 `-C-001` | 各文件 `-C-003`/`-C-004` | 各文件 `-C-002`/`-C-004` |
| 清单真值与事件 | TC-INV-L3-001、TC-INV-L3-002、TC-INV-L3-004 | TC-INV-L3-006 | TC-INV-L3-003、TC-INV-L3-005、TC-INV-L3-007、TC-INV-L3-008 |
| 插件写操作 | TC-LIFE-L3-001、TC-LIFE-L3-005、TC-LIFE-L3-007、TC-LIFE-L3-009 | TC-LIFE-L3-002、TC-LIFE-L3-003、TC-LIFE-L3-004、TC-LIFE-L3-006、TC-LIFE-L3-008、TC-LIFE-L3-010 | TC-LIFE-L3-011 |
| 预装引导 | TC-PRE-L3-003、TC-PRE-L3-005 | TC-PRE-L3-004、TC-PRE-L3-007 | TC-PRE-L3-002、TC-PRE-L3-006、TC-PRE-L3-008、TC-PRE-L3-009 |
| 异常定位与修复 | TC-REC-L3-001、TC-REC-L3-003、TC-REC-L3-004、TC-REC-L3-006 | TC-REC-L3-007、TC-REC-L3-008 | TC-REC-L3-002、TC-REC-L3-005、TC-REC-L3-009 |
| 档案与补丁隔离 | TC-ISO-L3-001、TC-ISO-L3-002、TC-ISO-L3-003、TC-ISO-L3-005、TC-ISO-L3-008 | TC-ISO-L3-006、TC-ISO-L3-007 | TC-ISO-L3-004 |
| 内置插件自愈 | TC-INT-L3-001、TC-INT-L3-003、TC-INT-L3-006 | TC-INT-L3-002、TC-INT-L3-004 | TC-INT-L3-005、TC-INT-L3-007、TC-INT-L3-008 |

---

## 8. 缺口与假设

| 编号 | 类型 | 内容 | 影响 |
| --- | --- | --- | --- |
| G1 | 事实 | `packages/*/dist` **全部不存在**，`assertBuilt` 会先失败 | L2 用例在 `pnpm build:plugins` 之前一律不可运行 |
| G2 | 缺口 | `playwright` 未出现在 `package.json` / `pnpm-lock.yaml` / `node_modules`，与 `plugin.test.md` §3.2 的 L2 浏览器方案冲突 | 客户端渲染类用例（全部 `-C-*`）只能给出设计，标记「未接线」 |
| G3 | 缺口 | 壳层（`src/`）`data-testid` 数量为 **0**，且 `test/e2e/support/selectors.ts` 不存在，而 `desktop.test.md` §5 要求 E2E 必须用 `data-testid` | 所有 L3 用例需先随用例补 `data-testid`；当前 L3 选择器暂用 `aria-label` / slot id / 插件前缀 class |
| G4 | 缺口 | `desktop` project 尚未配置（无 `vitest.desktop.config.ts`、无 `test:e2e:desktop` 脚本、`test/e2e/specs/` 不存在） | L3 用例标注 `[自动化] 待接线`，不得写成可直接运行的 `it()` |
| G5 | 冲突 | `desktop.test.md` §6 称 debug 端口固定 `3081` 不可改；实现存在占用递增逻辑 | 全部 L3 用例的端口前置按「实测空闲」执行，不假设端口恒定 |
| G6 | 事实 | 插件 client 入口仅在内嵌 frame 内生效（`window.parent !== window`） | 所有 `-C-*` 与 `-L3-*` 用例必须构造 iframe 环境；顶层页面断言槽位必然失败 |
| G7 | 假设 | 各插件可被单独挂载（`DSH_E2E_PLUGIN=<pkg>`）；需要核心桥时通过 `DSH_E2E_ALSO=dsh-tauri` 一并挂载 | 若某插件强依赖其它插件，需在其文件中追加 `also` 说明 |
| G8 | 缺口 | `test/e2e/.artifacts/` 仅有文档约定与 `.gitignore`，无实现 | 失败产物（截图 / stdout）需在接线时补齐，否则失败定位只能依赖日志 |
| G9 | 缺口 | 会话类用例（`10` turnrewind、`07` ui 的部分分支）需要真实会话，scratch 宿主当前无造会话手段 | 相关用例标记「待补」，是本套文档最大的功能盲区 |
| G10 | 事实 | 插件写操作类用例（`13`、`14`、`16`、`17`）会真实改写档案文件；`17` 还会改写**应用资源目录** | 用例结束必须恢复原状，未恢复即判失败 |
| G11 | 分歧 | 归档套件引用的预设插件（`dshmarket`、`dsh-better-sidebar`、`dsh-notification`、`dsh-win-terminal-inspector`）与现行 `preset-plugins.json`（3 条）不一致，且其中 4 个包已进入 `deprecated-plugins.json` | `14` 的用例一律以**运行时清单内容**为准，不硬编码归档包名 |
| G12 | 缺口 | 事件类断言的读取通道未定：iframe 只能调 `dsh://tauri:invoke` 白名单内的 9 条命令，无法在页面内订阅 `dsh-plugins-updated` / `preinstall-log` 等事件 | `12`、`14` 的事件计数需由壳层测试侧记录后再回读，接线方式待定 |
| G13 | 缺口 | 系统级前置无法在页面内构造：目录不可写（`16` TC-ISO-L3-007）、非 Windows 平台（`14` TC-PRE-L3-002） | 相关用例标 `[自动化] 否（手工）` 或按平台跳过，不写成 `it()` |

---

## 9. 维护规则

1. 每条用例条目与测试代码 `it()` **1:1 对应**；改文档必改代码，反之亦然（`plugin.test.md` §4）。
2. 状态变更实时登记到 `docs/testing/progressive.md` §4.2 台账，禁止滞后补记。
3. 新增 L3 用例必须同步补 `data-testid`，并登记到 `test/e2e/support/selectors.ts`（`desktop.test.md` §5）。
4. 单文件即单批次，未验证通过前不得推进到下一个编号。
