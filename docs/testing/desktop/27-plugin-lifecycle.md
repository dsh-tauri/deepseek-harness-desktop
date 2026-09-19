# 插件升级/卸载/恢复与内置插件自愈

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/desktop/27-plugin-lifecycle.e2e.ts`（待建立）
> 前置：`09-plugin-panel.md` 与 `10-plugin-recovery.md` 通过；具备可写档案夹具
> 运行：`vitest --project desktop -- test/e2e/desktop/27-plugin-lifecycle.e2e.ts`（待配置，见 G2）

本文件覆盖插件生命周期的**写路径**：升级、卸载、禁用/启用、快照与还原、异常注册表、恢复卸载，以及启动期的内置插件自愈与文件监控。核心约定是「不报虚假成功」——升级未落地、卸载未生效、启用仍被覆盖时都必须如实失败。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 命令面：`get_dsh_plugins` / `refresh_plugin_updates` / `update_dsh_plugin` / `remove_dsh_plugin` / `report_plugin_error` / `detect_plugin_recovery` / `recover_plugin` / `disable_dsh_plugin` / `enable_dsh_plugin` | `src-tauri/src/bridge/plugin.rs:127`、`:139`、`:148`、`:157`、`:166`、`:195`、`:207`、`:217`、`:230` |
| 命令面：`snapshot_plugin` / `snapshot_plugins` / `get_plugin_backup` / `restore_plugin` / `delete_plugin_backup` / `ensure_internal_plugins` / `cancel_internal_plugins` | `src-tauri/src/bridge/plugin.rs:243`、`:249`、`:258`、`:267`、`:275`、`:95`、`:101` |
| 命令注册于构建器 | `src-tauri/src/desktop/builder.rs:884`、`:885`、`:887`-`:900` |
| 升级参数带 `--latest`（否则范围钉死时退化为假成功） | `src-tauri/src/service/plugin/install/single.rs:49` |
| 假成功核验：升级前后依赖指纹一致 → `PLUGIN_UPDATE_NO_CHANGE` | `src-tauri/src/service/plugin/install/single.rs:365`、`:370`、`:376` |
| 依赖指纹取自 lock 当前 importer 的 `specifier @ version`，读不到则回落 node_modules 版本 | `src-tauri/src/service/plugin/install/single.rs:62`、`:74` |
| 升级/卸载前先停服务；停服失败则跳过自动快照 | `src-tauri/src/service/plugin/install/single.rs:271`、`:278` |
| 升级前自动快照（覆盖式，失败仅告警） | `src-tauri/src/service/plugin/install/single.rs:289`、`:290` |
| 升级成功后核验声明入口，缺失则就地补构建（`build`/`prepare`/`tsdown`） | `src-tauri/src/service/plugin/install/single.rs:384`；`src-tauri/src/service/plugin/install/artifact.rs:219`、`:253` |
| 入口缺失/构建失败 → `PLUGIN_ENTRY_MISSING`；无可用 pnpm → `PNPM_NOT_FOUND` | `src-tauri/src/service/plugin/install/artifact.rs:228`、`:246`、`:321` |
| 卸载后核验清单：仍被引用则回落离线卸载（受保护包除外） | `src-tauri/src/service/plugin/install/single.rs:116`、`:127`、`:135` |
| 卸载成功后级联删除单插件快照（best-effort） | `src-tauri/src/service/plugin/install/single.rs:143` |
| 安装侧 `NODE_NOT_FOUND` / 取消信号 `PLUGIN_OPERATION_CANCELLED` | `src-tauri/src/service/plugin/install/mod.rs:196`、`:421`、`:425` |
| 错误记录持久化到桌面数据目录 `plugin-errors.json`（与 `$DSH_HOME` 分离）；同 id 幂等覆盖，成功后清除 | `src-tauri/src/service/plugin/errors.rs:31`、`:53`、`:70` |
| 错误记录结构 `{message, action, at}`（camelCase），action ∈ install/update/remove/runtime | `src-tauri/src/service/plugin/errors.rs:21`、`:24` |
| 列表并入错误注册表；已恢复的 install 错误（版本已可解析）被过滤 | `src-tauri/src/service/plugin/watch.rs:230`、`:233`、`:245` |
| 运行期上报记录后立即 `force_emit` 列表并推 `plugin-recovery-required` | `src-tauri/src/bridge/plugin.rs:172`、`:178`、`:186` |
| `plugin-recovery-required` 事件名 | `src-tauri/src/service/plugin/recovery/mod.rs:37` |
| 定位：从日志提取引用并按「唯一归属」回配置根插件，证据不唯一则返回空（绝不瞎猜） | `src-tauri/src/service/plugin/recovery/mod.rs:118`、`:124`；`src-tauri/src/service/plugin/recovery/ownership.rs:217`、`:225`、`:244` |
| 恢复卸载拒绝核心/官方包 → `PLUGIN_RECOVERY_REFUSED`；核心判定为 `@deepseek-ai/` 前缀 | `src-tauri/src/service/plugin/recovery/mod.rs:49`、`:161`、`:163` |
| profile 清单缺失 → `PLUGIN_RECOVERY_NO_MANIFEST` | `src-tauri/src/service/plugin/recovery/mod.rs:169` |
| 恢复卸载：改清单 + 删 `node_modules/<id>` + 剥 `cordis.patch.yml` + 清 lockfile + 清错误 | `src-tauri/src/service/plugin/recovery/mod.rs:176`、`:185`、`:186`、`:188`、`:193` |
| 离线卸载的路径逃逸防护与 scoped 空目录清理 | `src-tauri/src/service/plugin/recovery/uninstall.rs:61`、`:85`、`:104` |
| 禁用清单 `disabled-plugins.json`；条目 `{disabledAt, reason:"user"}` | `src-tauri/src/service/plugin/disable.rs:31`、`:22`、`:299` |
| 禁用 = 写清单 + 仅从 `dsh.profile.bundles` 移除（不动 dependencies）；manifest 写失败回滚清单 | `src-tauri/src/service/plugin/disable.rs:274`、`:303`、`:306`、`:307`、`:254` |
| 配置覆盖禁用来自 `cordis.patch.yml` 顶层 `disabled` 真值条目，优先级高于桌面清单 | `src-tauri/src/service/plugin/disable.rs:64`、`:97`、`:132` |
| 启用校验：未安装 → `ENABLE_NOT_INSTALLED`；两处都未禁用 → `ENABLE_NOT_DISABLED`；有配置覆盖但未显式确认 → `ENABLE_CONFIG_OVERRIDE` | `src-tauri/src/service/plugin/disable.rs:355`、`:363`、`:370` |
| 确认后启用：先剥配置覆盖（幂等，只摘该插件条目）→ 清桌面清单 → 写回 bundles；写失败回滚 | `src-tauri/src/service/plugin/disable.rs:375`、`:376`、`:379`、`:382`、`:386` |
| 禁用/启用持有插件操作锁并在结束后推送列表 | `src-tauri/src/service/plugin/disable.rs:395`、`:398`、`:408`、`:411` |
| 快照路径 `$DSH_HOME/.plugin-backups/<id>.tgz`（测试中为 `$E2E_HOME/home/.dsh.dev/.plugin-backups/`，见 §5.3），覆盖式：临时文件 + fsync + 同盘 rename | `src-tauri/src/service/plugin/snapshot.rs:39`、`:358`、`:376` |
| 归档内嵌 `manifest.json`（pluginId/created/includeConfig/spec/patches/entryCount/archiveSize），还原前校验完整性 | `src-tauri/src/service/plugin/snapshot.rs:87`、`:320`、`:362`、`:599`、`:600` |
| v1 快照只含包体（`includeConfig` 恒 false），打包真实目录并跳过符号链接 | `src-tauri/src/service/plugin/snapshot.rs:11`、`:14`、`:367` |
| 查询按文件存在性 + manifest；删除幂等（不存在视为成功） | `src-tauri/src/service/plugin/snapshot.rs:440`、`:476`、`:481` |
| 还原拒绝核心/官方包 → `SNAPSHOT_RESTORE_REFUSED`；无快照 → `SNAPSHOT_NOT_FOUND` | `src-tauri/src/service/plugin/snapshot.rs:588`、`:590`、`:596` |
| 还原为三阶段 + 回滚：暂存解压校验 → 真实目录 rename 到 `.backup-*` → 暂存包 rename 到真实目录 → 核验后清理 | `src-tauri/src/service/plugin/snapshot.rs:627`、`:650`、`:655`、`:665`、`:674` |
| 还原内部持操作锁并停服务；插件曾被移除时写回清单引用并删 lockfile | `src-tauri/src/service/plugin/snapshot.rs:603`、`:604`、`:679`、`:680`、`:682` |
| 内置插件自愈 `ensure`：可写性预检 → `repair_loader_state` → 串行化 flight | `src-tauri/src/service/plugin/internal/mod.rs:241`、`:257`、`:263`、`:264` |
| 待重装判定：依赖声明不匹配当前捆绑目录，或 node_modules 入口不真实存在 | `src-tauri/src/service/plugin/internal/mod.rs:628`、`:632`、`:633` |
| 捆绑目录缺失（release 打包缺陷 / debug 无匹配源码）只告警跳过 | `src-tauri/src/service/plugin/internal/mod.rs:585`、`:604` |
| 捆绑源目录 `package.json` 不可读 → `INTERNAL_PLUGIN_SOURCE_MISSING`（阻断本轮重装） | `src-tauri/src/service/plugin/internal/mod.rs:618`、`:620` |
| 健康入口不删除重建，交给本轮 `dsh plugin add` 重写依赖声明 | `src-tauri/src/service/plugin/internal/mod.rs:707`、`:709` |
| 自愈阶段事件 `internal-plugins-phase`；detail 枚举 waiting/checking/installing/heartbeat/done/timeout/cancelled | `src-tauri/src/service/plugin/internal/mod.rs:505`、`:506`、`:53`、`:55` |
| 绝对上限 `ENSURE_ABSOLUTE_TIMEOUT = 10*60` 秒；heartbeat 周期 5 秒 | `src-tauri/src/service/plugin/internal/mod.rs:69`、`:459`、`:460`、`:491`、`:492` |
| 超时 → `INTERNAL_PLUGIN_INSTALL_TIMEOUT`（600 秒）；取消 → `INTERNAL_PLUGIN_INSTALL_CANCELLED` | `src-tauri/src/service/plugin/internal/mod.rs:469`、`:481` |
| 共享 flight 串行化：并发触发订阅同一轮，Retry 不继承已取消 flight | `src-tauri/src/service/plugin/internal/mod.rs:302`、`:307`、`:344`、`:355`、`:360` |
| `cancel` 等待所属进程树退出后才返回 | `src-tauri/src/service/plugin/internal/mod.rs:411`、`:412`、`:426` |
| 捆绑目录定位：debug 优先命中仓库根 `packages/*` 源码，release 用 `resources/node_modules/<name>` | `src-tauri/src/service/plugin/preset.rs:315`、`:316`、`:317`、`:326` |
| 自愈在启动路径被调用（best-effort，失败只告警） | `src-tauri/src/service/workflow/launch.rs:474`、`:475` |
| 前端 boot 流程显式调用自愈，超时后调取消；并订阅阶段事件驱动 `startupPhase = 'plugin-install'` | `src/store/modules/harness/store.ts:539`、`:556`、`:225`、`:234` |
| 插件文件监控指纹 = profile 清单 + 各直接依赖清单 + `cordis.patch.yml` + `disabled-plugins.json` | `src-tauri/src/service/plugin/watch.rs:283`、`:290`、`:298` |
| 防抖窗口 `DEBOUNCE = Duration::from_secs(2)` | `src-tauri/src/service/plugin/watch.rs:30` |
| 已推送指纹一致则跳过；窗口内变化只记 pending，之后补推 | `src-tauri/src/service/plugin/watch.rs:333`、`:338`、`:339`、`:345` |
| 事件名 `PLUGINS_UPDATED_EVENT = "dsh-plugins-updated"`；`force_emit` 同步指纹后立即推 | `src-tauri/src/service/plugin/watch.rs:26`、`:258`、`:271`、`:273` |
| 监控由 5 秒轮询驱动 | `src-tauri/src/service/scheduler/mod.rs:16`、`:24` |
| 前端根布局订阅事件写列表缓存；插件面板另订阅一次 | `src/layout/index.tsx:36`；`src/ui/config/plugin.tsx:73` |
| 面板写操作与失效查询：升级/卸载/禁用/启用/快照/还原/删除快照 | `src/ui/config/plugin.tsx:84`、`:99`、`:113`、`:126`、`:140`、`:153`、`:165` |
| 升级/卸载后统一 `store.harness.restart()` | `src/ui/config/plugin.tsx:193`、`:226` |
| 恢复界面按快照存在性过滤还原入口的入参 | `src/ui/plugin/recovery.tsx:49`、`:59`、`:145` |

---

## 2. 升级与卸载

### [P1] 验证升级成功落地后清除错误并重启服务

[Case ID] TC-DSK-L3-234
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/bridge/plugin.rs:148`；`src-tauri/src/service/plugin/install/single.rs:49`、`:353`
[自动化] 待接线（`test/e2e/desktop/27-plugin-lifecycle.e2e.ts`）
[前置条件] 存在确有更新的第三方插件；服务健康；registry 可达
[测试数据] 命令 `update_dsh_plugin`（入参 `{id}`）；事件 `preinstall-log`、`dsh-plugins-updated`
[测试步骤] 1. 记录该插件当前版本。2. 调用 `update_dsh_plugin`。3. 读取命令返回与 `preinstall-log` 中的 pnpm 输出。4. 等待收敛后读取 `get_dsh_plugins` 的版本、`error` 与服务状态。
[预期结果] 1. 记录成功。2. 命令返回成功。3. 日志含 `dsh plugin update` 的实时输出行。4. 版本高于记录值；该插件 `error` 为空（成功后清除历史错误）；服务恢复健康。
[清理] 还原插件版本；`DELETE /session/<id>`

### [P3] [反向] 验证升级未落地时报 PLUGIN_UPDATE_NO_CHANGE

[Case ID] TC-DSK-L3-235
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/plugin/install/single.rs:365`、`:370`、`:376`、`:74`
[自动化] 待接线（`test/e2e/desktop/27-plugin-lifecycle.e2e.ts`）
[前置条件] 某已安装插件的 spec 被 catalog 条目钉死，使 pnpm 以 0 退出但依赖指纹不变
[测试数据] 命令 `update_dsh_plugin`；日志标记 `PLUGIN_UPDATE_NO_CHANGE`
[测试步骤] 1. 记录升级前的依赖指纹（lock 中 `specifier @ version`）。2. 调用 `update_dsh_plugin`。3. 读取命令错误返回。4. 重新记录该插件的依赖指纹与 `get_dsh_plugins` 中的 `error`。
[预期结果] 1. 记录成功。2. 调用被接受。3. 错误以 `PLUGIN_UPDATE_NO_CHANGE` 开头，含当前版本与「the profile pins this dependency」说明。4. 指纹与步骤 1 一致（确实未落地）；`error.action` 为 `update` 且 `error.message` 为同一错误，不报成功。
[清理] 移除钉死条目后重新升级；`DELETE /session/<id>`

### [P2] 验证卸载成功且级联删除该插件快照

[Case ID] TC-DSK-L3-236
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/bridge/plugin.rs:157`；`src-tauri/src/service/plugin/install/single.rs:116`、`:143`
[自动化] 待接线（`test/e2e/desktop/27-plugin-lifecycle.e2e.ts`）
[前置条件] 存在第三方可卸载插件且已创建过快照；服务健康
[测试数据] 命令 `remove_dsh_plugin`、`snapshot_plugin`、`get_plugin_backup`
[测试步骤] 1. 对该插件创建快照并读回 `exists`。2. 调用 `remove_dsh_plugin`。3. 读取命令返回。4. 读取 `get_dsh_plugins` 与 `get_plugin_backup`。
[预期结果] 1. `exists` 为真。2. 命令返回成功。3. 无错误返回。4. 列表中不再出现该 id（`is_installed` 复核为假，故未触发离线兜底）；快照 `exists` 为假（级联清理）。
[清理] 重新安装该插件；`DELETE /session/<id>`

### [P3] [反向] 验证卸载不存在的插件如实报错且不改动其它插件

[Case ID] TC-DSK-L3-237
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/bridge/plugin.rs:157`；`src-tauri/src/service/plugin/install/single.rs:116`
[自动化] 待接线（`test/e2e/desktop/27-plugin-lifecycle.e2e.ts`）
[前置条件] 使用一个既不在 profile `dependencies` 也无 `node_modules` 入口的 id
[测试数据] 命令 `remove_dsh_plugin`（入参 `{id: "dsh-nonexistent-probe"}`）
[测试步骤] 1. 记录当前插件集合。2. 调用 `remove_dsh_plugin`。3. 读取命令返回。4. 再次读取插件集合。
[预期结果] 1. 记录成功。2. 调用被接受。3. 返回错误且信息非空（`is_installed` 为假故不走离线兜底，命令行退出码如实上报）。4. 集合与记录完全一致，未误伤其它插件。
[清理] `DELETE /session/<id>`

---

## 3. 禁用、启用与快照还原

### [P2] 验证禁用只移出 bundles 且启用可原地恢复

[Case ID] TC-DSK-L3-238
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/disable.rs:274`、`:303`、`:299`、`:382`
[自动化] 待接线（`test/e2e/desktop/27-plugin-lifecycle.e2e.ts`）
[前置条件] 存在非内置、已安装、未被禁用的第三方插件
[测试数据] 命令 `disable_dsh_plugin`、`enable_dsh_plugin`、`get_dsh_plugins`
[测试步骤] 1. 调用 `disable_dsh_plugin` 并读取 profile 两个文件。2. 读取 `get_dsh_plugins` 中该插件字段。3. 调用 `enable_dsh_plugin`（不传确认标志）。4. 再次读取 profile 两个文件与列表字段。
[预期结果] 1. 命令成功；该 id 已从 `dsh.profile.bundles` 移除，`dependencies` 中仍保留；`disabled-plugins.json` 有条目且 `reason` 为 `user`。2. `bundled` 为假、`disabled` 为真（包体未删除）。3. 命令成功（无配置覆盖时无需确认）。4. 该 id 回到 `bundles`；禁用清单条目已移除；`bundled` 为真、`disabled` 为假。
[清理] `DELETE /session/<id>`

### [P3] [反向] 验证配置覆盖禁用时未确认则拒绝启用且不改写配置

[Case ID] TC-DSK-L3-239
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/plugin/disable.rs:370`、`:368`、`:375`、`:376`、`:132`
[自动化] 待接线（`test/e2e/desktop/27-plugin-lifecycle.e2e.ts`）
[前置条件] 某插件在 `cordis.patch.yml` 中有 `disabled: true` 的顶层条目
[测试数据] 命令 `enable_dsh_plugin`（先后以缺省与 `true` 传 `clearConfigOverride`）
[测试步骤] 1. 读取该插件 `patchDisabled` 与 `cordis.patch.yml` 内容。2. 调用 `enable_dsh_plugin` 不传确认标志。3. 读取错误返回与 `cordis.patch.yml`。4. 传 `clearConfigOverride: true` 再次调用，并读取该文件与 `bundles`。
[预期结果] 1. `patchDisabled` 为真。2. 返回 `ENABLE_CONFIG_OVERRIDE`。3. 文件逐字节未变（绝不静默绕过更高优先级的覆盖）。4. 调用成功；仅该插件的禁用条目被摘除，其它配置键原样保留；该 id 已加回 `bundles`。
[清理] 恢复 `cordis.patch.yml`；`DELETE /session/<id>`

---

### [P2] 验证快照创建、覆盖与删除幂等

[Case ID] TC-DSK-L3-240
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/snapshot.rs:358`、`:376`、`:440`、`:476`、`:481`
[自动化] 待接线（`test/e2e/desktop/27-plugin-lifecycle.e2e.ts`）
[前置条件] 存在第三方已安装插件；`$E2E_HOME/home/.dsh.dev/.plugin-backups` 下无该 id 的归档（§5.3）
[测试数据] 命令 `snapshot_plugin`、`get_plugin_backup`、`delete_plugin_backup`、`get_dsh_plugins`
[测试步骤] 1. 调用 `snapshot_plugin` 并读取返回。2. 再次调用 `snapshot_plugin`（覆盖）。3. 读取 `get_plugin_backup` 与列表中的 `hasSnapshot`。4. 调用 `delete_plugin_backup` 两次后读取 `get_plugin_backup`。
[预期结果] 1. 返回含 `id`/`created`/`size`，`includeConfig` 为假。2. 第二次成功且整体替换，归档仍只有一份。3. `exists` 为真、`created` 不早于首次、`hasSnapshot` 为真。4. 两次删除均返回成功（幂等）；`exists` 为假、`size` 为 0。
[清理] `DELETE /session/<id>`

### [P2] 验证还原后版本回到快照态并写回清单引用

[Case ID] TC-DSK-L3-241
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/snapshot.rs:586`、`:650`、`:655`、`:665`、`:680`
[自动化] 待接线（`test/e2e/desktop/27-plugin-lifecycle.e2e.ts`）
[前置条件] 已对某第三方插件创建快照；之后该插件升级到更高版本
[测试数据] 命令 `restore_plugin`、`get_dsh_plugins`、`get_plugin_backup`
[测试步骤] 1. 记录快照态版本与快照 `created`。2. 升级该插件并确认版本已变高。3. 调用 `restore_plugin`。4. 读取插件版本、profile 清单引用与快照存在性。
[预期结果] 1. 记录成功。2. 版本高于快照态。3. 命令成功（内部停服务后走三阶段切换与还原后核验）。4. 版本回到快照态；该 id 在 `dependencies` 与 `dsh.profile.bundles` 中均被引用；快照 `exists` 仍为真（还原不删快照）。
[清理] 升级回最新；`DELETE /session/<id>`

### [P3] [反向] 验证无快照与核心包还原被拒绝

[Case ID] TC-DSK-L3-242
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/plugin/snapshot.rs:596`、`:588`、`:590`；`src-tauri/src/service/plugin/recovery/mod.rs:49`
[自动化] 待接线（`test/e2e/desktop/27-plugin-lifecycle.e2e.ts`）
[前置条件] 存在一个无快照的第三方插件；另有一个 `@deepseek-ai/` 前缀的核心包
[测试数据] 命令 `restore_plugin`、`snapshot_plugin`
[测试步骤] 1. 对无快照插件调用 `restore_plugin`。2. 读取错误返回。3. 对核心包调用 `snapshot_plugin`。4. 对核心包调用 `restore_plugin` 并读取错误返回。
[预期结果] 1. 调用被接受。2. 返回 `SNAPSHOT_NOT_FOUND: <id> 无快照`，且该插件目录未被改动。3. 创建成功（快照创建不限范围，属只读操作）。4. 返回 `SNAPSHOT_RESTORE_REFUSED`，核心/官方包不允许还原。
[清理] 删除为验证创建的快照；`DELETE /session/<id>`

---

## 4. 异常注册表、恢复卸载与内置插件自愈

### [P3] 验证运行期异常上报后持久化并推送修复界面

[Case ID] TC-DSK-L3-243
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/bridge/plugin.rs:166`、`:172`、`:178`、`:186`；`src-tauri/src/service/plugin/errors.rs:31`、`:53`
[自动化] 待接线（`test/e2e/desktop/27-plugin-lifecycle.e2e.ts`）
[前置条件] 应用处于 `ready`；某已安装插件可被构造运行期异常
[测试数据] 命令 `report_plugin_error`（入参 `{id, error, action}`）；事件 `plugin-recovery-required`、`dsh-plugins-updated`
[测试步骤] 1. 调用 `report_plugin_error`。2. 读取桌面数据目录下的 `plugin-errors.json`。3. 读取两个事件。4. 重启应用后再次读取 `get_dsh_plugins` 中该插件的 `error`。
[预期结果] 1. 命令返回成功。2. 该 id 有条目，`action` 等于传入值（未传时缺省为 `runtime`），`at` 为 unix 秒级时间戳字符串。3. 两个事件均到达；`plugin-recovery-required` 载荷的 `plugins` 含该 id、`reason` 为 `runtime`、`rawError` 等于上报原文。4. 重启后记录仍在且列表 `error` 非空（持久化于桌面数据目录，不随重启丢失）。
[清理] 调用 `recover_plugin` 清除该异常；`DELETE /session/<id>`

### [P2] 验证恢复定位的唯一归属与恢复卸载

[Case ID] TC-DSK-L3-244
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/bridge/plugin.rs:195`、`:207`；`src-tauri/src/service/plugin/recovery/mod.rs:118`、`:124`、`:161`、`:163`、`:176`、`:185`、`:186`；`src-tauri/src/service/plugin/recovery/ownership.rs:217`、`:244`
[自动化] 待接线（`test/e2e/desktop/27-plugin-lifecycle.e2e.ts`）
[前置条件] 存在一个可卸的第三方插件（已安装、在 `bundles` 中、且在 `cordis.patch.yml` 中有条目）；profile 清单存在
[测试数据] 命令 `detect_plugin_recovery`（入参 `{logs}`）、`recover_plugin`（先后取核心包 id 与第三方 id）
[测试步骤] 1. 构造一组启动日志，错误特征唯一归属到该第三方插件。2. 调用 `detect_plugin_recovery` 并读取 `PluginRecoveryInfo`。3. 构造归属不唯一（同一错误可被两个根插件解释）的日志，再次调用。4. 对核心包 id 调用 `recover_plugin`。5. 对第三方插件 id 调用 `recover_plugin`。6. 读取 profile 清单、`node_modules` 入口、`cordis.patch.yml` 与 `pnpm-lock.yaml`。
[预期结果] 1. 日志构造完成。2. `plugins` 恰含该根插件 id（唯一归属才返回）；`reason` 为对应判别键；`rawError` 非空。3. `plugins` 为空（证据不唯一时绝不瞎猜，也不误删）。4. 返回 `PLUGIN_RECOVERY_REFUSED: refusing to remove core/official package <id>`，核心包目录未被删除。5. 调用成功（离线精准，不经网络也不走 `dsh plugin remove`）。6. 该 id 已从 `dependencies` 与 `bundles` 移除；`node_modules/<id>` 入口不存在；该插件在 `cordis.patch.yml` 中的条目被剥离而其它配置保留；`pnpm-lock.yaml` 已被删除；该插件错误记录已清除。
[清理] 重新安装该插件；`DELETE /session/<id>`

### [P2] 验证未安装或被卸载的内置插件在启动前被强制重装

[Case ID] TC-DSK-L3-245
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/internal/mod.rs:241`、`:628`、`:632`、`:633`、`:505`、`:491`；`src-tauri/src/service/workflow/launch.rs:474`
[自动化] 待接线（`test/e2e/desktop/27-plugin-lifecycle.e2e.ts`）
[前置条件] 可写档案；某内置插件（`internal == true`）先被用户从面板卸载，其捆绑目录仍存在
[测试数据] 命令 `remove_dsh_plugin`、`ensure_internal_plugins`、`get_dsh_plugins`；事件 `internal-plugins-phase`；日志标记 `INTERNAL_PLUGIN_NEEDS_REINSTALL`
[测试步骤] 1. 卸载该内置插件并确认其已离开列表与 `bundles`。2. 重启应用并等待启动完成。3. 读取启动日志与自愈阶段事件序列。4. 读取 `get_dsh_plugins` 中该条目的 `internal`、`bundled` 与 `node_modules` 入口状态。
[预期结果] 1. 卸载成功。2. 启动完成且服务健康。3. 日志含 `INTERNAL_PLUGIN_NEEDS_REINSTALL`（自愈不因用户卸载而放弃）并标出 `dep_ok=false` 或 `link_ok=false`；事件序列为 `loading`/`waiting` → `progress`/`checking` → `progress`/`installing` → `done`/`done`，其间含 `progress`/`heartbeat` 且间隔约 5 秒。4. 该插件回到列表且 `internal` 与 `bundled` 均为真，依赖声明指向当前捆绑目录、入口真实存在（内置插件不可被永久移除）。
[清理] `DELETE /session/<id>`

### [P4] 验证路径失效的内置插件按当前捆绑目录重建

[Case ID] TC-DSK-L3-246
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/plugin/internal/mod.rs:624`、`:630`、`:707`、`:709`；`src-tauri/src/service/plugin/preset.rs:315`、`:317`
[自动化] 待接线（`test/e2e/desktop/27-plugin-lifecycle.e2e.ts`）
[前置条件] 某内置插件已安装，但 profile 中其 `link:`/`file:` 声明指向的旧捆绑目录已不存在（模拟应用升级移动资源目录）
[测试数据] 命令 `ensure_internal_plugins`；日志标记 `INTERNAL_PLUGIN_ENTRY_HEALTHY`
[测试步骤] 1. 读取 profile 中该插件的依赖声明值。2. 读取 `bundled_plugin_dir` 解析出的当前捆绑目录与预期 spec。3. 触发 `ensure_internal_plugins`。4. 读取自愈后的声明值与 `node_modules` 入口状态。
[预期结果] 1. 声明值指向已不存在的旧路径。2. 解析结果与声明值不匹配（`dep_matches_spec` 为假），而入口链接本身健康（`link_ok` 为真）。3. 调用成功。4. 声明值改写为当前捆绑目录的 spec；入口被保留而非删除重建（日志含 `INTERNAL_PLUGIN_ENTRY_HEALTHY`，避免重解析点创建后的随机回读失败），入口可解析。
[清理] `DELETE /session/<id>`

---

## 5. 文件监控

### [P3] [反向] 验证插件文件变化经 2 秒防抖后推送列表

[Case ID] TC-DSK-L3-247
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/plugin/watch.rs:30`、`:320`、`:333`、`:338`、`:345`、`:26`、`:357`；`src-tauri/src/service/scheduler/mod.rs:16`、`:24`
[自动化] 待接线（`test/e2e/desktop/27-plugin-lifecycle.e2e.ts`）
[前置条件] 监控轮询运行中；可连续多次改写 profile 插件文件（模拟 pnpm 连续写盘）
[测试数据] 事件 `dsh-plugins-updated`；改写目标：profile `package.json`、插件 `package.json`、`cordis.patch.yml`、`disabled-plugins.json`
[测试步骤] 1. 订阅 `dsh-plugins-updated` 并清空历史。2. 在 2 秒窗口内连续多次改写 profile `package.json` 的依赖版本。3. 读取事件次数、时间戳与载荷。4. 仅改写 `disabled-plugins.json`，再读取事件次数与内容。
[预期结果] 1. 订阅成功。2. 改写被接受。3. 窗口内的连续变化合并为一次推送（2 秒防抖），载荷为完整插件列表且版本为最后一次改写值；指纹与上次已推送值一致时不再重复推送。4. 仅改写禁用清单也使指纹变化并触发一次推送（该文件被纳入指纹），列表中的 `disabled` 字段随之变化。
[清理] 恢复被改写文件；`DELETE /session/<id>`

---

## 6. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 升级 | 234、235 | 正向 / 异常 | 升级后入口补构建路径（`artifact.rs:219`、`:253`）与 `PLUGIN_ENTRY_MISSING`（`:321`）、`PNPM_NOT_FOUND`（`:246`）**未覆盖** |
| 卸载 | 236、237 | 正向 / 异常 | 受保护包「命令成功但仍在清单」的告警分支（`single.rs:135`）**未覆盖** |
| 禁用 / 启用 | 238、239 | 正向 / 异常 | `ENABLE_NOT_INSTALLED`（`disable.rs:355`）与 `ENABLE_NOT_DISABLED`（`:363`）**未覆盖** |
| 快照 | 240、242 | 正向 / 异常 | 归档完整性校验失败（`snapshot.rs:320`）需构造损坏归档，**未覆盖** |
| 还原 | 241、242 | 正向 / 异常 | 三阶段切换的中途失败回滚（`snapshot.rs:652`、`:662`、`:671`）**未覆盖** |
| 异常注册表 | 243 | 异常 | 已恢复 install 错误的过滤规则（`watch.rs:233`）与写入错误码 `PLUGIN_ERRORS_*`（`errors.rs:45`-`:49`）**未覆盖** |
| 恢复定位与卸载 | 244 | 正向 | 「唯一归属才返回、否则为空」与拒绝核心包已覆盖；8 类原因（`reason`）的判别与呈现归 `10-plugin-recovery.md`；`PLUGIN_RECOVERY_NO_MANIFEST`（`recovery/mod.rs:169`）**未覆盖** |
| 内置插件自愈 | 245、246 | 正向 / 边界 | 孤儿内置插件卸载（`internal/mod.rs:600`）、`INTERNAL_PLUGIN_SOURCE_MISSING` 阻断（`:620`）与离线自建链接兜底（`:732`、`:740`）**未覆盖** |
| 自愈阶段事件 | 245 | 正向 | 600 秒绝对超时（`:469`）与取消分支（`:481`、`:487`）**未覆盖** |
| 文件监控 | 247 | 异常 | 指纹为 `None`（profile 被移除）时推送空列表（`watch.rs:350`）与 `force_emit` 的立即推送（`:258`）**未覆盖** |
| 并发收敛 | — | — | 共享 flight 串行化（`internal/mod.rs:302`、`:344`）**未覆盖**，依赖子进程计数能力 |
| 预装插件完整性自检 | — | — | `verify.rs:71` 的 `pnpm install` 修复与 `PNPM_INSTALL_FAILED`（`:157`）、`PRESET_PLUGIN_STILL_MISSING`（`:121`）归 `08-preinstall-onboarding.md` |

---

## 7. 缺口与假设

- **G-D27-1**：`PLUGIN_UPDATE_NO_CHANGE`（`single.rs:370`）的复现需要一个把依赖钉死的 profile（典型是 `pnpm-workspace.yaml` 的 `catalog:` 条目）。测试档案默认不写 catalog，接线时须先构造该前置，否则该用例不可执行。
- **G-D27-2**：升级、卸载、还原与恢复卸载都会停掉服务（`single.rs:278`；`snapshot.rs:604`），彼此强耦合，必须一条用例一个批次推进，且每条自带「恢复插件状态 + 等待服务健康」的清理。
- **G-D27-3**：`PNPM_NOT_FOUND` 在两个模块各有出处（`artifact.rs:246` 与 `verify.rs:135`），文案与触发条件不同，接线时不得互相替代。`PNPM_REPAIR_SPAWN` / `PNPM_REPAIR_WAIT`（`verify.rs:247`、`:265`、`:283`、`:294`）只在修复子进程无法启动或等待失败时出现，构造成本高，登记为盲区。
- **G-D27-4**：内置插件的 `bundled_plugin_dir` 在 debug 构建下优先命中仓库根 `packages/*` 源码（`preset.rs:315`-`:317`），release 下用 `resources/node_modules/<name>`。TC-DSK-L3-246 的「旧路径失效」需按构建类型分别构造；debug 下改源码重启服务即热更新，与 release 行为不同。
- **G-D27-5**：`internal-plugins-phase` 的 heartbeat 周期为 5 秒、绝对上限 600 秒（`internal/mod.rs:459`、`:69`）。超时（`:469`）与清理超时（`:473`、`:484`）分支需真实超长安装才能触发；前端另有自己的 inactivity/absolute 双超时（`store.ts:544`、`:545`），两者不互推，不得据前端超时断言后端上限。
- **G-D27-6**：`dsh-plugins-updated` 有两条推送路径——轮询走 2 秒防抖（`watch.rs:30`），写操作后走 `force_emit` 并同步指纹（`watch.rs:258`、`:271`、`:273`）。TC-DSK-L3-247 只覆盖防抖路径（外部改写文件）；`force_emit` 的「立即一次且后续不重复」**未覆盖**，需在写操作批次中补测。
- **G-D27-7**：内置自愈与预装完整性是两套机制——`verify::ensure_preset_plugins`（`verify.rs:71`）针对**预装清单**中「被引用但产物缺失」的插件，用 `pnpm install` 重建；`internal::ensure`（`internal/mod.rs:241`）只针对 `internal == true` 的内置插件。本文件只覆盖后者。
- **假设**：`recover_plugin` 走离线路径（`recovery/mod.rs:160`），不依赖网络也不走 `dsh plugin remove`；因此 TC-DSK-L3-244 只断言清单、入口、patch 层与 lockfile 的终态，不断言 pnpm 行为。
- **假设**：快照的 `includeConfig` 在 v1 恒为 false（`snapshot.rs:11`、`:367`），故所有快照断言均不涉及配置段还原；「从快照还原」的 UI 入口按快照存在性过滤入参（`recovery.tsx:49`、`:59`）已在 `10-plugin-recovery.md` 覆盖。
- **假设**：`cordis.patch.yml` 条目匹配同时接受依赖键与包内 `name` 别名（`disable.rs:117`、`:132`）；TC-DSK-L3-239 使用依赖键形态，别名形态未单独覆盖。
