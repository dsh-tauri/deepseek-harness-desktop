# 预装引导与预设指纹

> 层级：L3 桌面端宿主 E2E（真实 Tauri 窗口）
> 自动化：`test/e2e/specs/desktop/plugin-preinstall.e2e.ts`（待接线，见 `00-overview.md` G4）
> 前置：首次启动态可构造（`preinstall_done` 未置位）；网络可用（安装类用例）
> 运行：待接线（`desktop` project 未配置，见 `00-overview.md` G4）

**与桌面端套件的分工**：`../desktop/08-preinstall-onboarding.md` 断言引导页的渲染、勾选交互与按钮；本文件断言**预设清单的来源与字段语义、指纹判定、安装命令的实际形态、取消与跳过的持久化结果**。共同覆盖归档套件 `06-plugin/04` 与 `01-install/04`。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 预设清单字段结构 | `src-tauri/src/service/plugin/preset.rs:25` |
| 字段语义（`spec` / `package` / `recommended` / `fix` / `winOnly`） | `src-tauri/resources/README.md:61` |
| 清单来源与条目数（preset 3 条 / internal 10 条 / deprecated 4 条） | `src-tauri/resources/preset-plugins.json:3`、`src-tauri/resources/internal-plugins.json:3`、`src-tauri/resources/deprecated-plugins.json:1` |
| 内置条目强制覆盖同名预设 | `src-tauri/src/service/plugin/preset.rs:411` |
| 引导结束写 FNV-1a 指纹 + `preinstall_done` | `src-tauri/src/service/plugin/preset.rs:511` |
| 待安装判定 | `src-tauri/src/service/plugin/preset.rs:532` |
| 命令：`get_preinstall_plugins` / `get_preinstall_pending` / `skip_preinstall_plugins` / `cancel_preinstall_plugins` / `open_preinstall_repo` | `src-tauri/src/bridge/plugin.rs:14`、`src-tauri/src/bridge/plugin.rs:108`、`src-tauri/src/bridge/plugin.rs:78`、`src-tauri/src/bridge/plugin.rs:72`、`src-tauri/src/bridge/plugin.rs:114` |
| 安装入口与 CLI 形态：先逐项 remove，再 `dsh plugin --profile <active> add` | `src-tauri/src/service/plugin/install/mod.rs:124`、`src-tauri/src/bridge/plugin.rs:46`、`src-tauri/src/service/plugin/install/mod.rs:249` |
| spec 规范化：内置强制 `link:`、`github:`/裸 git+ssh → `git+https`、含空格加引号 | `src-tauri/src/service/plugin/install/spec.rs:30`、`src-tauri/src/service/plugin/install/spec.rs:60`、`src-tauri/src/service/plugin/install/spec.rs:104` |
| 空选择 / 非法 id 错误码 | `src-tauri/src/service/plugin/install/mod.rs:131`、`src-tauri/src/service/plugin/install/mod.rs:144` |
| 「静默失败」核验（退出码 0 但无产物） | `src-tauri/src/service/plugin/install/artifact.rs:78` |
| 取消：`preinstall-cancelled` 事件 + 进程树结束 | `src-tauri/src/service/plugin/cancel.rs:13`、`src-tauri/src/service/plugin/cancel.rs:87` |
| 安装日志事件 `preinstall-log` | `src-tauri/src/service/plugin/process.rs:23` |
| 子进程环境注入 `DSH_NODE`（issue #121） | `src-tauri/src/service/plugin/install/env.rs:20`、`src-tauri/src/service/cli/shim/build.rs:743` |
| 首次默认勾选推导 | `src/layout/components/setup-preinstall.tsx:30`、`src/layout/components/setup-preinstall.tsx:168` |
| 确认时按已装求差集得 install/uninstall ids | `src/layout/components/setup-preinstall.tsx:192` |
| 列表过滤 `win_only` / 内置 / 弃用 | `src-tauri/src/service/plugin/installed.rs:107` |

---

## 2. 用例

### [P2] 验证预设清单字段被正确解析且内置项覆盖同名预设

[Case ID] TC-PRE-L3-001
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/preset.rs:25`、`src-tauri/src/service/plugin/preset.rs:411`
[自动化] 待接线（`desktop` project 未配置）
[前置条件] 首次启动态（`preinstall_done` 为 false）
[测试数据] 无
[测试步骤] 1. 调 `get_preinstall_plugins`。2. 比对返回项与 `preset-plugins.json` 的 `id` 集合。3. 找出同时出现在 `internal-plugins.json` 中的 id，读其 `bundled`/来源标记。
[预期结果] 1. 返回项均来自清单文件，无凭空条目。2. `recommended` / `fix` / `winOnly` 字段被透传（值类型为布尔）。3. 同 id 的内置条目以「内置」来源呈现，而不是社区预设。
[清理] 跳过引导以固定状态

### [P2] 验证非 Windows 平台不返回 `winOnly` 条目

[Case ID] TC-PRE-L3-002
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/plugin/installed.rs:107`
[自动化] 待接线（同上；非 Windows 上执行）
[前置条件] 平台为非 Windows（当前工作站为 Windows 时本用例标记为**不可执行**并跳过）
[测试数据] 无
[测试步骤] 1. 调 `get_preinstall_plugins`。2. 过滤 `winOnly` 为 true 的清单条目，检查其 id 是否出现在返回项中。
[预期结果] 1. 所有 `winOnly: true` 的条目均不出现。2. 非 `winOnly` 条目仍正常返回。
[清理] 无

### [P2] 验证确认安装执行的是当前档案的 add 命令且写入 dependencies

[Case ID] TC-PRE-L3-003
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/install/mod.rs:249`、`src-tauri/src/service/plugin/install/spec.rs:60`
[自动化] 待接线（同上）
[前置条件] 引导页已列出至少 1 个可安装项；网络可达；活动档案为 scratch 档案
[测试数据] 勾选 1 个社区预设项（其 `spec` 为 npm 名或 `github:` 简写）
[测试步骤] 1. 勾选并确认。2. 记录 `preinstall-log` 中出现的命令形态。3. 安装结束后读 `profiles/<档案>/package.json`。
[预期结果] 1. 日志体现 `dsh plugin --profile <当前档案> add <规范化后的 spec>`。2. `github:` 简写被规范为 `git+https` 形态。3. `dependencies` 出现该 id，且 `dsh.profile.bundles` 同步包含。4. 结束后 `preinstall_done` 置位。
[清理] 卸载刚装的插件并清空该档案的预装标记

### [P3] [反向] 验证空选择与非法 id 被明确拒绝

[Case ID] TC-PRE-L3-004
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/plugin/install/mod.rs:131`、`src-tauri/src/service/plugin/install/mod.rs:144`
[自动化] 待接线（同上）
[前置条件] 同 TC-PRE-L3-003
[测试数据] 第一次传空 `install_ids`；第二次传清单外的 id
[测试步骤] 1. 两次调用安装。2. 分别读错误前缀。
[预期结果] 1. 第一次返回 `PREINSTALL_EMPTY`。2. 第二次返回 `PREINSTALL_INVALID_ID: <id>`。3. 两次都未产生任何 `dsh plugin` 子进程。
[清理] 无

### [P2] 验证跳过引导写入完成标记且指纹固定

[Case ID] TC-PRE-L3-005
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/preset.rs:511`、`src-tauri/src/service/plugin/preset.rs:532`
[自动化] 待接线（同上）
[前置条件] 首次启动态
[测试数据] 无
[测试步骤] 1. 点击「跳过」。2. 读 `.store.dev.dat`（debug）中的 `preinstall_done` 与 `preset_hash`。3. 重启应用后调 `get_preinstall_pending`。
[预期结果] 1. `preinstall_done` 为 true。2. `preset_hash` 为非空字符串。3. 重启后 `get_preinstall_pending` 为 false，不再进入引导。
[清理] 清除该标记以恢复首次启动态

### [P4] 验证预设清单内容变化使指纹失效并重新进入引导

[Case ID] TC-PRE-L3-006
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/plugin/preset.rs:532`
[自动化] 待接线（同上）
[前置条件] 已走过一次引导（`preinstall_done` true，`preset_hash` = h1）
[测试数据] 修改 `src-tauri/resources/preset-plugins.json` 的任一字符（改后须还原）
[测试步骤] 1. 记录 h1。2. 改动清单文件后重启应用。3. 调 `get_preinstall_pending`。
[预期结果] 1. 指纹变化（FNV-1a 内容敏感）。2. `get_preinstall_pending` 为 true，引导重新出现。3. 还原文件并重启后再次为 false。
[清理] 还原 `preset-plugins.json` 并跳过引导

### [P3] 验证取消安装会结束子进程且不置位完成标记

[Case ID] TC-PRE-L3-007
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/plugin/cancel.rs:87`、`src-tauri/src/service/plugin/cancel.rs:13`
[自动化] 待接线（同上；需要较慢网络以留出取消窗口）
[前置条件] 安装进行中（选择体积较大的插件或限速网络）
[测试数据] 无
[测试步骤] 1. 确认安装已开始（`preinstall-log` 有输出）。2. 点击取消。3. 检查事件、进程与标记。
[预期结果] 1. 收到 `preinstall-cancelled`。2. `preinstall-log` 停止新增。3. 无残留 node/pnpm 进程。4. `preinstall_done` 仍为 false，`preset_hash` 未更新；`get_preinstall_pending` 仍为 true。
[清理] 跳过引导以固定状态

### [P4] 验证打开仓库只接受清单内 id

[Case ID] TC-PRE-L3-008
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/bridge/plugin.rs:114`
[自动化] 待接线（同上）
[前置条件] 引导页列出至少 1 项
[测试数据] 清单内 id；清单外 id（如 `unknown-package`）
[测试步骤] 1. 用清单内 id 调 `open_preinstall_repo`，比对打开的 URL 与清单 `repoUrl`。2. 用清单外 id 再调用一次，读错误前缀。
[预期结果] 1. 第一次打开的地址与清单 `repoUrl` 一致。2. 第二次返回 `PREINSTALL_INVALID_ID: unknown-package` 且不打开浏览器。
[清理] 关闭被拉起的浏览器标签

### [P4] 验证安装子进程环境注入 `DSH_NODE`

[Case ID] TC-PRE-L3-009
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/plugin/install/env.rs:20`、`src-tauri/src/service/cli/shim/build.rs:743`
[自动化] 待接线（同上；Windows 专项）
[前置条件] Windows；`PATH` 中 node 不可解析或指向不可用条目
[测试数据] 无
[测试步骤] 1. 触发一次预装安装。2. 观察日志是否出现 `[pnpm] Node.js runtime not found`。3. 读取 shim 文本中 `DSH_NODE` 的判断顺序。
[预期结果] 1. 不出现 `[pnpm] Node.js runtime not found`。2. 安装成功完成。3. shim 中 `DSH_NODE` 的判断位于本机 node 搜索之前。
[清理] 恢复网络与环境

---

## 3. 追踪矩阵

| 来源（归档套件） | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `06-plugin/04` 验证选中推荐插件后确认安装并展示实时安装日志 | TC-PRE-L3-003 | 正向 | 日志逐行渲染由 `../desktop/08` 断言 |
| `06-plugin/04` 验证安装按当前档案执行 dsh plugin --profile add 命令 | TC-PRE-L3-003、TC-PRE-L3-004 | 正向 / 异常 | — |
| `06-plugin/04` 验证跳过引导后记录完成不再弹出 | TC-PRE-L3-005 | 正向 | — |
| `06-plugin/04` 验证取消进行中的预装插件安装 | TC-PRE-L3-007 | 异常 | — |
| `06-plugin/04` 验证 Windows 下列出 dsh-win-terminal-inspector 修复项 | TC-PRE-L3-002（反向）+ `../desktop/08` | 边界 | Windows 上需正向断言，见 G-PRE-2 |
| `06-plugin/04` 验证打开预装插件仓库地址 | TC-PRE-L3-008 | 边界 | — |
| `06-plugin/04` 验证预检通过但 pnpm shim 找不到 node 时安装仍成功（issue #121） | TC-PRE-L3-009 | 边界 | — |
| `01-install/04` 验证预设清单指纹变更后重新进入引导 | TC-PRE-L3-006 | 边界 | — |
| `01-install/04` 验证首次启动列出预设插件清单且推荐/修复/默认项默认勾选 | TC-PRE-L3-001 + `../desktop/08` | 正向 | 勾选交互归 desktop 08 |
| 归档已废弃条目的现状 | `src-tauri/resources/deprecated-plugins.json:1` | — | 归档提及的 `dsh-notification` / `dsh-session-context-menu` 现已在弃用清单中，见 G-PRE-3 |

---

## 4. 缺口与假设

- **G-PRE-1**：安装类用例依赖外部网络与 npm/git 源，属 `desktop.test.md` §6 允许联网的场景；离线环境应跳过而非判失败。
- **G-PRE-2**：TC-PRE-L3-002 在 Windows 工作站上无法执行（需非 Windows）。若必须覆盖 Windows 正向分支，需新增一条「Windows 下列出 `winOnly` 修复项」用例，但当前 `preset-plugins.json` 内已无 `winOnly` 条目（字段语义仍保留），故该分支**暂时无数据可测**。
- **G-PRE-3**：归档套件引用的预设项（`dshmarket`、`dsh-better-sidebar`、`dsh-notification`、`dsh-win-terminal-inspector`）与现行清单不一致：现行 `preset-plugins.json` 仅 3 条，且 `deprecated-plugins.json` 列出 4 个已弃用包。用例一律以**运行时清单内容**为准，不硬编码归档中的包名。
- **G-PRE-4**：安装成功后 `preinstall_done` 与 `preset_hash` 的写点分散在 `src-tauri/src/bridge/plugin.rs:36`、`:62`、`:80`，本文件只断言最终状态，不断言写序。
- **假设**：debug 构建的 store 文件为 `.store.dev.dat`（`src-tauri/src/config/setting.rs:191`），因此预装标记与用户真实环境隔离。
