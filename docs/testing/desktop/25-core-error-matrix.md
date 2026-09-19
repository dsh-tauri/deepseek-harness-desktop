# 核心版本管理：错误码与回滚矩阵

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/specs/desktop/25-core-error-matrix.e2e.ts`（待建立）
> 前置：`14-core-management.md` 通过；配置对话框可打开在「核心」面板
> 运行：`vitest --project desktop -- test/e2e/specs/desktop/25-core-error-matrix.e2e.ts`（待配置，见 G2）

本文件把 `version.rs` 与 `local.rs` 的错误码逐条映射为可观察结果，重点在**切换失败必须回滚**：目录互换第二步失败时激活位要还原，而不是留下半切换的核心。列表渲染与入口可见性归 `14-core-management.md`。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 全部 `CORE_*` 错误码定义 | `src-tauri/src/service/core/version.rs:339`、`:354`、`:360`、`:371`、`:380`、`:390`、`:409`、`:455`、`:463`、`:474`、`:512`、`:514`、`:530`、`:531`、`:542`、`:552`、`:560`、`:564`、`:574` |
| 本地核心三个错误码与输出尾部（末 12 行非空） | `src-tauri/src/service/core/local.rs:274`、`:322`、`:339`（尾部逻辑 `:324`） |
| 转换锁 15 秒超时 `CORE_TRANSITION_TIMEOUT` | `src-tauri/src/service/workflow/process.rs:127`、`:135` |
| `CORE_LOCAL_UNSUPPORTED` 亦作为降级告警日志 | `src-tauri/src/service/core/source.rs:107` |
| 切换前停服与孤儿进程清扫 | `src-tauri/src/service/core/version.rs:330`、`:421` |
| 整个切换持有转换锁（与 launch 共用） | `src-tauri/src/service/core/version.rs:347`、`:404`；`src-tauri/src/service/workflow/process.rs:116` |
| `switch_app_version` 备份、互换与回滚 | `src-tauri/src/service/core/version.rs:443` |
| 下载幂等：`dest.exists()` 直接返回版本行 | `src-tauri/src/service/core/version.rs:500`、`:594` |
| 卸载守卫与删除失败 | `src-tauri/src/service/core/version.rs:550` |
| `local_core_uses_pnpm` 布局判定 | `src-tauri/src/service/core/local.rs:247` |
| 更新命令、Windows `CREATE_NO_WINDOW` 与版本回读 | `src-tauri/src/service/core/local.rs:281`、`:314`、`:342` |
| 核心行字段（camelCase）与 `get_cores` 命令 | `src-tauri/src/service/core/source.rs:43`；`src-tauri/src/bridge/core.rs:12` |
| issue #596：低于基线的本地核心被拒并回退预打包，`active_core` 不改写 | `src-tauri/src/service/core/version.rs:360`；`src-tauri/src/service/core/source.rs:107` |
| 核心面板的标记、下载/卸载/更新入口条件 | `src/ui/config/core.tsx:92`、`:113`、`:416`、`:432` |

---

## 2. 标识与查找

### [P2] 验证非法 id 与不可用目标的错误码

[Case ID] TC-DSK-L3-208
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/core/version.rs:380`、`:552`、`:409`、`:564`、`:354`
[自动化] 待接线（`test/e2e/specs/desktop/25-core-error-matrix.e2e.ts`）
[前置条件] 配置对话框打开在「核心」面板；`dependencies/` 下不存在这些槽位
[测试数据] id `not-a-core`、`app`（用于卸载）、`app-dsh-0.0.0-ghost`、`local`（无本地 CLI 核心时）
[测试步骤] 1. 用 `not-a-core` 切换核心。2. 用 `app` 卸载。3. 用 `app-dsh-0.0.0-ghost` 切换。4. 用 `app-dsh-0.0.0-ghost` 卸载。5. 在无本地 CLI 核心的环境用 `local` 切换。
[预期结果] 1. 返回 `CORE_INVALID_ID: not-a-core`。2. 返回 `CORE_INVALID_ID: app`（卸载只接受 `app-<tag>`）。3. 返回 `CORE_VERSION_NOT_DOWNLOADED: dsh-0.0.0-ghost`。4. 返回 `CORE_VERSION_NOT_FOUND: dsh-0.0.0-ghost`。5. 返回 `CORE_LOCAL_NOT_FOUND: no local core detected`。
[清理] 无（均未落盘）

### [P4] 验证下载幂等：已存在槽位不再联网

[Case ID] TC-DSK-L3-209
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/core/version.rs:500`、`:594`
[自动化] 待接线（`test/e2e/specs/desktop/25-core-error-matrix.e2e.ts`）
[前置条件] `dependencies/<tag>` 已存在完整槽位；可断网或拦截网络请求
[测试数据] 已下载 tag `dsh-<已存在版本>`
[测试步骤] 1. 在可拦截网络的环境下对该 tag 触发下载。2. 读取返回的核心行与槽位目录内容。3. 记录网络请求情况。
[预期结果] 1. 调用立即返回成功。2. 返回行的 `present` 为真、`id` 为 `app-<tag>`、`dir` 指向该槽位，目录内容与调用前逐项一致。3. 未发出任何元数据或资产下载请求。
[清理] 保留该槽位或按需卸载

---

## 3. 切换与回滚

### [P1] 验证成功切换后目录互换与来源标记同步

[Case ID] TC-DSK-L3-210
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/core/version.rs:443`、`:404`、`:421`
[自动化] 待接线（`test/e2e/specs/desktop/25-core-error-matrix.e2e.ts`）
[前置条件] 已下载 tag 为 `dsh-<v2>` 的槽位；当前激活核心为另一版本
[测试数据] 目标 tag `dsh-<v2>`
[测试步骤] 1. 记录切换前 `dependencies/dsh` 对应的版本与 `dependencies/dsh-<v1>` 的存在性。2. 切换到 `app-dsh-<v2>`。3. 读取 `get_cores` 中 `active` 为真的行与磁盘槽位。
[预期结果] 1. 记录成功。2. 切换返回成功。3. `dependencies/dsh` 内容为 `v2`；原激活版本落在 `dsh-<v1>` 槽位；`active` 行 `source` 为 `app`、`tag` 为 `dsh-<v2>`。
[清理] 切回原核心；按需卸载新增槽位

### [P3] [反向] 验证目录互换失败时回滚到原激活版本

[Case ID] TC-DSK-L3-211
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/core/version.rs:443`、`:463`
[自动化] 待接线（`test/e2e/specs/desktop/25-core-error-matrix.e2e.ts`）
[前置条件] 已下载目标 tag 槽位；可在互换窗口内制造目标目录重命名失败（占用或权限）
[测试数据] 目标 tag `dsh-<v2>`；制造失败的手段：占用目标槽位目录句柄或临时改权限
[测试步骤] 1. 记录切换前激活核心版本。2. 制造目标目录重命名失败条件后切换到 `app-dsh-<v2>`。3. 读取返回错误与 `dependencies/dsh` 的内容。4. 读取 `get_cores` 的 `active` 行。
[预期结果] 1. 记录成功。2. 切换返回 `CORE_SWITCH_FAILED`，消息含 `{target} -> {active}` 与底层错误。3. `dependencies/dsh` 被回滚为切换前的版本，内容与记录一致。4. `active` 行仍是切换前的核心，来源标记未被改写。
[清理] 解除占用或恢复权限；切回原核心

### [P3] [反向] 验证备份清理失败即中止，不动激活位

[Case ID] TC-DSK-L3-212
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/core/version.rs:455`、`:443`
[自动化] 待接线（`test/e2e/specs/desktop/25-core-error-matrix.e2e.ts`）
[前置条件] 当前激活版本有 tag 记录；同名残留备份槽位存在且无法删除
[测试数据] 备份槽位名 = 当前激活版本记录的 tag；制造不可删条件：占用备份目录句柄或改权限
[测试步骤] 1. 记录激活核心版本与激活目录内容。2. 制造备份槽位不可删条件。3. 切换到另一已下载 tag。4. 读取错误与激活目录内容。
[预期结果] 1. 记录成功。2. 条件已就绪。3. 返回 `CORE_SWITCH_FAILED: cannot clean old backup`，在重命名激活目录之前中止。4. 激活目录与记录值逐项一致，未被改名或破坏。
[清理] 解除占用或恢复权限；删除残留备份槽位

### [P4] 验证切换前先停服并清扫孤儿进程

[Case ID] TC-DSK-L3-213
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/core/version.rs:330`、`:421`、`:339`
[自动化] 待接线（`test/e2e/specs/desktop/25-core-error-matrix.e2e.ts`）
[前置条件] 服务处于运行中；存在一个不在 `.harness.pid` 标记中的残留 Harness 进程
[测试数据] 目标 tag `dsh-<v2>`；残留进程由外部强杀应用后遗留
[测试步骤] 1. 记录受管 Harness 进程与残留进程的 pid。2. 触发核心切换。3. 读取两个 pid 的存活状态与切换结果。4. 制造停服失败后重复切换并读取错误。
[预期结果] 1. 记录成功。2. 切换被接受。3. 受管进程与残留进程均已退出；切换成功。4. 返回 `CORE_SWITCH_STOP_FAILED`，切换未进入目录互换。
[清理] 重启服务；切回原核心

### [P3] [反向] 验证转换锁超时返回专用错误码

[Case ID] TC-DSK-L3-214
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/workflow/process.rs:127`、`:135`；`src-tauri/src/service/core/version.rs:347`、`:404`
[自动化] 待接线（`test/e2e/specs/desktop/25-core-error-matrix.e2e.ts`）
[前置条件] 可人为长时间持有核心转换锁（例如卡住的启动或另一个未完成的切换）
[测试数据] 持锁时长 > 15 秒；目标 `local` 与 `app-<tag>`
[测试步骤] 1. 制造一次持续超过 15 秒的持锁。2. 在持锁期间请求切换到 `local`。3. 在持锁期间请求切换到 `app-<tag>`。4. 读取两次返回的错误与耗时。
[预期结果] 1. 持锁已建立。2. 返回 `CORE_TRANSITION_TIMEOUT`，消息含 15 秒。3. 同样返回 `CORE_TRANSITION_TIMEOUT`。4. 两次均在约 15 秒后失败返回，且未改动任何槽位目录或设置。
[清理] 释放人为持锁；重启服务

---

## 4. 下载、卸载与来源回退

### [P2] 验证下载链路的分阶段错误码

[Case ID] TC-DSK-L3-215
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/core/version.rs:512`、`:514`、`:530`、`:531`、`:542`
[自动化] 待接线（`test/e2e/specs/desktop/25-core-error-matrix.e2e.ts`）
[前置条件] 可拦截或改写下载链路（元数据接口、资产地址、摘要）
[测试数据] 一个合法但未下载的 tag；四种故障注入：元数据不可用、摘要缺失、下载中断、摘要不匹配
[测试步骤] 1. 注入元数据不可用后下载。2. 注入摘要缺失后下载。3. 注入下载中断（含镜像兜底也失败）后下载。4. 注入摘要不匹配后下载，并复查槽位目录。
[预期结果] 1. 返回 `CORE_METADATA_FAILED`。2. 返回 `CORE_INTEGRITY_UNAVAILABLE: trusted SHA-256 unavailable for <tag>, cannot download safely`。3. 返回 `CORE_DOWNLOAD_FAILED`。4. 返回 `CORE_INTEGRITY_FAILED`，且 `dependencies/<tag>` 未留下可用的半成品槽位。
[清理] 移除故障注入；清理残留临时文件

### [P2] 验证卸载守卫与删除失败

[Case ID] TC-DSK-L3-216
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/core/version.rs:560`、`:564`、`:574`
[自动化] 待接线（`test/e2e/specs/desktop/25-core-error-matrix.e2e.ts`）
[前置条件] 已下载并激活 tag 为 `dsh-<v2>` 的版本；另有非激活的已下载 tag `dsh-<v3>`
[测试数据] `app-dsh-<v2>`（激活）、`app-dsh-<v3>`（非激活）
[测试步骤] 1. 卸载 `app-dsh-<v2>`。2. 在非激活槽位上制造删除失败（占用目录句柄）后卸载 `app-dsh-<v3>`。3. 解除占用后再次卸载 `app-dsh-<v3>`。
[预期结果] 1. 返回 `CORE_ACTIVE_VERSION: cannot remove in-use version <tag>`，槽位保留。2. 返回 `CORE_REMOVE_FAILED: cannot remove <dir>`。3. 返回成功，该槽位目录消失。
[清理] 解除占用；按需保持原激活核心

### [P3] [反向] 验证低于基线的本地核心被拒且不改写 active_core

[Case ID] TC-DSK-L3-217
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/core/version.rs:360`；`src-tauri/src/service/core/source.rs:107`
[自动化] 待接线（`test/e2e/specs/desktop/25-core-error-matrix.e2e.ts`）
[前置条件] 已安装低于内置插件基线的本地 CLI 核心；记录 store 中 `active_core` 原值
[测试数据] 低于 `recommended` 基线的本地 dsh 版本
[测试步骤] 1. 调用切换到 `local`。2. 读取返回错误文本。3. 读取 store 中的 `active_core`。4. 调用 `get_cores` 读取本地行与激活行。
[预期结果] 1. 返回 `CORE_LOCAL_UNSUPPORTED`。2. 消息给出本地版本与基线版本，并提示 `npm install -g @deepseek-ai/dsh@latest` 或保留内置版本。3. `active_core` 与记录值逐字一致，未被改写。4. 激活行为预打包核心；本地行仍被列出，不作为激活来源。
[清理] 卸载或升级本地核心；重启服务

### [P2] 验证更新本地核心的可观察结果

[Case ID] TC-DSK-L3-218
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/core/local.rs:274`、`:322`、`:339`
[自动化] 待接线（`test/e2e/specs/desktop/25-core-error-matrix.e2e.ts`）
[前置条件] 存在本地 CLI 核心；可拦截或替换包管理器命令
[测试数据] 无本地核心的环境；更新命令失败（非零退出）的注入；更新成功的正常路径
[测试步骤] 1. 在无本地 CLI 核心的环境触发更新。2. 注入包管理器非零退出后触发更新。3. 注入 `spawn_blocking` 失败后触发更新。4. 恢复环境后正常触发更新并回读版本。
[预期结果] 1. 返回 `CORE_LOCAL_NOT_FOUND: no local core to update`。2. 返回 `CORE_UPDATE_FAILED`，消息含 stdout 与 stderr 合并后的末 12 行非空输出。3. 返回 `CORE_UPDATE_JOIN`，消息含 join 失败原因。4. 返回成功且版本号非空，与包目录 `package.json` 中的版本一致。
[清理] 移除故障注入；恢复包管理器状态

### [P4] 验证按全局布局选择 pnpm 或 npm 更新

[Case ID] TC-DSK-L3-219
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/core/local.rs:247`、`:281`、`:314`
[自动化] 待接线（`test/e2e/specs/desktop/25-core-error-matrix.e2e.ts`）
[前置条件] 可切换本地核心的全局安装布局；可观察派生进程与命令行
[测试数据] npm 布局；pnpm 布局；两种布局同时命中的混合布局
[测试步骤] 1. 在 npm 布局下触发更新，记录程序名与参数。2. 在 pnpm 布局下触发更新，记录程序名与参数。3. 在混合布局下触发更新。4. 记录 Windows 下派生进程的窗口创建标志。
[预期结果] 1. 程序为 `npm.cmd`，参数为 `install -g @deepseek-ai/dsh@latest`。2. 程序为 `pnpm.cmd`，参数为 `add -g @deepseek-ai/dsh@latest`。3. 按 `!npm_layout && pnpm_layout` 判定：npm 命中即为假，走 npm。4. 进程以 `CREATE_NO_WINDOW` 标志启动，不弹出控制台窗口。
[清理] 恢复本地核心原始布局

### [P2] 验证核心行字段与标记语义

[Case ID] TC-DSK-L3-220
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/core/source.rs:43`；`src-tauri/src/bridge/core.rs:12`
[自动化] 待接线（`test/e2e/specs/desktop/25-core-error-matrix.e2e.ts`）
[前置条件] 配置对话框打开在「核心」面板；本地核心与至少一个已下载的预打包版本可用
[测试数据] `get_cores` 返回值；含一个预览版 tag 与一个高于推荐版本的 tag
[测试步骤] 1. 调用 `get_cores` 并读取字段名。2. 读取 `local` 行的 `source`、`id` 与 `present`。3. 读取已下载预打包行的 `id`、`tag`、`present` 与 `active`。4. 读取预览版行与高于推荐版本行的 `preview`、`aboveRecommended` 与 `recommendedVersion`。
[预期结果] 1. 字段为 camelCase：`id`、`source`、`version`、`tag`、`path`、`dir`、`present`、`active`、`preview`、`aboveRecommended`、`orphaned`、`recommendedVersion`、`error`。2. `source` 为 `local`，`id` 为 `local`。3. `id` 为 `app-<tag>`，`tag` 为 tag 原文，已下载行 `present` 为真，激活行 `active` 为真。4. 预览版 `preview` 为真；高于推荐版本的行 `aboveRecommended` 为真且 `recommendedVersion` 与配置的推荐版本一致。
[清理] 按需卸载测试槽位

### [P3] [反向] 验证切换后激活核心消失的错误码

[Case ID] TC-DSK-L3-221
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/core/version.rs:390`
[自动化] 待接线（`test/e2e/specs/desktop/25-core-error-matrix.e2e.ts`）
[前置条件] 可调用切换命令；可在切换返回前的窗口内删除或移走激活槽位
[测试数据] 目标 `app-<tag>`；在切换成功后立即移走 `dependencies/dsh`
[测试步骤] 1. 触发切换到 `app-<tag>`。2. 在切换落盘后、列表查询前的窗口内移走激活目录。3. 读取返回错误。4. 复查磁盘槽位与 `active_core` 设置。
[预期结果] 1. 切换被接受。2. 激活目录已移走。3. 返回 `CORE_NOT_FOUND: active core disappeared after switch`。4. 槽位与设置保持切换后的状态，未被静默回滚成另一个来源。
[清理] 恢复激活目录；切回原核心

---

## 5. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 标识与查找 | 208、220、221 | 异常 / 正向 | `CORE_APP_NOT_FOUND`（`version.rs:371`）**未覆盖**：需移除随包核心二进制 |
| 切换与回滚 | 210、211、212、213、214 | 正向 / 异常 / 边界 | `CORE_SWITCH_FAILED` 的备份重命名失败分支（`version.rs:463`）未覆盖；同版本切换的早退分支未覆盖 |
| 下载 | 209、215 | 边界 / 异常 | 镜像兜底切换后的成功路径未覆盖 |
| 卸载 | 216 | 异常 | 卸载时停服失败仅告警、不阻断（`version.rs:568`）未覆盖 |
| 本地核心 | 217、218、219 | 异常 / 边界 | 低于基线时 `active_source` 的回退判定本身（`source.rs:118`）只做间接断言 |
| 行数据形状 | 220 | 正向 | `orphaned` 与 `error` 字段的取值条件未覆盖 |
| 未列入本文件 | — | — | `CORE_TRANSITION_TIMEOUT` 之外的锁竞争、以及下载进度两阶段事件，不在本文件范围 |

---

## 6. 缺口与假设

- **G-D25-1**：`CORE_APP_NOT_FOUND: bundled core is not installed`（`version.rs:371`）需要移除或改名随包核心二进制才能触发，本文件未为它安排 Case。
- **G-D25-2**：回滚类用例（211、212、216）需要制造重命名或删除失败。Windows 上的可靠手段是占用目录句柄；权限手段需管理员。接线时优先用句柄占用。
- **G-D25-3**：TC-DSK-L3-214 需要人为持有转换锁超过 15 秒，当前无外部注入点，需测试编排层配合或增加诊断命令。
- **G-D25-4**：TC-DSK-L3-210、211 的早退分支「当前激活 tag 与目标 tag 相同 → 只改来源标记」（`version.rs:413`）未单独覆盖；同版本 local → app 的来源改写属该分支。
- **G-D25-5**：卸载前停服失败只记警告不阻断（`version.rs:568`），意味着删除可能在被占用目录上退化；该降级路径未验证。
- **G-D25-6**：`CORE_LOCAL_UNSUPPORTED` 在 `source.rs:107` 同时以一次性降级警告日志出现（仅告警一次）。日志侧断言当前无出口，217 只断言命令返回值与 `active_core`。
- **假设**：核心切换的成功路径不负责重启服务，重启由前端触发；本文件在切换类用例中只断言目录与设置，不重复断言服务恢复（归 `07-harness-lifecycle.md` 与 `14-core-management.md`）。
