# 首次装配与依赖安装

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/specs/desktop/20-assembly.e2e.ts`（待建立）
> 前置：`07-harness-lifecycle.md` 通过；可构造全新装配态（store `installed=false`）
> 运行：`vitest --project desktop -- test/e2e/specs/desktop/20-assembly.e2e.ts`（待配置，见 G2）

首次装配是桌面端唯一「带真实下载、解压、落盘、校验」的流程，也是首次启动体验的全部。本文件覆盖任务编排、进度事件、复用与跳过、失败恢复四类行为。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| `install_dependencies` 返回 `Ok(true)` 表示本次真正落盘 dsh 核心（前端需重启），`Ok(false)` 表示未发生安装 | `src-tauri/src/bridge/lifecycle.rs:74` |
| 并发互斥 `INSTALL_LOCK`，`try_lock` 失败即 `Ok(false)` 并记 `Installation process already running, skipping` | `src-tauri/src/bridge/lifecycle.rs:19`、`:79` |
| 就绪探测 = `Nodejs`/`Dsh`/`Pnpm` 的 `check_installed()` + `config::git_runtime_ready()` | `src-tauri/src/bridge/lifecycle.rs:86` |
| 自愈：四项就绪但 `installed == false` → 补记 `installed=true` + `sync_cli_link`，**不联网**，返回 `Ok(false)` | `src-tauri/src/bridge/lifecycle.rs:103` |
| 仅缺 Git 的补装捷径：`Status::Installing` + `workflow::install(&app_handle, None)`（不查核心版本） | `src-tauri/src/bridge/lifecycle.rs:120` |
| 安装执行：置 `Installing` + `emit_status` → `workflow::install`；失败 `reset_install_status` 并返回 Err；成功置 `installed=true` | `src-tauri/src/bridge/lifecycle.rs:234`、`:46` |
| 收尾 `sync_cli_link` 按 `cli_link_enabled` 走 `cli::ensure`/`cli::remove`，失败仅 warn | `src-tauri/src/bridge/lifecycle.rs:54` |
| 安装任务固定顺序 `Nodejs`、`Dsh`、`Pnpm`（索引 0/1/2） | `src-tauri/src/service/workflow/install.rs:53` |
| 任务数：非 Windows 3 个（6 阶段）；Windows 4 个（追加 `download::Git`，8 阶段） | `src-tauri/src/service/workflow/install.rs:95`、`src-tauri/src/service/download/installable.rs:112` |
| 阶段模型 `ProgressTracker::new(&window, tasks.len() * 2)`，每任务 `download` → `extract` 两阶段 | `src-tauri/src/service/workflow/install.rs:98`、`:142`、`:207` |
| 首装进度映射为等权阶段：`global = current_phase*100/total + stage_pct*(100/total)/100`，clamp 0..100（**不是 0-50/50-100**） | `src-tauri/src/service/download/progress.rs:105` |
| 0-50/50-100 两阶段仅存在于核心槽位下载 `download_version` | `src-tauri/src/service/core/version.rs:517` |
| 子任务进度：ZIP 用 `(i+1)/total*100`；TGZ 传 `-1.0`（总数未知） | `src-tauri/src/service/download/extractor.rs:76`、`:164` |
| 已就绪且非过期的任务 `skip_phases(2)` | `src-tauri/src/service/workflow/install.rs:130` |
| 循环结束补 `tracker.update(100.0, i18n("install.done"), "All tasks completed")` | `src-tauri/src/service/workflow/install.rs:218` |
| 安装前 `stop()` 自有进程 + `terminate_stale_harness_processes`（失败 `STOP_FAILED`） | `src-tauri/src/service/workflow/install.rs:28` |
| `runtime_ready` 纯本地无网络，仅四项 `check_installed` | `src-tauri/src/bridge/lifecycle.rs:424` |
| 前端：`!ready \|\| !config.installed` → 置 `installing` 并 `invoke('install_dependencies')` | `src/store/modules/harness/store.ts:522` |
| `setting.installed=false` 唯一写入点：启动时 node/dsh 二进制缺失 | `src-tauri/src/service/workflow/launch.rs:170` |
| Node 复用：`prefer_bundled_node_runtime()` 优先捆绑；否则本地兼容 Node 直接可用 | `src-tauri/src/service/download/installable.rs:44` |
| 本地 Node 探测：PATH 中 `node`/`node.exe`（macOS 另查 homebrew 两路径），实跑 `--version` | `src-tauri/src/config/runtime.rs:112`、`:195` |
| 版本约束：major 22 → minor≥19；major≥24 → 真；**major 23 不支持**；须三段数字（`v22.19.0-rc.1` 判假） | `src-tauri/src/config/runtime.rs:524` |
| 捆绑版本 `NODE_VERSION = "v22.22.0"` | `src-tauri/src/config/constants.rs:4` |
| Node 二进制解析优先级：ABI 强制捆绑 > 本地兼容 > 已装捆绑 | `src-tauri/src/config/runtime.rs:243` |
| `find_user_pnpm` 在继承 PATH + 常见目录中查找，**排除应用自身 bin 目录** | `src-tauri/src/service/cli/path/pnpm.rs:17`、`:96` |
| `pnpm_env_value` 对自身 shim 目录返回 `None`（拒绝自身 shim） | `src-tauri/src/service/cli/path/pnpm.rs:89` |
| 用户 pnpm 存在则 `Pnpm::check_installed` 为真（记 `Detected user-installed pnpm, skipping bundled pnpm`） | `src-tauri/src/service/download/installable.rs:101` |
| 启动时注入 `DSH_PNPM`；捆绑优先时另注入 `DSH_PREFER_BUNDLED_PNPM=1` | `src-tauri/src/service/workflow/launch.rs:564`、`:579` |
| Dsh 官方源 `DSH_CORE_URL`，镜像前缀 `DSH_MIRROR_PREFIX="https://ghfast.top/"` | `src-tauri/src/config/constants.rs:13`、`:18`、`src-tauri/src/config/runtime.rs:94` |
| Dsh 尝试顺序 `vec![primary, mirror_download_url(&primary)]`：官方在前、镜像兜底 | `src-tauri/src/service/workflow/install.rs:155` |
| Node/pnpm/Git 为单一 URL，**无镜像回退** | `src-tauri/src/service/workflow/install.rs:167` |
| 切换源时 `tracker.update(0.0, "主下载源不可用，已切换镜像源重试（{host}）", ...)` | `src-tauri/src/service/download/core.rs:35` |
| 单源重试 `MAX_DOWNLOAD_ATTEMPTS = 5`，Range 续传，退避 2/4/8/8s | `src-tauri/src/service/download/core.rs:100`、`:162` |
| 重试耗尽 → `DOWNLOAD_INTERRUPTED: 下载中断（网络传输被重置），已自动重试 5 次仍失败…` | `src-tauri/src/service/download/core.rs:162` |
| URL 白名单：https + 主机白名单，否则 `DOWNLOAD_SOURCE_UNTRUSTED` / `DOWNLOAD_URL_INVALID` / `DOWNLOAD_URL_EMPTY` | `src-tauri/src/service/download/core.rs:251`、`:39` |
| Node 源按地域**二选一**（非回退列表）：`nodejs.org` vs `npmmirror.com` | `src-tauri/src/config/constants.rs:7`、`:10`、`src-tauri/src/config/region.rs:36` |
| pnpm 源同样地域二选一；`PNPM_VERSION="11.7.0"` | `src-tauri/src/config/constants.rs:21`、`:25`、`:45` |
| dsh release 元数据最多 3 次，退避 `500*(attempt+1)`ms；全败 `DSH_INTEGRITY_UNAVAILABLE` | `src-tauri/src/service/workflow/install.rs:62` |
| 校验入口 `verify_sha256` 位于下载后、解压前 | `src-tauri/src/service/workflow/install.rs:202`、`src-tauri/src/service/download/core.rs:276` |
| 校验规则：长度≠64 或非 hex → `INTEGRITY_METADATA_INVALID`；不等 → `INTEGRITY_CHECK_FAILED` | `src-tauri/src/service/download/core.rs:277` |
| 摘要来源：Node `SHASUMS256.txt`；Dsh `dsh_latest.digest`；Pnpm 常量；Git `get_mingit_sha256()` | `src-tauri/src/service/workflow/install.rs:179`、`src-tauri/src/service/download/core.rs:295` |
| 摘要缺失：Dsh `DSH_INTEGRITY_UNAVAILABLE: trusted release digest is required`；Node `INTEGRITY_METADATA_MISSING` | `src-tauri/src/service/workflow/install.rs:188`、`src-tauri/src/service/download/core.rs:304` |
| `CORE_INTEGRITY_*` 仅属核心槽位下载，**不在首装路径** | `src-tauri/src/service/core/version.rs:513`、`:531` |
| 暂存/备份命名 `.{leaf}.installing-{pid}` / `.{leaf}.backup` | `src-tauri/src/service/download/core.rs:474` |
| 暂存清理失败 `INSTALL_PATH_LOCKED: cannot remove {path}`（重试 40×250ms ≈ 10s） | `src-tauri/src/service/download/core.rs:481`、`:333` |
| 提交顺序：恢复 backup→dest（`INSTALL_RECOVERY_FAILED`）→ 删旧 backup → dest→backup（`INSTALL_BACKUP_FAILED`）→ staging→dest（失败回滚 + `INSTALL_COMMIT_FAILED`） | `src-tauri/src/service/download/core.rs:412` |
| rename 重试 60×500ms ≈ 30s | `src-tauri/src/service/download/core.rs:390` |
| 失败残留：仅下次安装开头清 staging；本次解压中途失败**不删** staging，旧 dest 完好 | `src-tauri/src/service/download/core.rs:518`、`:555` |
| 进度事件 `install-progress`，载荷 camelCase：`title`/`detail`/`log`/`type`/`percentage`/`progress` | `src-tauri/src/service/download/progress.rs:6`、`:75` |
| 50ms 节流 | `src-tauri/src/service/download/progress.rs:55` |
| 前端对 `percentage` 做**单调过滤**（只前进不后退），日志保留最近 5 条 | `src/store/modules/harness/store.ts:335` |
| Git 任务仅 Windows：`#[cfg(windows)] tasks.push(Box::new(download::Git))` | `src-tauri/src/service/workflow/install.rs:93`、`src-tauri/src/service/download/installable.rs:111` |
| Git 跳过：`find_system_git_binary()` 命中（`git --version` 成功且 `--exec-path` 下有 `git-remote-https.exe`） | `src-tauri/src/service/download/installable.rs:133`、`src-tauri/src/config/runtime.rs:387` |
| 非 Windows `git_runtime_ready` 恒真；`get_git_cmd_dir` 返回 `None` | `src-tauri/src/config/runtime.rs:442`、`:430` |
| MinGit 版本 `2.53.0.2`，文件名 `MinGit-2.53.0.2-64-bit.zip` / `…-arm64.zip`；其他架构 `MINGIT_PLATFORM_UNSUPPORTED` | `src-tauri/src/config/constants.rs:30`、`:41`、`src-tauri/src/config/runtime.rs:334` |
| 状态机 `Initial/Installing/Starting/Running/Stopped`；事件 `dsh-status-updated` | `src-tauri/src/service/workflow/status.rs:6`、`:26` |

---

## 2. 首次装配主路径

### [P1] 验证首次启动自动装配并进入 Running

[Case ID] TC-DSK-L3-149
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/bridge/lifecycle.rs:86`、`:234`；`src-tauri/src/service/workflow/install.rs:53`
[自动化] 待接线（`test/e2e/specs/desktop/20-assembly.e2e.ts`）
[前置条件] 全新装配态（store `installed=false`，`$E2E_HOME/home/.dsh.dev` 下无 `dependencies/dsh`）；联网
[测试数据] 选择器 `dsh-setup-root`；启动阶段键 `status.installing`
[测试步骤] 1. 拉起应用并读取初始 `get_dsh_status`。2. 等待装配完成与服务健康。3. 读取最终状态与 `runtime_ready`。
[预期结果] 1. 初始状态为 `Initial` 或 `Installing`。2. 装配过程中推送 `dsh-status-updated=Installing`，完成后服务进入健康。3. 最终状态为 `Running`；`runtime_ready` 返回真。
[清理] 保留装配产物，或按测试隔离目录整体清理；`DELETE /session/<id>`

### [P1] 验证安装任务按固定顺序推进且进度阶段等权

[Case ID] TC-DSK-L3-150
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/workflow/install.rs:53`、`:98`、`:142`、`:207`；`src-tauri/src/service/download/progress.rs:105`
[自动化] 待接线（同上）
[前置条件] 同上；已订阅 `install-progress`
[测试数据] 期望任务顺序 `Nodejs` → `Dsh` → `Pnpm`（Windows 追加 `Git`）；非 Windows 6 阶段、Windows 8 阶段
[测试步骤] 1. 记录全部 `install-progress` 事件。2. 读取 `title` 序列。3. 读取 `type` 取值集合与 `percentage` 序列。
[预期结果] 1. 事件按任务顺序出现，`title` 序列与期望任务顺序一致。2. `type` 仅取 `download` 与 `extract` 两值，且同一任务内 download 先于 extract。3. `percentage` 非递减，且非 Windows 每阶段约 16.67%、Windows 约 12.5%（**不出现 0-50/50-100 的两段式**）。
[清理] `DELETE /session/<id>`

---

## 3. 复用、跳过与自愈

### [P2] 验证四项就绪时 runtime_ready 为真且不触发安装

[Case ID] TC-DSK-L3-151
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/bridge/lifecycle.rs:424`、`:222`；`src/store/modules/harness/store.ts:522`
[自动化] 待接线（同上）
[前置条件] 四项依赖均已就绪；`installed=true`
[测试数据] 无
[测试步骤] 1. 调用 `runtime_ready`。2. 记录 `install-progress` 事件数量。3. 调用 `install_dependencies` 并读取返回值。
[预期结果] 1. `runtime_ready` 返回真。2. 事件数量为 0（未发起任何下载）。3. 返回 `Ok(false)`，日志为 `Dependencies already installed and up to date, skipping installation`。
[清理] `DELETE /session/<id>`

### [P2] 验证运行时文件在盘但记录显示未安装时自愈补记

[Case ID] TC-DSK-L3-152
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/bridge/lifecycle.rs:103`、`:182`
[自动化] 待接线（同上）
[前置条件] 四项依赖文件均在盘，但 store `installed=false`；**断网**（验证自愈不依赖网络）
[测试数据] 断开网络或指向不可达源
[测试步骤] 1. 调用 `install_dependencies`。2. 读取返回值与 store 的 `installed`。3. 读取 `dsh_pkg_commit` / `dsh_pkg_tag` 是否被修正。
[预期结果] 1. 返回 `Ok(false)`（未发生安装）。2. `installed` 被补记为真。3. 若记录滞后于磁盘产物，`dsh_pkg_commit` 与 `dsh_pkg_tag` 被修正为磁盘实际版本，且**不重新下载**。
[清理] 恢复网络；`DELETE /session/<id>`

### [P2] 验证本机兼容 Node 被复用而不下载内置运行时

[Case ID] TC-DSK-L3-153
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/download/installable.rs:44`；`src-tauri/src/config/runtime.rs:112`、`:524`
[自动化] 待接线（同上）
[前置条件] PATH 中存在兼容版本 Node（major≥24，或 major=22 且 minor≥19）；无捆绑运行时；AIB 未强制捆绑
[测试数据] 本地 Node 版本如 `v22.22.0` 或 `v24.x`
[测试步骤] 1. 调用 `install_dependencies`。2. 读取事件中是否出现 Node 任务的 download 阶段。3. 读取 `get_runtime_info().node_version`。
[预期结果] 1. 安装成功。2. Node 任务被 `skip_phases(2)` 跳过，不出现其下载阶段。3. `node_version` 为本机复用版本，且日志含 `Detected compatible local Node.js`。
[清理] `DELETE /session/<id>`

### [P2] 验证用户已装 pnpm 时跳过捆绑 pnpm

[Case ID] TC-DSK-L3-154
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/download/installable.rs:101`；`src-tauri/src/service/cli/path/pnpm.rs:17`、`:89`
[自动化] 待接线（同上）
[前置条件] PATH 中存在用户 pnpm；无捆绑 pnpm
[测试数据] 用户 pnpm 路径（非应用自身 bin 目录）
[测试步骤] 1. 调用 `install_dependencies`。2. 读取 Pnpm 任务是否被跳过。3. 读取启动时注入的 `DSH_PNPM` 值。
[预期结果] 1. 安装成功。2. Pnpm 任务被跳过，日志含 `Detected user-installed pnpm, skipping bundled pnpm`。3. `DSH_PNPM` 指向用户 pnpm 的绝对路径，而非应用自身 shim。
[清理] `DELETE /session/<id>`

### [P3] [反向] 验证本机 Node 为 v23 时不兼容并回退内置运行时

[Case ID] TC-DSK-L3-155
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/config/runtime.rs:524`、`:243`
[自动化] 待接线（同上）
[前置条件] PATH 中的 Node 为 major 23（不受支持）；无捆绑运行时
[测试数据] 本地 Node `v23.x`
[测试步骤] 1. 调用 `install_dependencies`。2. 读取 Node 二进制解析结果。3. 读取 `get_runtime_info().node_version`。
[预期结果] 1. 本地 v23 不被采用。2. 解析回退到捆绑运行时（并把捆绑 Node 前插 PATH）。3. `node_version` 为捆绑版本 `v22.22.0` 而非 v23。
[清理] `DELETE /session/<id>`

### [P3] [反向] 验证安装过程中重复触发安装被抑制

[Case ID] TC-DSK-L3-156
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/bridge/lifecycle.rs:19`、`:79`
[自动化] 待接线（同上）
[前置条件] 触发一次耗时装配
[测试数据] 在装配未完成时并发再调用 `install_dependencies`
[测试步骤] 1. 触发首次安装。2. 在安装进行中并发调用 `install_dependencies`。3. 读取第二次的返回值与日志。
[预期结果] 1. 首次安装进行中。2. 第二次调用立即返回。3. 返回 `Ok(false)`，日志含 `Installation process already running, skipping`；`install-progress` 事件序列不出现交叠重放。
[清理] 等待首次装配收敛；`DELETE /session/<id>`

---

## 4. 下载失败与完整性

### [P3] [反向] 验证官方源失败时切换镜像兜底成功

[Case ID] TC-DSK-L3-157
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/workflow/install.rs:155`；`src-tauri/src/service/download/core.rs:35`
[自动化] 待接线（同上）
[前置条件] 构造 dsh 官方源不可达、`ghfast.top` 可达
[测试数据] 屏蔽 `github.com` 或指向不可达的 primary
[测试步骤] 1. 触发装配。2. 读取切换源时的进度事件 `detail`。3. 等待 Dsh 任务完成。
[预期结果] 1. 装配被触发。2. 出现 `主下载源不可用，已切换镜像源重试（{host}）` 的 detail 与 `Primary download source failed` 告警。3. Dsh 任务最终成功（镜像兜底生效）；**Node/pnpm/Git 无镜像回退**，其失败直接报错。
[清理] 恢复网络；`DELETE /session/<id>`

### [P3] [反向] 验证 SHA-256 摘要缺失时安全中止

[Case ID] TC-DSK-L3-158
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/workflow/install.rs:188`；`src-tauri/src/service/download/core.rs:304`
[自动化] 待接线（同上）
[前置条件] 构造 release 元数据中缺少可信摘要
[测试数据] 缺失 `dsh_latest.digest`
[测试步骤] 1. 触发装配。2. 读取返回错误。3. 读取磁盘是否产生新的 dsh 目录。
[预期结果] 1. 装配被触发。2. 报错 `DSH_INTEGRITY_UNAVAILABLE: trusted release digest is required`（Node 侧对应 `INTEGRITY_METADATA_MISSING`）。3. 未落盘新版本，已装版本保持完好；**不降级跳过校验**。
[清理] 恢复元数据源；`DELETE /session/<id>`

### [P3] [反向] 验证摘要不匹配时安装失败且旧版本完好

[Case ID] TC-DSK-L3-159
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/download/core.rs:277`、`:412`、`:518`
[自动化] 待接线（同上）
[前置条件] 已有可用版本在盘；构造摘要与下载内容不一致
[测试数据] 篡改摘要或下载内容
[测试步骤] 1. 记录当前已装版本。2. 触发装配并等待失败。3. 读取返回错误与磁盘目录状态。
[预期结果] 1. 记录成功。2. 报错 `INTEGRITY_CHECK_FAILED: SHA-256 mismatch, expected {e}, got {a}`。3. 已装版本目录**未被替换**（提交阶段未执行）；本次可能残留 `.{leaf}.installing-{pid}` 暂存目录，且该目录在下次安装开头被清理。
[清理] 清理可能残留的暂存目录；`DELETE /session/<id>`

### [P3] [反向] 验证下载中断自动重试并给出可判定错误

[Case ID] TC-DSK-L3-160
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/download/core.rs:100`、`:162`
[自动化] 待接线（同上）
[前置条件] 构造下载过程中反复断开连接
[测试数据] 持续中断传输，使 5 次重试全部失败
[测试步骤] 1. 触发装配。2. 等待重试耗尽。3. 读取错误信息与已下载字节提示。
[预期结果] 1. 装配被触发。2. 自动重试 5 次（退避 2/4/8/8s）。3. 报错 `DOWNLOAD_INTERRUPTED: 下载中断（网络传输被重置），已自动重试 5 次仍失败，已下载约 X MB，请检查网络后重试`，且状态复位为非运行中。
[清理] 恢复网络；`DELETE /session/<id>`

### [P4] [反向] 验证非白名单下载源被拒绝

[Case ID] TC-DSK-L3-161
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/download/core.rs:251`、`:39`
[自动化] 待接线（同上）
[前置条件] 构造非 https 或不在主机白名单内的下载 URL
[测试数据] 如 `http://example.com/x.zip`、`https://evil.example/x.zip`、空 URL
[测试步骤] 1. 以非白名单 URL 触发下载。2. 读取错误。
[预期结果] 1. 下载被拒绝。2. 分别报 `DOWNLOAD_URL_INVALID` / `DOWNLOAD_SOURCE_UNTRUSTED: {url}` / `DOWNLOAD_URL_EMPTY`，且不发起实际网络请求。
[清理] `DELETE /session/<id>`

### [P4] 验证 Windows 追加 Git 任务且非 Windows 不出现

[Case ID] TC-DSK-L3-162
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/workflow/install.rs:93`、`:95`；`src-tauri/src/service/download/installable.rs:111`、`:133`
[自动化] 待接线（同上）
[前置条件] 分别在 Windows 与非 Windows 上执行；Windows 侧允许构造「系统 Git 缺失」以观察捆绑 MinGit 安装
[测试数据] Windows：8 阶段、任务 `Git 环境`；非 Windows：6 阶段、无 Git 任务
[测试步骤] 1. 在 Windows 上读取任务列表与阶段总数。2. 在非 Windows 上读取任务列表与阶段总数。3. Windows 上构造系统 Git 存在时读取 Git 任务是否被跳过。
[预期结果] 1. Windows 任务列表含 4 个任务（8 阶段），出现 `Git 环境`。2. 非 Windows 仅 3 个任务（6 阶段），`git_runtime_ready` 恒真且不出现 Git 任务。3. 系统 Git 命中时 Git 任务被跳过（不下载 MinGit）；缺失时下载对应架构的 MinGit，不支持的架构报 `MINGIT_PLATFORM_UNSUPPORTED: windows {arch}`。
[清理] `DELETE /session/<id>`

---

## 5. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `install_dependencies` 编排与自愈 | 149、151、152、156 | 正向 / 异常 | 自愈的「记录滞后」分支（`HealUpToDate`）未单独覆盖 |
| 任务顺序与进度阶段 | 150、162 | 正向 / 边界 | TGZ 的 `progress = -1.0` 分支未覆盖（需 TGZ 源） |
| 本机 Node / pnpm 复用 | 153、154、155 | 正向 / 异常 | ABI 不匹配强制捆绑运行时的分支**未覆盖**（需构造原生模块 ABI 冲突） |
| 镜像兜底 | 157 | 异常 | `"{last}（已尝试 N 个下载源）"` 的全败文案未单独断言 |
| 摘要校验 | 158、159 | 异常 | Node 的 `SHASUMS256.txt` 拉取失败分支未单独覆盖 |
| 传输重试 | 160 | 异常 | Range 断点续传的「续传自 N 字节」未做字节级断言 |
| URL 白名单 | 161 | 边界 | 白名单内各主机的逐一放行未覆盖 |
| Git / MinGit | 162 | 边界 | 非 Windows 的 `INSTALL_TASK_INVALID` 分支实际不可达，未覆盖 |
| 提交阶段失败回滚 | — | — | `INSTALL_RECOVERY_FAILED` / `INSTALL_BACKUP_FAILED` / `INSTALL_COMMIT_FAILED` 三个分支**未覆盖**（需制造 rename 失败） |

---

## 6. 缺口与假设

- **G-D20-1**：本文件是整个套件中**最依赖真实网络**的部分。按 `00-overview.md` G7，离线环境应整体跳过 `157`–`160`，而非判为失败。
- **G-D20-2**：`149`–`152` 需要「全新装配态」。`setting.installed=false` 的唯一写入点是启动时 node/dsh 二进制缺失（`launch.rs:170`），因此接线时应通过隔离数据目录 + 删除 `dependencies/dsh` 来构造，**不得改动开发者本机真实 `~/.dsh.dev`**（按 `00-overview.md` §5.3，`~/.dsh.dev` 在测试中一律指 `$E2E_HOME/home/.dsh.dev`）。
- **G-D20-3**：首装进度为**等权阶段**（Windows 8 阶段 / 非 Windows 6 阶段），归档旧文档中的「下载 0-50、解压 50-100」只适用于核心槽位下载（`service/core/version.rs:517`）。`150` 明确断言这一点，不得按旧文档改写。
- **G-D20-4**：前端对 `percentage` 做单调过滤（`store.ts:335`），因此断言必须取「非递减」而非「严格递增」；`payload.type` 是字段名（源为 `r#type`），旧文档中的 `phase` 命名不存在。
- **G-D20-5**：`install-progress` 有 50ms 节流（`progress.rs:55`），断言事件条数时不可依赖固定数量，只可依赖顺序与取值集合。
- **G-D20-6**：三个提交阶段失败分支（`INSTALL_RECOVERY_FAILED` / `INSTALL_BACKUP_FAILED` / `INSTALL_COMMIT_FAILED`）需要制造 rename 失败（如句柄独占），构造成本高，登记为已知盲区。
- **假设**：默认在 Windows 上执行；`162` 的平台分支需两平台各跑一次。Node/pnpm 走地域二选一（非回退），因此 `157` 的镜像兜底断言只对 Dsh 核心任务成立。
