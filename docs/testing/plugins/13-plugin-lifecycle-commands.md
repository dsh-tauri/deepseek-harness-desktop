# 插件生命周期命令：禁用 / 启用 / 升级 / 卸载 / 快照

> 层级：L3 桌面端宿主 E2E（真实 Tauri 窗口）
> 自动化：`test/e2e/plugins/plugin-lifecycle.e2e.ts`（待接线，见 `00-overview.md` G4）
> 前置：应用已启动；配置对话框可打开在「插件」面板；测试档案可写
> 运行：待接线（`desktop` project 未配置，见 `00-overview.md` G4）

**与桌面端套件的分工**：`../desktop/09-plugin-panel.md` 断言按钮、确认框与界面标记；本文件断言**这些操作在磁盘上到底改了什么**（`dependencies` / `dsh.profile.bundles` / `disabled-plugins.json` / `plugin-errors.json` / 快照文件）。共同覆盖归档套件 `06-plugin/02-插件升级与卸载`。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 命令注册（插件域 23 条） | `src-tauri/src/desktop/builder.rs:879` |
| `disable_dsh_plugin` / `enable_dsh_plugin` | `src-tauri/src/bridge/plugin.rs:217`、`src-tauri/src/bridge/plugin.rs:230` |
| 禁用主体：先写桌面禁用清单，再仅从 bundles 摘除 | `src-tauri/src/service/plugin/disable.rs:302`、`src-tauri/src/service/plugin/disable.rs:303`、`src-tauri/src/service/plugin/disable.rs:196` |
| 禁用拒绝内置包（`@deepseek-ai/*`） | `src-tauri/src/service/plugin/disable.rs:277` |
| 启用主体：摘 patch 覆盖 → 清禁用清单 → 加回 bundles | `src-tauri/src/service/plugin/disable.rs:376`、`src-tauri/src/service/plugin/disable.rs:379`、`src-tauri/src/service/plugin/disable.rs:382` |
| 启用错误码 `ENABLE_NOT_DISABLED` / `ENABLE_CONFIG_OVERRIDE` | `src-tauri/src/service/plugin/disable.rs:363`、`src-tauri/src/service/plugin/disable.rs:368` |
| bundles 增删幂等实现 | `src-tauri/src/service/plugin/disable.rs:212`、`src-tauri/src/service/plugin/disable.rs:184` |
| `update_dsh_plugin` → `dsh plugin --profile <p> update <id> --latest` | `src-tauri/src/bridge/plugin.rs:148`、`src-tauri/src/service/plugin/install/single.rs:37` |
| 升级前停服 + 自动快照 + 成功清错误 | `src-tauri/src/service/plugin/install/single.rs:271`、`src-tauri/src/service/plugin/install/single.rs:289`、`src-tauri/src/service/plugin/install/single.rs:353` |
| 升级「假成功」判定 `PLUGIN_UPDATE_NO_CHANGE` | `src-tauri/src/service/plugin/install/single.rs:297` |
| `remove_dsh_plugin` + 失败码 `PLUGIN_REMOVE_FAILED` | `src-tauri/src/bridge/plugin.rs:157`、`src-tauri/src/service/plugin/install/single.rs:346` |
| 卸载级联删除快照 / 离线兜底 | `src-tauri/src/service/plugin/install/single.rs:143`、`src-tauri/src/service/plugin/install/single.rs:116` |
| 受保护包拒绝卸载 `PLUGIN_RECOVERY_REFUSED` | `src-tauri/src/service/plugin/recovery/mod.rs:163` |
| 快照创建与存储 `<DSH_HOME>/.plugin-backups/<净化id>.tgz` | `src-tauri/src/bridge/plugin.rs:243`、`src-tauri/src/service/plugin/snapshot.rs:358`、`src-tauri/src/service/plugin/snapshot.rs:39` |
| 快照内嵌 `manifest.json`（回读依据） | `src-tauri/src/service/plugin/snapshot.rs:41`、`src-tauri/src/service/plugin/snapshot.rs:376` |
| 还原：仅可动插件 + 完整性校验 + 三阶段 + 回滚 | `src-tauri/src/service/plugin/snapshot.rs:586`、`src-tauri/src/service/plugin/snapshot.rs:588`、`src-tauri/src/service/plugin/snapshot.rs:320`、`src-tauri/src/service/plugin/snapshot.rs:619` |
| 还原错误码 `SNAPSHOT_RESTORE_REFUSED` / `SNAPSHOT_NOT_FOUND` | `src-tauri/src/service/plugin/snapshot.rs:590`、`src-tauri/src/service/plugin/snapshot.rs:596` |
| 删除快照：NotFound 视为成功 | `src-tauri/src/service/plugin/snapshot.rs:476`、`src-tauri/src/service/plugin/snapshot.rs:481` |
| 错误记录 `plugin-errors.json`（key=id，`{message,action,at}`） | `src-tauri/src/service/plugin/errors.rs:31`、`src-tauri/src/service/plugin/errors.rs:53` |
| 前端每个操作结束后统一重启服务 | `src/ui/config/plugin.tsx:193`、`src/ui/config/plugin.tsx:226`、`src/ui/config/plugin.tsx:244` |

---

## 2. 用例

### [P2] 验证禁用只摘 bundles、保留依赖与包体

[Case ID] TC-LIFE-L3-001
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/disable.rs:302`、`src-tauri/src/service/plugin/disable.rs:303`
[自动化] 待接线（`desktop` project 未配置）
[前置条件] 目标插件已安装且处于启用态（选一个不承载壳层能力的插件）
[测试数据] 目标插件 id
[测试步骤] 1. 在插件面板点击「禁用」。2. 读 `profiles/<档案>/package.json` 的 `dependencies` 与 `dsh.profile.bundles`。3. 读 `profiles/<档案>/disabled-plugins.json`。4. 检查 `node_modules/<id>` 是否仍存在。
[预期结果] 1. `dependencies` 仍含该 id。2. `dsh.profile.bundles` 不再含该 id。3. `disabled-plugins.json` 含该 id。4. `node_modules/<id>` 目录仍存在（只摘加载，不删包体）。5. 界面显示「已禁用」标记。
[清理] 点「启用」恢复；确认三处文件回滚

### [P3] [反向] 验证禁用内置插件被拒绝且不改动任何文件

[Case ID] TC-LIFE-L3-002
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/plugin/disable.rs:277`
[自动化] 待接线（同上）
[前置条件] 存在内置插件（如 `dsh-tauri`），其包前缀为 `@deepseek-ai/*` 之外的受保护集合
[测试数据] 受保护插件的 id
[测试步骤] 1. 记录操作前三处文件的内容摘要。2. 触发禁用。3. 读返回的错误文案与三处文件。
[预期结果] 1. 返回错误，前缀为 `DISABLE_INTERNAL_PLUGIN`。2. `dsh.profile.bundles`、`dependencies`、`disabled-plugins.json` 均未变化。
[清理] 无

### [P3] [反向] 验证启用未处于禁用态的插件返回明确错误

[Case ID] TC-LIFE-L3-003
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/plugin/disable.rs:363`
[自动化] 待接线（同上）
[前置条件] 目标插件已安装且启用中（不在禁用清单、也不被 patch 覆盖禁用）
[测试数据] 该插件 id
[测试步骤] 1. 触发启用。2. 读错误文案。
[预期结果] 1. 返回错误，前缀为 `ENABLE_NOT_DISABLED`。2. `dsh.profile.bundles` 未出现重复项（幂等加回不产生重复）。
[清理] 无

### [P3] [反向] 验证被配置覆盖禁用的插件启用前需要显式确认

[Case ID] TC-LIFE-L3-004
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/plugin/disable.rs:368`
[自动化] 待接线（同上）
[前置条件] 某插件被 `cordis.patch.yml` 以配置覆盖方式禁用
[测试数据] 该插件 id
[测试步骤] 1. 不传 `clear_config_override` 触发启用。2. 读错误前缀。3. 读 `cordis.patch.yml`。
[预期结果] 1. 返回 `ENABLE_CONFIG_OVERRIDE`。2. `cordis.patch.yml` 中的禁用条目仍在（未被擅自摘除）。
[清理] 恢复原状

### [P1] 验证升级成功后版本前进、错误记录清除、并留下自动快照

[Case ID] TC-LIFE-L3-005
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/install/single.rs:289`、`src-tauri/src/service/plugin/install/single.rs:353`、`src-tauri/src/service/plugin/snapshot.rs:425`
[自动化] 待接线（同上）
[前置条件] 目标插件有可用新版本（网络可达）；预先为该插件写入一条升级失败记录
[测试数据] 目标插件 id 与其旧版本号
[测试步骤] 1. 记录旧版本号。2. 点击「升级」并等待结束。3. 读新版本号、`plugin-errors.json`、`.plugin-backups/` 目录。
[预期结果] 1. 版本号前进（或返回 `PLUGIN_UPDATE_NO_CHANGE` 且版本不变）。2. `plugin-errors.json` 中该插件的记录被删除。3. `.plugin-backups/` 下存在该插件的快照文件。
[清理] 保留快照；删除本次写入的错误记录

### [P3] [反向] 验证升级网络失败被记录为 update 类错误

[Case ID] TC-LIFE-L3-006
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/bridge/plugin.rs:148`、`src-tauri/src/service/plugin/errors.rs:53`
[自动化] 待接线（同上）
[前置条件] 断网或使插件源不可达
[测试数据] 目标插件 id
[测试步骤] 1. 触发升级。2. 读错误前缀。3. 读 `plugin-errors.json` 中该 id 的 `action` 与 `message`。
[预期结果] 1. 返回错误，前缀为 `PLUGIN_UPDATE_FAILED`。2. 记录存在且 `action` 为 `update`。3. `message` 非空且已 trim，长度不超过 2000 字符。
[清理] 恢复网络；清理该记录

### [P1] 验证卸载同时清理依赖、bundles、包体与级联快照

[Case ID] TC-LIFE-L3-007
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/install/single.rs:102`、`src-tauri/src/service/plugin/install/single.rs:143`
[自动化] 待接线（同上）
[前置条件] 目标插件已安装且有快照；该插件不被壳层依赖
[测试数据] 目标插件 id
[测试步骤] 1. 确认 `node_modules/<id>` 与快照均存在。2. 点击「卸载」并在确认框确认。3. 读 `dependencies`、`dsh.profile.bundles`、`node_modules/<id>`、`.plugin-backups/`。
[预期结果] 1. `dependencies` 不再含该 id。2. `dsh.profile.bundles` 不再含该 id。3. `node_modules/<id>` 已删除。4. 该插件的快照已被级联删除。
[清理] 重新安装该插件以恢复环境

### [P3] [反向] 验证卸载受保护包被拒绝且不留副作用

[Case ID] TC-LIFE-L3-008
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/plugin/recovery/mod.rs:163`
[自动化] 待接线（同上）
[前置条件] 目标为受保护包（核心或官方包）
[测试数据] 受保护 id
[测试步骤] 1. 记录三处文件摘要。2. 触发卸载。3. 读错误前缀与文件。
[预期结果] 1. 返回 `PLUGIN_RECOVERY_REFUSED`。2. `dependencies`、bundles、`node_modules` 均未变化。
[清理] 无

### [P2] 验证快照可创建、可查询、可还原

[Case ID] TC-LIFE-L3-009
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/snapshot.rs:358`、`src-tauri/src/service/plugin/snapshot.rs:586`
[自动化] 待接线（同上）
[前置条件] 目标插件已安装
[测试数据] 目标插件 id
[测试步骤] 1. 点「快照」，读返回的 `SnapshotInfo`。2. 检查 `.plugin-backups/<净化id>.tgz` 存在。3. 破坏该插件的一个文件后再点「还原」。4. 读还原结果与该文件内容。
[预期结果] 1. 快照文件生成，大小 > 0。2. `get_plugin_backup` 返回该快照信息（时间戳、大小）。3. 还原成功，被破坏的文件恢复到快照内容。
[清理] 删除快照；恢复文件

### [P3] [反向] 验证无可还原快照时给出明确错误

[Case ID] TC-LIFE-L3-010
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/plugin/snapshot.rs:590`、`src-tauri/src/service/plugin/snapshot.rs:596`
[自动化] 待接线（同上）
[前置条件] 目标插件存在但没有任何快照
[测试数据] 该插件 id
[测试步骤] 1. 触发还原。2. 读错误前缀。
[预期结果] 1. 返回 `SNAPSHOT_NOT_FOUND` 或 `SNAPSHOT_RESTORE_REFUSED`（按 `is_actionable` 判定分支）。2. 插件目录内容未被改动。
[清理] 无

### [P4] 验证删除不存在的快照视为成功

[Case ID] TC-LIFE-L3-011
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/plugin/snapshot.rs:481`
[自动化] 待接线（同上）
[前置条件] 目标插件无快照
[测试数据] 该插件 id
[测试步骤] 1. 连续触发两次「删除快照」。2. 读两次结果。
[预期结果] 1. 两次均不报错（NotFound 幂等）。2. `.plugin-backups/` 中没有产生残留临时文件（`.tmp`）。
[清理] 无

### [P2] 验证写操作结束后服务被重新拉起

[Case ID] TC-LIFE-L3-012
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/config/plugin.tsx:193`、`src/ui/config/plugin.tsx:282`
[自动化] 待接线（同上）
[前置条件] 服务处于 Running
[测试数据] 任一次写操作（禁用后启用）
[测试步骤] 1. 记录当前服务端口与启动时间。2. 执行一次禁用。3. 等待界面回到 Running。4. 读服务地址与插件加载结果。
[预期结果] 1. 操作过程中界面出现「正在停止运行中的服务」提示。2. 结束后服务回到 Running。3. 被禁用插件不再加载（其宿主路由返回 404）。4. `dsh-plugins-updated` 至少推送一次。
[清理] 恢复启用态

---

## 3. 追踪矩阵

| 来源（归档套件） | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `06-plugin/02` 验证升级已装插件到新版本成功 | TC-LIFE-L3-005 | 正向 | 需联网与真实新版本 |
| `06-plugin/02` 验证卸载插件成功且从列表移除 | TC-LIFE-L3-007 | 正向 | — |
| `06-plugin/02` 验证升级失败时给出错误详情并可重试 | TC-LIFE-L3-006 | 异常 | — |
| `06-plugin/02` 验证卸载不存在的插件时不误报成功 | TC-LIFE-L3-008 | 异常 | 归档针对「不存在」，此处以受保护包为主；「不存在」分支并入 03 |
| `06-plugin/02` 验证升级或卸载后服务按新状态生效 | TC-LIFE-L3-012 | 正向 | — |
| 现行实现新增（禁用/启用事务与回滚） | TC-LIFE-L3-001 ～ TC-LIFE-L3-004 | 正向 / 异常 | 归档套件未覆盖禁用/启用 |
| 现行实现新增（快照 CRUD） | TC-LIFE-L3-009 ～ TC-LIFE-L3-011 | 正向 / 异常 / 边界 | 归档仅间接依赖快照 |
| `06-plugin/01` 验证插件被移除后列表能反应 | TC-LIFE-L3-007 + `12-plugin-inventory-and-watch.md` | 正向 | 列表侧断言归 13 |

---

## 4. 缺口与假设

- **G-LIFE-1**：写操作会真实改动测试档案。执行前必须确认活动档案指向 scratch 档案（`<DSH_E2E_HOME>/home/.dsh.dev`），且用例结束时恢复原状；未恢复即判失败。
- **G-LIFE-2**：`update_dsh_plugin` 依赖外部 `dsh`/`pnpm` 与网络，其写盘形态（`pnpm-lock.yaml` 等）由 CLI 决定，不在本仓库实现内（见 `src-tauri/src/service/plugin/install/single.rs:303`）。本文件只断言可见结果（版本、错误记录、快照），不断言 lock 文件细节。
- **G-LIFE-3**：`enable_dsh_plugin` 的参数名在前端为 `clearConfigOverride`、Rust 侧为 `clear_config_override`（`src/ui/config/plugin.tsx:128`、`src-tauri/src/bridge/plugin.rs:233`），依赖 Tauri 的命名转换。TC-LIFE-L3-004 需先确认转换生效，否则错误码不会出现。
- **G-LIFE-4**：`snapshot_plugins`（批量）在前端无调用点（仅 Rust 注册），故不设用例；若后续接线，补一条批量快照的部分失败断言（单条失败只写 `SnapshotResult.error`）。
- **假设**：`.plugin-backups` 位于 `$DSH_HOME` 下（`src-tauri/src/service/plugin/snapshot.rs:39`），debug 构建中即 `<DSH_E2E_HOME>/home/.dsh.dev/.plugin-backups`，因此与用户真实数据隔离。
