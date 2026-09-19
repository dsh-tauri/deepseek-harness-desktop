# 插件异常定位、修复与安全模式

> 层级：L3 桌面端宿主 E2E（真实 Tauri 窗口）
> 自动化：`test/e2e/plugins/plugin-recovery-backend.e2e.ts`（待接线，见 `00-overview.md` G4）
> 前置：应用已启动；可构造插件异常态与损坏的补丁层
> 运行：待接线（`desktop` project 未配置，见 `00-overview.md` G4）

**与桌面端套件的分工**：`../desktop/10-plugin-recovery.md` 断言恢复页与对话框的呈现；`../desktop/11-startup-error.md` 断言错误页与三个针对性入口。本文件断言**错误记录的落盘形态、日志定位的判定结果、修复动作对文件的真实改动、安全模式的隔离副作用**。共同覆盖归档套件 `06-plugin/03-插件异常与恢复`。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 错误记录文件：应用数据目录下 `plugin-errors.json` | `src-tauri/src/service/plugin/errors.rs:31` |
| 记录结构：`{ message, action, at }`，`action ∈ install/update/remove/runtime` | `src-tauri/src/service/plugin/errors.rs:21`、`src-tauri/src/service/plugin/errors.rs:25` |
| 同 id 幂等覆盖 | `src-tauri/src/service/plugin/errors.rs:53` |
| 安装/升级/卸载成功即清除对应记录 | `src-tauri/src/service/plugin/install/artifact.rs:35`、`src-tauri/src/service/plugin/single.rs:353` |
| 清单合并时过滤「install 错误但版本已可解析」 | `src-tauri/src/service/plugin/watch.rs:230` |
| 上报命令 `report_plugin_error` | `src-tauri/src/bridge/plugin.rs:166` |
| 事件 `plugin-recovery-required` | `src-tauri/src/service/plugin/recovery/mod.rs:37` |
| 定位命令 `detect_plugin_recovery(logs)` | `src-tauri/src/bridge/plugin.rs:195`、`src-tauri/src/service/plugin/recovery/mod.rs:118` |
| 日志解析：5 组正则 + 失败卡片 | `src-tauri/src/service/plugin/recovery/extract.rs:10`、`src-tauri/src/service/plugin/recovery/extract.rs:45` |
| `reason` 取值集合 | `src-tauri/src/service/plugin/recovery/extract.rs:91` |
| `raw_error`：最多 8 行、截断 2000 字符 | `src-tauri/src/service/plugin/recovery/mod.rs:140` |
| 归属判定：仅证据唯一时返回 | `src-tauri/src/service/plugin/recovery/ownership.rs:217` |
| 根集合取 bundles 并过滤 `@deepseek-ai/*` | `src-tauri/src/service/plugin/recovery/ownership.rs:46` |
| 修复命令 `recover_plugin` | `src-tauri/src/bridge/plugin.rs:207`、`src-tauri/src/service/plugin/recovery/mod.rs:160` |
| 拒绝核心/官方包 `PLUGIN_RECOVERY_REFUSED` | `src-tauri/src/service/plugin/recovery/mod.rs:163` |
| 修复动作：摘 dependencies+bundles、删包体、剥离 patch、删 lock、清错误 | `src-tauri/src/service/plugin/recovery/uninstall.rs:13`、`src-tauri/src/service/plugin/recovery/uninstall.rs:61`、`src-tauri/src/service/plugin/recovery/uninstall.rs:128`、`src-tauri/src/service/plugin/recovery/mod.rs:188`、`src-tauri/src/service/plugin/recovery/mod.rs:193` |
| 安全模式：建 `profiles/safe`、隔离补丁层、失败不改活动档案 | `src-tauri/src/bridge/lifecycle.rs:359`、`src-tauri/src/bridge/lifecycle.rs:362`、`src-tauri/src/bridge/lifecycle.rs:363`、`src-tauri/src/bridge/lifecycle.rs:370` |
| 安全档案清理用户插件（保护集为空则拒绝） | `src-tauri/src/service/plugin/safe.rs:63`、`src-tauri/src/service/plugin/safe.rs:73` |
| 补丁层隔离命名 `.broken-<UTC 时间戳>` | `src-tauri/src/service/plugin/patch_guard.rs:13`、`src-tauri/src/service/plugin/patch_guard.rs:94` |
| 隔离失败码 `PATCH_LAYER_QUARANTINE_FAILED` | `src-tauri/src/service/plugin/patch_guard.rs:195` |
| 悬空 insert 剥离前备份 `.bak-<时间戳>` | `src-tauri/src/bridge/lifecycle.rs:399`、`src-tauri/src/service/plugin/patch_entries.rs:137` |
| 前端触发点：上报 / 定位 / 修复 / 安全模式 | `src/layout/components/iframe.tsx:145`、`src/ui/plugin/recovery.tsx:51`、`src/ui/plugin/recovery.tsx:89`、`src/store/modules/harness/store.ts:673`（`enter_safe_mode` 调用点） |

---

## 2. 用例

### [P1] 验证运行期上报落盘为 runtime 类记录并推送清单事件

[Case ID] TC-REC-L3-001
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/errors.rs:53`、`src-tauri/src/bridge/plugin.rs:166`
[自动化] 待接线（`desktop` project 未配置）
[前置条件] 应用运行中；已装某插件；可触发一次页面内插件错误（或经桥上报）
[测试数据] 插件 id 与错误文本（含首尾空白的字符串，用于验证 trim）
[测试步骤] 1. 触发上报。2. 读取应用数据目录下 `plugin-errors.json`。3. 读该 id 的 `message` / `action` / `at`。4. 观察界面异常标记。
[预期结果] 1. 文件存在且为该 id 的记录。2. `action` 为 `runtime`。3. `message` 已去除首尾空白且长度 ≤ 2000。4. `at` 为纯数字字符串（unix 秒）。5. 界面出现异常标记。
[清理] 删除该记录并刷新

### [P3] 验证同一插件的重复上报只保留最新记录

[Case ID] TC-REC-L3-002
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/plugin/errors.rs:53`
[自动化] 待接线（同上）
[前置条件] 同 TC-REC-L3-001
[测试数据] 同一 id 的两条不同错误文本，先后上报
[测试步骤] 1. 上报 A。2. 上报 B。3. 读 `plugin-errors.json` 中该 id 的条目数与 `message`。
[预期结果] 1. 该 id 只有 1 条记录。2. `message` 为 B 的文本（幂等覆盖）。
[清理] 删除该记录

### [P2] 验证恢复可解析后不再把安装错误暴露为当前错误

[Case ID] TC-REC-L3-003
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/watch.rs:230`、`src-tauri/src/service/plugin/install/artifact.rs:35`
[自动化] 待接线（同上）
[前置条件] 某插件存在一条 `install` 类错误记录，但其包已在 `node_modules` 中可解析
[测试数据] 该插件 id
[测试步骤] 1. 保留错误记录、确认包体可解析。2. 刷新插件清单。3. 读该行的 `error` 字段与异常标记。
[预期结果] 1. 清单该行**不**包含 `error` 字段。2. 界面不显示异常标记。3. `plugin-errors.json` 中的记录可能仍在（合并时才过滤），因此断言只针对清单输出。
[清理] 清理记录

### [P3] 验证日志定位返回唯一根插件与规范化的 reason

[Case ID] TC-REC-L3-004
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/recovery/mod.rs:118`、`src-tauri/src/service/plugin/recovery/extract.rs:91`、`src-tauri/src/service/plugin/recovery/mod.rs:140`
[自动化] 待接线（同上）
[前置条件] 可取得一份真实的插件加载失败日志（含失败卡片或冲突行）
[测试数据] `logs` 数组（至少包含失败行）
[测试步骤] 1. 调 `detect_plugin_recovery(logs)`。2. 读 `plugins`、`reason`、`rawError`、`detail`。
[预期结果] 1. `plugins` 恰好包含 1 个根插件 id。2. `reason` 属于 `duplicate_route` / `duplicate_loader_entry` / `cannot_resolve_bundle` / `no_dsh_bundle` / `slot_conflict` / `load_failed` / `unknown` 之一。3. `rawError` 长度 ≤ 2000 且行数 ≤ 8。4. `detail` 与 `reason` 语义一致（非空）。
[清理] 无

### [P4] [反向] 验证证据不唯一时不给出归属

[Case ID] TC-REC-L3-005
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/plugin/recovery/ownership.rs:217`
[自动化] 待接线（同上）
[前置条件] 构造两条不同插件都可能导致失败的日志（冲突证据）
[测试数据] 混合日志
[测试步骤] 1. 调 `detect_plugin_recovery`。2. 读 `plugins`。
[预期结果] 1. `plugins` 为空数组（不猜测归属）。2. 界面按「无归属」呈现，而不是任选一个插件。
[清理] 无

### [P2] 验证修复剥离插件四处痕迹并清除错误记录

[Case ID] TC-REC-L3-006
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/recovery/uninstall.rs:13`、`src-tauri/src/service/plugin/recovery/uninstall.rs:128`、`src-tauri/src/service/plugin/recovery/mod.rs:188`
[自动化] 待接线（同上）
[前置条件] 活动档案中存在一个可被定位的问题插件（非核心/官方包），且该插件在 `cordis.patch.yml` 与 `pnpm-lock.yaml` 中有痕迹
[测试数据] 该插件 id
[测试步骤] 1. 记录修复前：`dependencies`、`bundles`、`node_modules/<id>`、`cordis.patch.yml` 条目、`pnpm-lock.yaml` 大小、错误记录。2. 调 `recover_plugin(id)`。3. 逐项复查。
[预期结果] 1. `dependencies` 与 `dsh.profile.bundles` 不再含该 id。2. `node_modules/<id>` 已删除（scoped 包的空父目录也一并清理）。3. `cordis.patch.yml` 中该插件相关条目被剥离。4. `pnpm-lock.yaml` 已删除或重建（产物由 CLI 决定）。5. 该插件的错误记录被清除。6. 其他插件的依赖与配置保持不变。
[清理] 重新安装该插件以恢复环境

### [P3] [反向] 验证修复拒绝核心与官方包

[Case ID] TC-REC-L3-007
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/plugin/recovery/mod.rs:163`
[自动化] 待接线（同上）
[前置条件] 目标为核心包或 `@deepseek-ai/*` 官方包
[测试数据] 受保护 id
[测试步骤] 1. 记录三处文件与错误记录摘要。2. 调 `recover_plugin(id)`。3. 读错误前缀。
[预期结果] 1. 返回 `PLUGIN_RECOVERY_REFUSED: refusing to remove core/official package <id>`。2. `dependencies`、bundles、`node_modules` 均未变化。3. 错误记录未被清除。
[清理] 无

### [P2] 验证安全模式隔离补丁层并在失败时不切换活动档案

[Case ID] TC-REC-L3-008
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/bridge/lifecycle.rs:362`、`src-tauri/src/bridge/lifecycle.rs:363`、`src-tauri/src/bridge/lifecycle.rs:370`
[自动化] 待接线（同上）
[前置条件] `<DSH_E2E_HOME>/home/.dsh.dev/cordis.patch.yml` 或档案层补丁含不可解析 YAML；活动档案为 scratch 档案
[测试数据] 损坏的补丁文件
[测试步骤] 1. 记录活动档案名。2. 触发 `enter_safe_mode`。3. 读 `profiles/safe` 是否存在、活动档案是否变化、损坏补丁文件是否被改名。
[预期结果] 1. `profiles/safe` 被创建。2. 损坏的补丁层被隔离（改名为 `.broken-<UTC 时间戳>`，原文件不被删除）。3. 隔离失败时返回 `PATCH_LAYER_QUARANTINE_FAILED: <详情>` 且**活动档案不变**。4. 成功后活动档案切到 `safe`。
[清理] 复原补丁文件与活动档案

### [P4] 验证悬空 insert 剥离前保留备份

[Case ID] TC-REC-L3-009
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/bridge/lifecycle.rs:399`、`src-tauri/src/service/plugin/patch_entries.rs:137`
[自动化] 待接线（同上）
[前置条件] 某档案 `cordis.patch.yml` 含指向不存在插件的 `insert` 条目
[测试数据] 该补丁文件
[测试步骤] 1. 触发 `strip_unresolved_patch_entries`。2. 检查目录中是否出现 `.bak-<时间戳>` 副本。3. 读剥离后的补丁文件。
[预期结果] 1. 出现带 `.bak-<时间戳>` 后缀的备份副本（内容为剥离前原文）。2. 剥离后的文件不再含该 `insert` 条目。3. 其它条目保持不变。
[清理] 删除备份并恢复原补丁文件

---

## 3. 追踪矩阵

| 来源（归档套件） | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `06-plugin/03` 验证页面运行期错误通过 report_plugin_error 记录并实时同步 | TC-REC-L3-001、TC-REC-L3-002 | 正向 / 边界 | 界面同步由 `../desktop/09`、`../desktop/10` 断言 |
| `06-plugin/03` 验证 detect_plugin_recovery 能定位到损坏插件 | TC-REC-L3-004、TC-REC-L3-005 | 正向 / 边界 | — |
| `06-plugin/03` 验证 recover_plugin 能恢复损坏插件 | TC-REC-L3-006 | 正向 | — |
| `06-plugin/03` 验证插件恢复正常后错误状态清除 | TC-REC-L3-003 | 正向 | — |
| `06-plugin/03` 验证 recover_plugin 拒绝卸载核心或官方包 | TC-REC-L3-007 | 异常 | — |
| `06-plugin/03` 验证补丁层 YAML 语法错误可被显式隔离并恢复启动 | TC-REC-L3-008 | 异常 | 错误页入口由 `../desktop/11` 断言 |
| 现行实现新增（悬空 insert 备份） | TC-REC-L3-009 | 边界 | — |
| `06-plugin/03` 验证 pnpm-workspace.yaml 多文档被归一化并恢复插件安装 | TC-ISO-L2-002（见 `16-profile-and-patch-isolation.md`） | 正向 | 归 17 |

---

## 4. 缺口与假设

- **G-REC-1**：`plugin-errors.json` 与 `$DSH_HOME` 分离——它位于**应用数据目录**（`src-tauri/src/service/plugin/errors.rs:8`），属桌面端诊断数据。用例读取该文件时必须用应用数据目录，而非 `<DSH_E2E_HOME>/home/.dsh.dev`。debug 构建的应用数据目录带 `.dev` 后缀（`src-tauri/src/config/runtime.rs:17`）。
- **G-REC-2**：`detect_plugin_recovery` 与 `get_dsh_plugins`、`get_plugin_backup` 一样声明为非 `Result`，异常输入不会以错误返回，而是退化为空/默认值（`src-tauri/src/bridge/plugin.rs:195`）。TC-REC-L3-005 断言的是这种退化行为，不是报错。
- **G-REC-3**：安全模式会真实改写活动档案与补丁层。执行前必须确认处于 scratch 数据目录；TC-REC-L3-008 的清理步骤若失败，应视为阻塞后续用例的环境污染。
- **G-REC-4**：`recover_plugin` 删除 `pnpm-lock.yaml` 的具体形态（整体删除 vs 重建）在 `src-tauri/src/service/plugin/recovery/mod.rs:188` 有实现，但重建产物由 pnpm 决定，故用例只断言「不再包含该插件」。
- **假设**：安全性由证据唯一性保证（`src-tauri/src/service/plugin/recovery/ownership.rs:217`），因此本文件不设计「猜测修复」类用例。
