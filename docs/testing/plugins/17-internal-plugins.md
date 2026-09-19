# 内置插件：离线物化、自愈与弃用清理

> 层级：L3 桌面端宿主 E2E（真实 Tauri 窗口）
> 自动化：`test/e2e/specs/desktop/internal-plugins.e2e.ts`（待接线，见 `00-overview.md` G4）
> 前置：应用已启动；`resources/node_modules/` 内已随包分发内置插件产物；档案可写
> 运行：待接线（`desktop` project 未配置，见 `00-overview.md` G4）

本文件补齐归档套件里**没有明确用例、但现行实现已有完整机制**的一整块：内置插件随包分发、启动自愈、离线兜底、弃用包自动卸载。覆盖依据是 `src-tauri/src/service/plugin/internal/**` 与 `src-tauri/src/service/workflow/launch.rs` 的编排顺序。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 内置清单 10 条（`id` / `spec` / `name` / `description` / `repoUrl`，必要时带 `package`） | `src-tauri/resources/internal-plugins.json:3`、`src-tauri/resources/README.md:76` |
| 打包方式：`pnpm deploy` 工作区包 → `resources/node_modules/<name>` | `scripts/build-plugins.ts:28`、`scripts/build-plugins.ts:550`、`src-tauri/resources/README.md:81` |
| 运行时查找：`resources/node_modules/<name>`，兼容旧目录 `resources/internal-plugins/<id>` | `src-tauri/src/service/plugin/preset.rs:281`、`src-tauri/src/service/plugin/preset.rs:315` |
| 旧目录启动清理 | `src-tauri/src/service/plugin/preset.rs:338` |
| 内置插件强制 `link:<捆绑目录>` | `src-tauri/src/service/plugin/install/spec.rs:30` |
| 离线物化：自建目录链接 + 写回 dependencies/bundles | `src-tauri/src/service/plugin/internal/materialize.rs:37`、`src-tauri/src/service/plugin/internal/materialize.rs:107` |
| 自愈命令 `ensure_internal_plugins` / `cancel_internal_plugins` | `src-tauri/src/bridge/plugin.rs:95`、`src-tauri/src/bridge/plugin.rs:101` |
| 启动编排顺序：npmrc → 弃用卸载 → 内置自愈 → 预设补齐 | `src-tauri/src/service/workflow/launch.rs:461`、`src-tauri/src/service/workflow/launch.rs:467`、`src-tauri/src/service/workflow/launch.rs:474`、`src-tauri/src/service/workflow/launch.rs:482` |
| 就绪判定：`dependencies` 匹配 `link:` 且包体可解析为对象 | `src-tauri/src/service/plugin/internal/mod.rs:624`、`src-tauri/src/service/plugin/internal/manifest.rs:263` |
| 单飞协调 + 绝对超时 600s + 心跳 5s | `src-tauri/src/service/plugin/internal/mod.rs:96`、`src-tauri/src/service/plugin/internal/mod.rs:69`、`src-tauri/src/service/plugin/internal/mod.rs:459` |
| 可写性预检 | `src-tauri/src/service/plugin/internal/mod.rs:260` |
| 阶段事件 `internal-plugins-phase` | `src-tauri/src/service/plugin/internal/mod.rs:506` |
| 失败码：`INTERNAL_PLUGIN_INSTALL_FAILED` / `INTERNAL_PLUGIN_PATCH_PARSE_FAILED` | `src-tauri/src/service/plugin/internal/mod.rs:750`、`src-tauri/src/service/plugin/internal/mod.rs:197` |
| 弃用清单（纯字符串数组 4 项）与自动卸载 | `src-tauri/resources/deprecated-plugins.json:1`、`src-tauri/src/service/workflow/launch.rs:467` |
| 前端 boot 阶段再次自愈 + 超时预算 | `src/store/modules/harness/store.ts:533`、`src/store/modules/harness/constants.ts:20` |

---

## 2. 用例

### [P1] 验证全新档案下的内置插件自愈补齐依赖与 bundles

[Case ID] TC-INT-L3-001
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/internal/materialize.rs:37`、`src-tauri/src/service/workflow/launch.rs:474`
[自动化] 待接线（`desktop` project 未配置）
[前置条件] 新建一个空 scratch 档案（无 `dependencies`、无 `node_modules`）；`resources/node_modules/` 下内置产物齐全
[测试数据] 无
[测试步骤] 1. 切换到空档案并启动服务。2. 读该档案的 `package.json` 与 `node_modules`。3. 读 `internal-plugins.json` 的 10 个 id。
[预期结果] 1. `dependencies` 中出现全部内置 id，且值形如 `link:<捆绑目录>`。2. `dsh.profile.bundles` 同步包含这些 id。3. `node_modules/<name>` 可解析（存在可读的 `package.json`）。4. 服务进入 Running，界面无插件加载失败页。
[清理] 删除该 scratch 档案

### [P2] 验证内置插件产物缺失时给出可诊断的失败而非静默

[Case ID] TC-INT-L3-002
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/plugin/internal/mod.rs:750`、`src-tauri/src/service/plugin/install/artifact.rs:78`
[自动化] 待接线（同上）
[前置条件] 临时移走 `resources/node_modules/` 中某一个内置插件目录
[测试数据] 被移走的插件名
[测试步骤] 1. 切换到一个未装该内置插件的新档案并启动。2. 读错误文案与界面呈现。
[预期结果] 1. 返回错误，前缀为 `INTERNAL_PLUGIN_INSTALL_FAILED`（或离线兜底失败时的 `PREINSTALL_SILENT_FAIL` 变体）。2. 界面给出可操作提示（含日志入口），而非静默跳过。3. 其余内置插件的依赖项仍被写入（不因单个失败整体放弃）。
[清理] 恢复被移走的目录

### [P3] 验证内置目录写回可离线完成（无网络）

[Case ID] TC-INT-L3-003
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/internal/materialize.rs:107`
[自动化] 待接线（同上；需断网）
[前置条件] 全新 scratch 档案；断网（或使 npm/git 源不可达）
[测试数据] 无
[测试步骤] 1. 断网后启动服务。2. 读档案 `package.json` 与 `node_modules`。3. 观察是否出现下载/网络类失败。
[预期结果] 1. 内置插件的 `link:` 依赖仍被写入。2. `node_modules` 下出现自建目录链接。3. 不出现需要联网的 `dsh plugin add` 重试风暴（离线兜底优先）。
[清理] 恢复网络；删除档案

### [P2] 验证就绪判定能识别「已写好但包体不可解析」的坏状态

[Case ID] TC-INT-L3-004
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/plugin/internal/mod.rs:624`、`src-tauri/src/service/plugin/internal/manifest.rs:263`
[自动化] 待接线（同上）
[前置条件] 某内置插件已写入 `dependencies`，但其 `node_modules/<name>/package.json` 被写成非法 JSON
[测试数据] 目标内置插件名
[测试步骤] 1. 制造坏状态后启动服务。2. 读自愈过程是否为该插件重新物化。3. 读最终 `package.json` 内容。
[预期结果] 1. 自愈**不**把该状态判定为就绪（坏 JSON 不算可解析）。2. 自愈动作后包体恢复为可解析状态（或被明确兜底重建）。3. 服务最终进入 Running。
[清理] 恢复正常产物

### [P3] 验证自愈有绝对超时与可取消

[Case ID] TC-INT-L3-005
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/plugin/internal/mod.rs:69`、`src-tauri/src/bridge/plugin.rs:101`
[自动化] 待接线（同上）
[前置条件] 让自愈过程变慢（例如把 `node_modules` 设为只读或制造 pnpm 慢路径）
[测试数据] 无
[测试步骤] 1. 启动应用并在自愈进行中调 `cancel_internal_plugins`。2. 记录取消后的阶段事件与进程状态。3. 观察是否在 600s 内必然结束。
[预期结果] 1. 取消后自愈不再继续（前端退出等待态）。2. 进程树被回收，无残留 node/pnpm 进程。3. 若超时上限到达，必然终止而非无限等待。
[清理] 恢复环境

### [P2] 验证弃用插件在启动时被自动卸载

[Case ID] TC-INT-L3-006
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/workflow/launch.rs:467`、`src-tauri/resources/deprecated-plugins.json:1`
[自动化] 待接线（同上）
[前置条件] 在 scratch 档案中人为写入一个存在于弃用清单中的包（如 `dsh-notification`）
[测试数据] 弃用清单中的包名
[测试步骤] 1. 写入依赖与 bundles。2. 启动服务。3. 读 `dependencies`、`bundles`、`node_modules` 与插件清单。
[预期结果] 1. 启动后该包从 `dependencies` 与 `dsh.profile.bundles` 中被移除。2. `node_modules` 中对应目录被清理。3. 插件清单中不再出现该包。4. 其他插件不受影响。
[清理] 清理 scratch 档案

### [P4] 验证弃用卸载在无网络时仍能完成

[Case ID] TC-INT-L3-007
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/workflow/launch.rs:467`
[自动化] 待接线（同上；需断网）
[前置条件] 同 TC-INT-L3-006，且断网
[测试数据] 弃用包名
[测试步骤] 1. 断网后启动服务。2. 读三处文件。
[预期结果] 1. 依赖与 bundles 仍被清理。2. 不因断网阻塞启动（服务仍进入 Running）。3. 无残留半成品依赖项。
[清理] 恢复网络；清理档案

### [P3] 验证旧资源目录在启动时被清理

[Case ID] TC-INT-L3-008
[层级] L3（真实 Tauri 窗口）
[类型] 回归
[追踪] `src-tauri/src/service/plugin/preset.rs:338`
[自动化] 待接线（同上）
[前置条件] 在应用资源目录下手动创建旧形态目录 `resources/internal-plugins/`
[测试数据] 旧目录及其中的一个占位子目录
[测试步骤] 1. 创建旧目录。2. 启动应用。3. 读该目录是否存在与启动日志。
[预期结果] 1. 旧目录被移除（升级残留清理）。2. 启动不受影响，服务进入 Running。3. 内置插件仍从新路径加载。
[清理] 无需清理（目录已被移除）

---

## 3. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `src-tauri/resources/README.md:76`（内置插件随包分发 + 启动自愈） | TC-INT-L3-001、TC-INT-L3-002 | 正向 / 异常 | 归档套件未为该机制设用例 |
| `internal/materialize.rs:107`（离线物化） | TC-INT-L3-003 | 正向 | 需断网构造 |
| `internal/mod.rs:624`（就绪判定） | TC-INT-L3-004 | 异常 | — |
| `internal/mod.rs:69`、`bridge/plugin.rs:101`（超时与取消） | TC-INT-L3-005 | 边界 | — |
| `deprecated-plugins.json:1` + `launch.rs:467`（弃用自动卸载） | TC-INT-L3-006、TC-INT-L3-007 | 正向 / 边界 | 归档套件未覆盖 |
| `preset.rs:338`（旧目录清理） | TC-INT-L3-008 | 回归 | — |
| `06-plugin/04` 的预装安装链路（社区插件） | `14-preinstall-and-preset.md` | — | 与内置自愈是两条不同链路，勿混用 |

---

## 4. 缺口与假设

- **G-INT-1**：内置插件自愈是**启动链的一部分**（`src-tauri/src/service/workflow/launch.rs:474`），因此这些用例的前置天然包含「可启动的服务」。若服务本身起不来，失败应归因到启动链，而不是本文件的插件断言。
- **G-INT-2**：TC-INT-L3-002 与 TC-INT-L3-004 需要改动应用**资源目录**（安装目录），而非测试数据目录。这违反「不改写用户环境」的一般原则，执行时必须先备份并在用例结束恢复；无法恢复时应中止而不是继续。
- **G-INT-3**：`internal-plugins.json` 现有 10 条，但其中部分插件的 `package` 字段与 `id` 不同（`src-tauri/resources/README.md:80`）。用例一律以运行时解析出的包名/目录名为准，不硬编码归档套件中的老包名。
- **G-INT-4**：前端在 boot 阶段会再调一次 `ensure_internal_plugins`（`src/store/modules/harness/store.ts:533`），前端超时预算为 600s/30s（`src/store/modules/harness/constants.ts:20`）。UI 层的等待表现归 `../desktop/11-startup-error.md`，本文件只断言最终文件状态。
- **假设**：`resources/node_modules/` 在 debug 构建下同样可用（`src-tauri/src/service/plugin/preset.rs:257` 含 CARGO_MANIFEST_DIR 兜底），因此这些用例不需要安装版即可执行。
