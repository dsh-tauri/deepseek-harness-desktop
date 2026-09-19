# 总览与前置（00）：桌面端测试用例集

> 层级：总览（不承载可执行用例本体）
> 规范来源：[E2E 测试规范](../../specs/desktop.test.md)、[桌面端开发规范](../../specs/agents.desktop.md)
> 流程来源：[渐进式测试推进规则](../progressive.md)
> 同构套件：[插件用例集](../plugins/00-overview.md)
> 状态：批次日进行中——`00` 总览已落地，`01`–`29` 用例文档待接线（见 §8 G2/G3/G4）

---

## 1. 任务理解

- **被测对象**：`deepseek-harness-desktop` 桌面端（`src/` React 壳层 + `src-tauri/` Tauri 宿主）在**真实 Debug 二进制**上的可观察行为。
- **唯一层级**：本套全部为 L3（真实 Tauri 窗口）。按 `desktop.test.md` §2.2，纯 UI 组件渲染与交互归 Browser Mode 或单元测试，**不得**进入本套；涉及进程、端口、文件落盘、系统托盘的断言**必须**走真实层。
- **纳入范围**：窗口与壳层、配置面板四个分页、服务生命周期、插件装配与异常修复、预装引导、核心版本、备份还原、更新、桌宠、托盘、多窗口。
- **不纳入范围**：内置插件自身行为（归 [插件用例集](../plugins/00-overview.md)）、`source/`（vendored dsh 核心）、`archive/`、`test/archive/`、DSH 引擎内部实现。

**覆盖策略**：按「先证明能起来、再证明能看见、最后证明能改且改错了有反馈」推进；编号即批次顺序，`01`–`06` 与 `desktop.test.md` §7 路线图（批次 1–7）严格对齐。每条用例只断言外部可观察事实（窗口集合、DOM 标记、进程状态、落盘结果、提示文案），不接受组件自我报告。

---

## 2. 多源输入与冲突处理

| 来源 | 提供的规则 |
| --- | --- |
| `docs/specs/desktop.test.md` | 用例文档字段与优先级口径、`data-testid` 规范、端口/数据目录隔离、目录归属、批次 1–7 路线图 |
| `docs/specs/agents.desktop.md` | 架构事实（端口/数据目录隔离、插件宿主边界、桌宠模块）、已登记 issue 号（#91/#214/#303/#386/#399/#469/#524/#525/#526/#539/#581/#591/#596） |
| `docs/testing/progressive.md` | 单批单卡、状态定义与台账位置 |
| `docs/testing/plugins/*` | 用例文档的实际格式基线（字段集、`### [P1]` 层级、`[Case ID]` 命名、事实基线/追踪矩阵/缺口三节） |
| 源码事实 | `src/**`、`src-tauri/src/**`、`test/e2e/support/**` |
| 现有测试 | `src/pet/hooks/use-bubble-tracker.test.ts`（L1）；`test/e2e/support/wdio-probe.mjs`（L3 探针） |

**已记录的冲突与取舍**：

1. **用例字段与标题层级**：`desktop.test.md` §4 的示例为 `## [P1] 验证…` + `[层级]/[自动化]/[前置条件]/[测试步骤]/[预期结果]`；`docs/testing/plugins/` 既有套件实际使用 `### [P1]` + `[Case ID]`/`[类型]`/`[追踪]`/`[清理]`。**本套以套件一致性优先**，字段集是 §4 的**超集**（§4 要求的五个字段全部保留），并保留 §4 的 P1–P5 口径。
2. **反向标记位置**：`desktop.test.md` §4 同时要求「标题以『验证』开头」与「反向用例标注 `[反向]`」，两条在字面上互斥。**本套采用 `### [P3] [反向] 验证…`**（对齐插件套件），未满足「以验证开头」的字面要求。
3. **用例文档目录**：`desktop.test.md` §3.2 写 `docs/testing/desktop/<序号>-<测试项>.md`，未定义 `00` 的用途。本次要求「从 00 编号开始」，**`00` 用作总览**（对齐插件套件），用例本体从 `01` 起，`01`–`06` 文件名与 §7 路线图逐字一致。
4. **端口是否固定**：`desktop.test.md` §6 称 Debug 固定 `3081`、不可动态修改；实现侧存在占用后逐级递增（`src-tauri/src/service/workflow/launch.rs:66`）且 `src-tauri/capabilities/default.json:4` 明示 port is NOT fixed。**本套以「默认 3081 + 运行前实测空闲」为准**，不假设端口绝对不变（见 §8 G5）。
5. **优先级口径**：用例编写通用口径为 P0–P3，本仓规范为 P1–P5。**以本仓规范为准**（见 §4），不混用。
6. **`data-testid` 前置**：`desktop.test.md` §5 要求 E2E 必须用 `data-testid`；壳层（`src/`）当前 `data-testid` 数量为 **0**。因此本套全部用例标注 `[自动化] 待接线`，并在每个文件末尾给出「选择器契约（待补）」（见 §8 G3）。
7. **E2E 是否允许 Mock 后端**：`desktop.test.md` §1 禁止在 E2E 层 Mock 后端命令。本套中「构造失败态」一律通过**真实前置**达成（改坏 `cordis.patch.yml`、占用端口、指向不可达更新源），不引入命令级 Mock。

---

## 3. 编号与文件清单（渐进顺序）

编号即推进顺序：编号越大，依赖越多、断言面越宽。`01`–`06` 与 `desktop.test.md` §7 路线图（批次 1–7）对应。

| 编号 | 文件 | 被测对象 | 对应路线图 |
| --- | --- | --- | --- |
| 00 | `00-overview.md` | 总览、前置、追踪矩阵 | — |
| 01 | `01-window-boot.md` | 主窗口建立、标题、几何约束、壳层根节点、启动前置校验 | 批次 1 / 2 |
| 02 | `02-shell-navigation.md` | 导航栏三个下拉菜单、侧边栏开关、拖拽区、条件渲染 | 批次 3 |
| 03 | `03-config-dialog.md` | 配置对话框打开/定位/切换/关闭、插件角标、命令式收起 | 批次 4 |
| 04 | `04-locale-theme.md` | 语言即时切换与持久化、主题自适应 | 批次 5 |
| 05 | `05-profile.md` | 档案列表、新建、切换、克隆、删除 | 批次 6 |
| 06 | `06-harness-embed.md` | iframe 渲染条件、加载完成/失败、重试、boot 桥 | 批次 7 |
| 07 | `07-harness-lifecycle.md` | 服务重启/停止/外部打开、进程意外退出、重复触发收敛 | — |
| 08 | `08-preinstall-onboarding.md` | 预装引导页、默认勾选、安装/取消/失败 | — |
| 09 | `09-plugin-panel.md` | 插件列表与标记、升级/禁用/启用/快照/还原/卸载 | — |
| 10 | `10-plugin-recovery.md` | 启动崩溃全屏恢复页、运行期异常对话框、快照还原 | — |
| 11 | `11-startup-error.md` | 非插件类启动失败错误页、针对性提示、恢复动作 | — |
| 12 | `12-window-tray.md` | 窗口按钮、托盘菜单、退出语义、几何持久化 | — |
| 13 | `13-application-settings.md` | 端口、缩放、语言、开机自启、关闭行为、CLI link、日志 | — |
| 14 | `14-core-management.md` | 核心列表、切换、下载、卸载、本地核心更新与基线 | — |
| 15 | `15-backup-restore.md` | 备份子视图、创建、还原、还原为新档案、删除 | — |
| 16 | `16-update.md` | 桌面端自更新检测、提示、对话框、破坏性更改确认 | — |
| 17 | `17-pet-window.md` | 桌宠窗口创建/销毁、置顶与穿透、几何、尺寸、失败提示 | — |
| 18 | `18-notification-download.md` | 通知桥、下载落盘与完成提示、剪贴板图片回退 | — |
| 19 | `19-multi-window.md` | 第二窗口与隔离、缩放快捷键与桥、导航命令下发 | — |
| 20 | `20-assembly.md` | 首次装配、任务编排、进度阶段、复用/跳过、下载失败与完整性校验 | — |
| 21 | `21-cli-integration.md` | shim 生成与 PATH 注册、转义规则、解析优先级、用户命令保护 | — |
| 22 | `22-isolation.md` | 端口默认值与占用回退、子进程启动、数据目录与残留清扫隔离 | — |
| 23 | `23-privacy.md` | 本地监听边界、无遥测与最小暴露、日志与支持包、路径守卫 | — |
| 24 | `24-profile-rules.md` | 档案名称规范化、创建/克隆校验、初始化形态与幂等、档案隔离 | — |
| 25 | `25-core-error-matrix.md` | 核心标识与查找、切换与回滚、下载/卸载错误码矩阵 | — |
| 26 | `26-service-state-machine.md` | 状态迁移与事件、健康检查与就绪、进程韧性与孤儿清扫 | — |
| 27 | `27-plugin-lifecycle.md` | 插件升级/卸载/禁用/快照、异常注册表、恢复、内置插件自愈、文件监控 | — |
| 28 | `28-desktop-update-internals.md` | 静默下载、退出自动安装、版本护栏、更新摘要与路径守卫 | — |
| 29 | `29-system-integration.md` | 系统操作集成、路径守卫、跨平台打包、Windows 极简模式、工作区自愈 | — |

合计 **29 个用例文件、273 条用例**（`00` 不承载用例本体）。

---

## 4. 优先级定义（按仓规范）

| 优先级 | 含义 |
| --- | --- |
| P1 | 核心正向：失败即应用不可用（启动、服务起来、配置能开、语言能切、档案能建、iframe 能挂） |
| P2 | 基本正向：主要功能与可恢复路径 |
| P3 | 核心异常：错误路径的反馈必须正确且可见 |
| P4 | 边界：空值、极值、单例约束、平台差异 |
| P5 | 低频：影响面小，可手工替代 |

单条用例只变更**一个变量**；标题以「验证」开头，反向用例前缀 `[反向]`。

---

## 5. 全局前置与环境隔离

### 5.1 环境事实

| 项 | 值 | 来源 |
| --- | --- | --- |
| 应用二进制 | `src-tauri/target/debug/deepseek-harness-desktop.exe` | `src-tauri/Cargo.toml:2` |
| 前端产物 | `dist/`（缺失时 cargo 构建无法嵌入前端） | `src-tauri/tauri.conf.json:10` |
| 应用端口 | Debug 默认 `3081`（Release `3080`）；被占用时逐级递增 | `src-tauri/src/config/constants.rs:50`、`:53`、`src-tauri/src/service/workflow/launch.rs:66` |
| 数据目录 | Debug 恒为 `<home>/.dsh.dev`，Store 为 `.store.dev.dat`；**测试中 `<home>` 必须被重定向到 `$E2E_HOME/home`**（见 §5.3） | `src-tauri/src/config/runtime.rs:471`、`:482`；`src-tauri/src/config/setting.rs:191` |
| 窗口标题 | `Deepseek Harness Desktop` | `src-tauri/src/desktop/builder.rs:484` |
| 窗口初始/最小尺寸 | `1280×840` / `860×620` | `src-tauri/src/desktop/builder.rs:485`、`:486` |
| 壳层导航栏高度 | `44`（`SHELL_NAV_HEIGHT`，与 `h-11` 同真值） | `src-tauri/src/desktop/builder.rs:44`、`src/layout/components/navbar.tsx:347` |
| WebDriver 端口 | `TAURI_WEBDRIVER_PORT`（现有探针用 `4445`） | `test/e2e/support/wdio-probe.mjs:128` |
| 就绪探针 | `GET /status` → `{ value: { ready: true } }` | `test/e2e/support/wdio-probe.mjs:73` |
| 建会话 | `POST /session { capabilities: {} }` → `value.sessionId` | `test/e2e/support/wdio-probe.mjs:90` |
| 窗口句柄断言 | `GET /session/<id>/window/handles` → `["main"]` | `test/e2e/support/wdio-probe.mjs:140` |
| 收尾 | `DELETE /session/<id>`，再按进程树结束应用 | `test/e2e/support/wdio-probe.mjs:143`、`:100` |
| 内嵌界面地址 | `http://127.0.0.1:<port>?t=<时间戳>`，**不含 token** | `src/store/modules/harness/utils.ts:37` |
| 失败产物目录 | `test/e2e/.artifacts/`（Git Ignore） | `docs/specs/desktop.test.md` §8.3 |
| 运行命令 | `vitest --project desktop -- <file>`（`desktop` project **尚未配置**） | `vitest.config.ts`、`docs/specs/desktop.test.md` §8.2 |

### 5.2 前置校验行为（测试侧必须实现，不属用例本体）

| 校验 | 期望行为 |
| --- | --- |
| 二进制存在且可执行 | 不存在即 Fail，不尝试构建 |
| 端口空闲 | 按「默认 3081 + 实测空闲」判定；被占用即 Fail |
| 无残留桌面实例 | 按进程名匹配；存在残留即 Fail，**不自动强杀用户进程** |
| 数据目录归属 | 解析出的 `data_dir` 与 app-data 根必须落在 `$E2E_HOME` 之下 |
| 收尾 | 每个 Spec 结束主动关闭应用并等待平滑退出；异常残留由脚本自行清理 |

### 5.3 数据目录隔离

以 `docs/specs/desktop.test.md` §6 为准。本目录用例中的所有数据路径均为 `$E2E_HOME` 之下的相对简写：

| 简写 | 实际路径 |
| --- | --- |
| `~/.dsh.dev` | `$E2E_HOME/home/.dsh.dev` |
| `~/.dsh` | `$E2E_HOME/home/.dsh` |
| `AppData/` | `$E2E_HOME/appdata/io.github.hairyf.deepseek-harness-desktop/` |

### 5.4 平台约定

未在用例 `[前置条件]` 中限定平台的用例，默认在 **Windows（WebView2）** 上执行。macOS 专属（交通灯、原生菜单、`WKWebView` 缩放能力）与 Linux 专属（`linux_tray.rs` 托盘）用例逐条标注平台。

---

## 6. 建议执行顺序

1. **冒烟子集**（最小可信集）：`01` 全部 → `03` 的 `TC-DSK-L3-018` → `06` 的 `TC-DSK-L3-039`。
2. **壳层基础**：`02`、`04`、`05`、`12`。
3. **服务与插件主线**：`07`、`08`、`09`、`10`、`11`。
4. **写操作与恢复**：`13`、`14`、`15`、`16`。
5. **独立窗口与系统表面**：`17`、`18`、`19`。
6. **需真实外部条件的用例**：`14` 的下载/更新、`16` 的更新检查、`17` 的桌宠资源（见 §8）。

---

## 7. 追踪矩阵

### 7.1 文件 → 用例编号

| 文件 | Case ID 区间 | 条数 | 类型分布（正向 / 异常 / 边界 / 低频） |
| --- | --- | --- | --- |
| `01-window-boot.md` | `TC-DSK-L3-001` – `008` | 8 | 3 / 2 / 3 / 0 |
| `02-shell-navigation.md` | `009` – `017` | 9 | 5 / 2 / 1 / 1 |
| `03-config-dialog.md` | `018` – `024` | 7 | 4 / 2 / 1 / 0 |
| `04-locale-theme.md` | `025` – `030` | 6 | 3 / 1 / 2 / 0 |
| `05-profile.md` | `031` – `038` | 8 | 3 / 3 / 2 / 0 |
| `06-harness-embed.md` | `039` – `045` | 7 | 4 / 2 / 1 / 0 |
| `07-harness-lifecycle.md` | `046` – `052` | 7 | 4 / 1 / 2 / 0 |
| `08-preinstall-onboarding.md` | `053` – `061` | 9 | 5 / 3 / 1 / 0 |
| `09-plugin-panel.md` | `062` – `071` | 10 | 5 / 4 / 1 / 0 |
| `10-plugin-recovery.md` | `072` – `078` | 7 | 4 / 1 / 2 / 0 |
| `11-startup-error.md` | `079` – `086` | 8 | 3 / 3 / 2 / 0 |
| `12-window-tray.md` | `087` – `094` | 8 | 5 / 1 / 2 / 0 |
| `13-application-settings.md` | `095` – `104` | 10 | 5 / 2 / 3 / 0 |
| `14-core-management.md` | `105` – `112` | 8 | 3 / 3 / 2 / 0 |
| `15-backup-restore.md` | `113` – `120` | 8 | 3 / 3 / 2 / 0 |
| `16-update.md` | `121` – `127` | 7 | 4 / 2 / 1 / 0 |
| `17-pet-window.md` | `128` – `134` | 7 | 4 / 1 / 1 / 1 |
| `18-notification-download.md` | `135` – `141` | 7 | 3 / 2 / 2 / 0 |
| `19-multi-window.md` | `142` – `148` | 7 | 4 / 1 / 2 / 0 |
| `20-assembly.md` | `149` – `162` | 14 | 6 / 6 / 2 / 0 |
| `21-cli-integration.md` | `163` – `174` | 12 | 5 / 3 / 4 / 0 |
| `22-isolation.md` | `175` – `186` | 12 | 7 / 1 / 4 / 0 |
| `23-privacy.md` | `187` – `195` | 9 | 5 / 1 / 3 / 0 |
| `24-profile-rules.md` | `196` – `207` | 12 | 3 / 4 / 4 / 1 |
| `25-core-error-matrix.md` | `208` – `221` | 14 | 2 / 9 / 3 / 0 |
| `26-service-state-machine.md` | `222` – `233` | 12 | 5 / 3 / 3 / 1 |
| `27-plugin-lifecycle.md` | `234` – `247` | 14 | 7 / 6 / 1 / 0 |
| `28-desktop-update-internals.md` | `248` – `259` | 12 | 4 / 5 / 3 / 0 |
| `29-system-integration.md` | `260` – `273` | 14 | 7 / 4 / 3 / 0 |

合计 **273** 条：正向 125 / 异常 81 / 边界 63 / 低频 4。全部为 `-L3-*`（桌面端宿主层，当前待接线）；其中 `[自动化] 否（手工）` 3 条（`017`、`134`、`136`）。

### 7.2 关键来源 → 覆盖位置

| 来源条目 | 覆盖文件 | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `desktop.test.md` §7 批次 1/2（窗口启动） | `01` | 正向 / 异常 | 启动崩溃分支归 `10`、`11` |
| `desktop.test.md` §7 批次 3（导航栏） | `02` | 正向 / 异常 / 边界 | macOS 原生菜单分支仅 1 条手工用例 |
| `desktop.test.md` §7 批次 4（配置对话框） | `03` | 正向 / 异常 | — |
| `desktop.test.md` §7 批次 5（语言） | `04` | 正向 / 边界 | 主题仅覆盖根节点属性，不覆盖视觉回归 |
| `desktop.test.md` §7 批次 6（档案） | `05` | 正向 / 异常 / 边界 | — |
| `desktop.test.md` §7 批次 7（iframe） | `06` | 正向 / 异常 | 跨源 postMessage 校验分支未覆盖 |
| `desktop.test.md` §6（端口/目录隔离） | `01`、`12`、`13` | 边界 | 端口「固定」表述与实现冲突，见 G5 |
| `desktop.test.md` §5（`data-testid`） | 全部 | 前置约束 | 壳层当前 0 个，见 G3 |
| `agents.desktop.md` §2（端口/数据隔离） | `01`、`13` | 正向 / 边界 | — |
| `agents.desktop.md` §6 issue #525/#526（补丁层） | `11` | 异常 | 隔离失败（`PATCH_LAYER_QUARANTINE_FAILED`）未覆盖 |
| `agents.desktop.md` §6 issue #596（核心基线） | `14` | 异常 | 需构造低于基线的本地核心 |
| `agents.desktop.md` §6 issue #303（快照还原） | `10` | 异常 | — |
| `agents.desktop.md` §6 issue #399（配置覆盖禁用） | `09` | 异常 | — |
| `agents.desktop.md` §6 issue #469（唤醒锁） | `17` | 边界 | 唤醒锁释放无法在页面内断言，**未覆盖** |
| 装配任务编排与 `install-progress` | `20` | 正向 / 异常 / 边界 | 三个提交阶段失败分支**未覆盖** |
| `service/cli/**`（shim 与 PATH） | `21` | 正向 / 异常 / 边界 | Unix rc 注入路径与备份回滚**未覆盖** |
| `config/runtime.rs` 端口与数据目录 | `22` | 正向 / 边界 | debug/release 并存互不干扰**未覆盖** |
| `service/workflow/utils.rs` 回环客户端与 `RuntimeInfo` | `23` | 正向 / 异常 / 边界 | 无遥测为静态证据，不写成 L3 用例 |
| `service/profile/mod.rs` 名称规则与初始化 | `24` | 正向 / 异常 / 边界 | 展示名派生与列表排序**未覆盖** |
| `service/core/version.rs`/`local.rs` 错误码矩阵 | `25` | 异常为主 | `CORE_APP_NOT_FOUND` 等分支**未覆盖** |
| `service/workflow/status.rs`/`health.rs`/`process.rs` | `26` | 正向 / 异常 / 边界 | 9 处 `emit_status` 仅覆盖 5 处 |
| `service/plugin/**`（升级/卸载/快照/恢复/自愈） | `27` | 正向 / 异常 | 多条成功路径与 `force_emit` 未覆盖 |
| `service/update/**`（桌面自更新） | `28` | 正向 / 异常 / 边界 | 需替身更新源；系统表面降级为桥接层断言 |
| `bridge/system_os.rs`/`guard.rs`/`win_inspector.rs` | `29` | 正向 / 异常 / 边界 | 跨平台打包为构建期事实，不在 L3 覆盖 |
| `progressive.md` §1（单批单卡） | 全部文件 | 流程约束 | 每个编号文件视为一个批次 |

### 7.3 高风险路径的正向 / 异常 / 边界覆盖

| 高风险路径 | 正向 | 异常 | 边界 |
| --- | --- | --- | --- |
| 应用启动与窗口建立 | 001、002 | 008 | 003、004 |
| 配置对话框可用性 | 018、019 | 023 | 024 |
| 语言切换与持久化 | 025、027 | 030 | 026 |
| 档案写操作 | 032、033 | 037 | 035 |
| iframe 挂载 | 039、040 | 043 | 045 |
| 服务生命周期 | 046、048 | 050 | 051 |
| 插件写操作 | 066、067 | 068 | 065 |
| 启动失败恢复 | 079、085 | 083 | 086 |
| 核心切换与基线 | 105、108 | 110 | 107 |
| 更新与破坏性更改 | 121、123 | 125、126 | 127 |
| 备份还原 | 113、114 | 117、118 | 120 |
| 多窗口与缩放 | 142、143 | 145 | 144、146 |

---

## 8. 缺口与假设

| 编号 | 类型 | 内容 | 影响 |
| --- | --- | --- | --- |
| G1 | 事实 | 前端产物 `dist/` 与 debug 二进制是否最新，取决于最近一次 `pnpm build` / `cargo build` | 二进制陈旧时全部用例的失败不可归因，需先重建 |
| G2 | 缺口 | `desktop` project 尚未配置（无 `vitest.desktop.config.ts`、无 `test:e2e:desktop` 脚本、`test/e2e/specs/` 不存在） | 全部 273 条用例标注 `[自动化] 待接线`，不得写成可直接运行的 `it()` |
| G3 | 缺口 | `test/e2e/support/selectors.ts` 仍不存在；壳层 `data-testid` 仅 `01` 批次声明的 3 个（`dsh-shell-root`、`dsh-navbar-root`、`dsh-navbar-dev-chip`），`02` 及后续批次所需选择器均待补 | 每个文件末尾的「选择器契约」即为该批次接线前置；未补齐前无法定位元素 |
| G4 | 缺口 | 桌面端缺少宿主编排：现有 `test/e2e/support/dsh-host.ts` 只编排插件 L2 的 `dsh web` 进程 | L3 用例需另建「拉起真实二进制 + 绑定 WDIO 会话 + 收尾」的编排 |
| G5 | 冲突 | `desktop.test.md` §6 称 debug 端口固定 `3081` 不可改；实现存在占用递增逻辑（`launch.rs:66`），`capabilities/default.json:4` 亦声明 NOT fixed | 端口前置按「实测空闲」执行，不假设端口恒定 |
| G6 | 缺口 | 失败产物目录 `test/e2e/.artifacts/` 仅有文档约定与 `.gitignore`，无实现 | 失败定位在接线前只能依赖日志 |
| G7 | 假设 | 需要联网的用例（`08`、`09`、`14`、`16`）默认允许联网；断网分支已在各用例 `[前置条件]` 中单独标注 | 离线环境下这些用例应被跳过而非判失败 |
| G8 | 假设 | 需要构造失败态的用例（补丁层损坏、端口占用、不可达更新源）由测试自行构造并**自行清理**，不改写用户真实 profile | 构造失败会污染其他用例的隔离性 |
| G9 | 缺口 | 系统表面无法在页面内断言：系统通知的实际呈现（`18`）、鼠标穿透（`17`）、托盘菜单点击（`12`）、文件管理器打开 | 相关断言降级为「桥接层成功返回」，视觉/系统确认项标为手工 |
| G10 | 缺口 | 唤醒锁释放（issue #469）与 WebView 原生缩放系数无回读接口 | `17` 与 `13` 只能通过 `window.innerWidth` 等间接代理断言，属已知近似 |
| G11 | 缺口 | 桌宠资源依赖远端 URL 与 IndexedDB 缓存，测试环境无稳定宠物资源 | `17` 的多数用例需先注入可控的本地宠物资源 |
| G12 | 事实 | `docs/testing/progressive.md` §4.1 台账已由本次登记，状态口径见其 §3 | 批次推进前须先补 G2/G3/G4 |

---

## 9. 维护规则

1. 每条用例条目与测试代码 `it()` **1:1 对应**；改文档必改代码，反之亦然（`desktop.test.md` §1）。
2. 状态变更实时登记到 `docs/testing/progressive.md` §4.1 台账，禁止滞后补记。
3. 新增用例必须同步补 `data-testid`，并登记到 `test/e2e/support/selectors.ts`（`desktop.test.md` §5）。
4. 单文件即单批次，未验证通过前不得推进到下一个编号（`progressive.md` §1）。
5. 新增用例后同步更新本文件 §7.1 的条数与区间。
