# 服务状态机、健康检查与进程韧性

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/desktop/26-service-state-machine.e2e.ts`（待建立）
> 前置：`07-harness-lifecycle.md` 通过；应用处于 `ready`
> 运行：`vitest --project desktop -- test/e2e/desktop/26-service-state-machine.e2e.ts`（待配置，见 G2）

后端用五态枚举描述服务，判定权在「是否持有进程」与「端口是否可探活」两个条件上，前端事件只是它的投影。本文件验证状态不漂移、后端 5 秒轮询与前端 1 秒起退避这两套时间常数不被混淆、以及进程意外退出后的复位路径。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 状态枚举变体顺序 `Initial/Installing/Starting/Running/Stopped`；静态初值为 `Initial` | `src-tauri/src/service/workflow/status.rs:5`、`:18` |
| 安装依赖进入 **Installing**（真实安装或 Git-only 补丁路径） | `src-tauri/src/bridge/lifecycle.rs:122` |
| 安装失败经 `reset_install_status` 复位为 **Stopped** | `src-tauri/src/bridge/lifecycle.rs:46`、`:234`、`:247` |
| 启动时已持有进程 → **Running**；否则 **Starting** 后拉起 | `src-tauri/src/service/workflow/launch.rs:187`、`:199`、`:201` |
| 停止 → **Stopped**；`restart` = stop（→Stopped）+ start（→Starting） | `src-tauri/src/service/workflow/process.rs:477`、`:478`；`src-tauri/src/service/workflow/launch.rs:209` |
| 健康 tick 命中 → **Running** | `src-tauri/src/task/tick_check_dsh_process/mod.rs:21` |
| tick 兜底：无被持有进程但状态仍为 Running → **Stopped** | `src-tauri/src/task/tick_check_dsh_process/mod.rs:31` |
| 查询命令 `get_dsh_status()` 返回 `Status`；注册于构建器 | `src-tauri/src/bridge/lifecycle.rs:413`；`src-tauri/src/desktop/builder.rs:878` |
| 事件 `dsh-status-updated` 载荷为序列化 `Status`（单位枚举 → 字符串） | `src-tauri/src/service/workflow/status.rs:5` |
| `emit_status` 是唯一发射点（`app_handle.emit`，错误忽略），共 9 处调用 | `src-tauri/src/bridge/lifecycle.rs:48`、`:123`、`:235`；`src-tauri/src/service/workflow/launch.rs:190`、`:201`；`src-tauri/src/service/workflow/process.rs:184`、`:478`；`src-tauri/src/task/tick_check_dsh_process/mod.rs:23`、`:31` |
| 事件 `harness-process-exited` 载荷 `HarnessProcessExitedPayload{pid, exitCode}`（camelCase） | `src-tauri/src/service/workflow/process.rs:17`、`:185` |
| 后端周期轮询为 **5 秒**（非 1 秒），每轮 `tick_check_dsh_process::trigger` + `check_and_emit_theme` + `plugin::watch::check_and_emit`；注释「1s 偏激进，降为 5s」 | `src-tauri/src/service/scheduler/mod.rs:5`、`:16` |
| 调度器启动点 | `src-tauri/src/desktop/builder.rs:130` |
| 「1 秒」只存在于前端：`HEALTH_PROBE_INITIAL_INTERVAL = 1000`、`HEALTH_PROBE_MAX_INTERVAL = 5000`（×1.5 递增封顶）、单次探测 8 秒超时 | `src/store/modules/harness/constants.ts:11`；`src/store/modules/harness/utils.ts:44`、`:132` |
| 探测经 `proxy_health_check` 打 `get_dsh_service_url(port)` + `/` 并要求 HTTP 200 | `src-tauri/src/service/workflow/utils.rs:129` |
| tick 就绪为双重条件 `has_owned_process() && is_dsh_running(port)`，仅在状态非 Running 时置位 | `src-tauri/src/task/tick_check_dsh_process/mod.rs:11`、`:16` |
| `is_dsh_running(port)` 用 2 秒超时回环客户端并要求 `/` 返回 200 | `src-tauri/src/service/workflow/utils.rs:130` |
| 健康检查信号：`HARNESS_NOT_OWNED` / `HARNESS_NOT_READY` / `healthy - {ready}/{total} client modules ready`；就绪要求 `total > 0 && ready == total` | `src-tauri/src/service/workflow/health.rs:47`、`:60`、`:90`、`:55` |
| 意外退出检测：spawn 成功后专用监视线程盯最终进程（Windows `WaitForSingleObject(handle, INFINITE)` + `GetExitCodeProcess`；Unix `child.wait()`）→ `on_owned_process_exit`（PID 匹配才清、幂等、置 Stopped 并发事件）；5 秒 tick 为兜底 | `src-tauri/src/service/workflow/launch.rs:721`、`:835`；`src-tauri/src/service/workflow/process.rs:29`、`:46`、`:71`、`:102`、`:143`、`:161` |
| 被持有进程存为 `Mutex<Option<OwnedProcess>>`（PID + Windows HANDLE）；`has_owned_process()` 读它；`LAUNCH_GUARD: AtomicBool` 由 `LaunchGuard::drop` 复位 | `src-tauri/src/service/workflow/process.rs:46`、`:29` |
| 启动去重：已持有进程 → `Ok(())` 记「Owned Harness process is already running, skipping launch」；`LAUNCH_GUARD.compare_exchange` 失败 → `Ok(())` 记「Harness launch already in progress, skipping」；仅持守卫路径清扫孤儿 | `src-tauri/src/service/workflow/launch.rs:283`、`:287`、`:294` |
| 启动前校验二进制：`NODE_NOT_FOUND: Node.js not installed` / `HARNESS_NOT_FOUND: Harness not installed` | `src-tauri/src/service/workflow/launch.rs:268`、`:273` |
| `terminate_stale_harness_processes` 定义于 process.rs；Windows 用 PowerShell `Get-CimInstance Win32_Process`（`node.exe` + dsh 入口 + `--profile` + `--port`，排除 `plugin`）→ `kill_pid_tree`；Unix 用 `ps -ww -axo pid=,command=` 参数边界匹配；清理后 sleep 800ms；**debug 构建为 no-op** | `src-tauri/src/service/workflow/process.rs:357` |
| 陈旧进程清扫的 5 个调用点：① 启动 `sweep_orphan_harness` ② spawn 前 ③ 停止后 ④⑤ 两处核心切换 | `src-tauri/src/service/workflow/sweep.rs:34`；`src-tauri/src/desktop/builder.rs:102`；`src-tauri/src/service/workflow/launch.rs:304`；`src-tauri/src/service/workflow/install.rs:40`；`src-tauri/src/service/core/version.rs:336`、`:437` |
| Windows 服务进程不用 `CREATE_NO_WINDOW`，走 `spawn_with_hidden_console_owned`（`CREATE_NEW_CONSOLE \| CREATE_UNICODE_ENVIRONMENT` + `STARTF_USESHOWWINDOW`/`SW_HIDE`，分配隐藏控制台） | `src-tauri/src/service/workflow/win_spawn.rs:144`、`:147`、`:162`；`src-tauri/src/service/workflow/launch.rs:625` |
| 前端可观测字段 `status` / `serviceRunning` / `serviceHealthy` / `busyAction` / `startupPhase` | `src/store/modules/harness/store.ts:84`、`:101` |
| 「应用」面板连接状态 Chip 与忙碌时禁用的重启/停止按钮 | `src/ui/config/debug.tsx:189`、`:224`、`:233` |

---

## 2. 状态机与事件

### [P1] 验证安装依赖期间状态为 Installing

[Case ID] TC-DSK-L3-222
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/bridge/lifecycle.rs:122`、`:123`
[自动化] 待接线（`test/e2e/desktop/26-service-state-machine.e2e.ts`）
[前置条件] 运行时依赖缺失（Node/dsh 未就绪），或可走 Git-only 补丁路径
[测试数据] 命令 `install_dependencies`、`get_dsh_status`；事件 `dsh-status-updated`
[测试步骤] 1. 调用 `install_dependencies`。2. 在安装进行中读取 `get_dsh_status`。3. 读取 `dsh-status-updated` 的最新载荷。
[预期结果] 1. 命令被接受并进入安装。2. 返回值为 `Installing`。3. 载荷为字符串 `"Installing"`（单位枚举整体序列化，非对象）。
[清理] 等待安装收敛；`DELETE /session/<id>`

### [P1] 验证启动经 Starting 收敛为 Running 且重复启动直接 Running

[Case ID] TC-DSK-L3-223
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/workflow/launch.rs:187`、`:190`、`:199`、`:201`；`src-tauri/src/task/tick_check_dsh_process/mod.rs:21`
[自动化] 待接线（`test/e2e/desktop/26-service-state-machine.e2e.ts`）
[前置条件] 运行时依赖已就绪；当前无被持有的服务进程
[测试数据] 命令 `start_harness`、`get_dsh_status`；事件 `dsh-status-updated`
[测试步骤] 1. 触发 `start_harness`。2. 读取 `dsh-status-updated` 的事件序列。3. 等待健康 tick 命中后读取 `get_dsh_status`。4. 在持有进程期间再次触发 `start_harness`。
[预期结果] 1. 命令被接受。2. 序列中出现 `"Starting"` 且在 `"Running"` 之前。3. 返回值为 `Running`（`has_owned_process() && is_dsh_running(port)` 同时为真）。4. 状态直接为 `Running`，不经过 `Starting`，也不产生第二个进程。
[清理] 停止服务；`DELETE /session/<id>`

### [P3] [反向] 验证安装失败后状态复位为 Stopped

[Case ID] TC-DSK-L3-224
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/bridge/lifecycle.rs:46`、`:234`、`:247`
[自动化] 待接线（`test/e2e/desktop/26-service-state-machine.e2e.ts`）
[前置条件] 可构造 `install_dependencies` 失败（依赖源不可达或包体校验失败）
[测试数据] 命令 `install_dependencies`、`get_dsh_status`
[测试步骤] 1. 构造使安装失败的前置。2. 调用 `install_dependencies`。3. 读取命令的错误返回。4. 读取 `get_dsh_status` 与 `dsh-status-updated` 的最新载荷。
[预期结果] 1. 前置构造完成。2. 命令被接受。3. 返回非空错误信息。4. 状态与载荷均为 `Stopped`（`reset_install_status` 复位，不停留在 `Installing`）。
[清理] 恢复依赖源后重试安装；`DELETE /session/<id>`

### [P2] 验证重启收敛为 Stopped 后重新 Starting

[Case ID] TC-DSK-L3-225
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/workflow/process.rs:477`、`:478`；`src-tauri/src/service/workflow/launch.rs:199`、`:201`
[自动化] 待接线（`test/e2e/desktop/26-service-state-machine.e2e.ts`）
[前置条件] 服务处于 `Running`
[测试数据] 命令 `restart_harness`、`get_dsh_status`；事件 `dsh-status-updated`
[测试步骤] 1. 触发 `restart_harness`。2. 读取事件序列中的状态值。3. 等待收敛。4. 读取 `get_dsh_status`。
[预期结果] 1. 命令被接受。2. 序列中 `Stopped`（停止阶段）出现在 `Starting`（启动阶段）之前。3. 收敛完成。4. 返回值为 `Running`。
[清理] `DELETE /session/<id>`

---

## 3. 健康检查与就绪

### [P2] 验证状态事件载荷为状态字符串且与查询结果一致

[Case ID] TC-DSK-L3-226
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/bridge/lifecycle.rs:48`、`:123`、`:235`；`src-tauri/src/service/workflow/launch.rs:190`、`:201`；`src-tauri/src/service/workflow/process.rs:184`、`:478`；`src-tauri/src/task/tick_check_dsh_process/mod.rs:23`、`:31`
[自动化] 待接线（`test/e2e/desktop/26-service-state-machine.e2e.ts`）
[前置条件] 服务处于 `Running`
[测试数据] 事件 `dsh-status-updated`；命令 `restart_harness`、`get_dsh_status`
[测试步骤] 1. 订阅 `dsh-status-updated` 并清空历史。2. 触发一次重启。3. 读取每个事件的 `payload` 形态与取值。4. 读取收敛后的 `get_dsh_status`。
[预期结果] 1. 订阅成功。2. 收到至少两个事件。3. 每个载荷均为字符串且取值属于 `Initial/Installing/Starting/Running/Stopped`，不存在对象形态。4. 查询结果与最后一个事件的载荷一致。
[清理] `DELETE /session/<id>`

### [P2] 验证健康检查以客户端模块就绪判定

[Case ID] TC-DSK-L3-227
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/workflow/health.rs:60`、`:90`、`:55`；`src-tauri/src/task/tick_check_dsh_process/mod.rs:11`、`:16`
[自动化] 待接线（`test/e2e/desktop/26-service-state-machine.e2e.ts`）
[前置条件] 服务已启动且被本应用持有
[测试数据] 命令 `proxy_health_check`、`get_dsh_status`
[测试步骤] 1. 等待服务启动完成。2. 调用 `proxy_health_check`。3. 读取返回文本中的 `ready`/`total`。4. 读取 `get_dsh_status`。
[预期结果] 1. 启动完成。2. 返回 `healthy - {ready}/{total} client modules ready`。3. `total > 0` 且 `ready == total`（每个声明的客户端模块都是插件 bundle）。4. 返回值为 `Running`。
[清理] `DELETE /session/<id>`

### [P3] [反向] 验证无持有进程或启动进行中的健康检查信号

[Case ID] TC-DSK-L3-228
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/workflow/health.rs:47`、`:60`
[自动化] 待接线（`test/e2e/desktop/26-service-state-machine.e2e.ts`）
[前置条件] 服务已停止且无被持有进程
[测试数据] 命令 `proxy_health_check`、`start_harness`
[测试步骤] 1. 停止服务并确认无被持有进程。2. 调用 `proxy_health_check`。3. 触发启动并在启动守卫仍持有时再次调用 `proxy_health_check`。
[预期结果] 1. 停止完成。2. 返回 `HARNESS_NOT_OWNED: no Harness process is owned by this app`。3. 返回 `HARNESS_NOT_READY: Harness service is still starting`（可重试信号，而非被判为崩溃）。
[清理] 等待启动收敛；`DELETE /session/<id>`

### [P4] 验证前端探测退避与单次超时

[Case ID] TC-DSK-L3-229
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/store/modules/harness/constants.ts:11`；`src/store/modules/harness/utils.ts:44`、`:132`；`src-tauri/src/service/workflow/utils.rs:129`
[自动化] 待接线（`test/e2e/desktop/26-service-state-machine.e2e.ts`）
[前置条件] 服务未就绪，可观察探测请求的时间戳序列
[测试数据] 触发方式：启动过程中采集健康探测请求时间戳与目标 URL
[测试步骤] 1. 采集服务未就绪期间的探测时间戳序列。2. 计算相邻间隔。3. 等待服务就绪。4. 读取单次探测的超时上限与目标地址。
[预期结果] 1. 采集到至少 2 次探测。2. 首个间隔约 1000ms。3. 后续间隔按 ×1.5 递增且不超过 5000ms，就绪后停止退避。4. 单次探测 8000ms 超时后判失败；目标为 `get_dsh_service_url(port)` + `/` 且要求 HTTP 200。
[清理] `DELETE /session/<id>`

---

## 4. 进程韧性

### [P3] [反向] 验证持有进程意外退出后状态复位并发事件

[Case ID] TC-DSK-L3-230
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/workflow/process.rs:183`、`:185`；`src-tauri/src/service/workflow/launch.rs:721`
[自动化] 待接线（`test/e2e/desktop/26-service-state-machine.e2e.ts`）
[前置条件] 服务处于 `Running`；可在应用外部终止该服务进程
[测试数据] 事件 `harness-process-exited`、`dsh-status-updated`；命令 `get_dsh_status`
[测试步骤] 1. 记录被持有进程的 pid 并订阅两个事件。2. 在应用外部终止该进程。3. 读取 `harness-process-exited` 的载荷与次数。4. 读取 `get_dsh_status`。
[预期结果] 1. 记录与订阅成功。2. 进程终止。3. 载荷为 `{ pid, exitCode }` 且 `pid` 与记录值一致；事件恰好一次（监视线程与 tick 兜底幂等）。4. 返回值为 `Stopped`。
[清理] 重新拉起服务；`DELETE /session/<id>`

### [P4] 验证后端 5 秒 tick 兜底与双重就绪条件

[Case ID] TC-DSK-L3-231
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/scheduler/mod.rs:5`、`:16`；`src-tauri/src/task/tick_check_dsh_process/mod.rs:11`、`:16`、`:21`、`:31`
[自动化] 待接线（`test/e2e/desktop/26-service-state-machine.e2e.ts`）
[前置条件] 可占用服务端口并让其返回 200，且该进程不被本应用持有
[测试数据] 触发方式：用非 Harness 的 HTTP 服务占用端口；注入「状态为 Running 但无被持有进程」的残留态
[测试步骤] 1. 记录后端 tick 周期与每轮执行内容。2. 在无被持有进程时让端口可返回 200。3. 等待至少两个 tick 后读取状态。4. 构造状态已为 `Running` 但无被持有进程的残留态，再等待一个 tick。
[预期结果] 1. 周期为 5 秒（非 1 秒），每轮调用 `tick_check_dsh_process::trigger`、`check_and_emit_theme` 与 `plugin::watch::check_and_emit`。2. 端口可探活。3. 状态不被置为 `Running`（缺被持有进程这一半条件）。4. 状态回退为 `Stopped`。
[清理] 释放占用的端口；重新拉起服务；`DELETE /session/<id>`

### [P4] 验证启动去重守卫使并发启动收敛为一次

[Case ID] TC-DSK-L3-232
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/workflow/launch.rs:283`、`:287`、`:294`
[自动化] 待接线（`test/e2e/desktop/26-service-state-machine.e2e.ts`）
[前置条件] 服务处于 `Running`；可读取服务日志与进程列表
[测试数据] 命令 `start_harness`；触发方式：在启动进行中并发触发第二次启动
[测试步骤] 1. 在已持有进程时触发 `start_harness`。2. 读取返回结果与日志。3. 在启动仍进行时并发触发第二次 `start_harness`。4. 读取返回结果、日志与进程数量。
[预期结果] 1. 触发被接受。2. 返回 `Ok(())`，日志含「Owned Harness process is already running, skipping launch」，不产生第二个进程。3. 第二次触发被接受。4. 返回 `Ok(())`，日志含「Harness launch already in progress, skipping」，进程数量仍为 1。
[清理] `DELETE /session/<id>`

### [P4] 验证陈旧进程清扫的调用点与 debug 空操作

[Case ID] TC-DSK-L3-233
[层级] L3（真实 Tauri 窗口）
[类型] 低频
[追踪] `src-tauri/src/service/workflow/process.rs:357`；`src-tauri/src/service/workflow/sweep.rs:34`；`src-tauri/src/desktop/builder.rs:102`；`src-tauri/src/service/workflow/launch.rs:304`；`src-tauri/src/service/workflow/install.rs:40`；`src-tauri/src/service/core/version.rs:336`、`:437`
[自动化] 待接线（`test/e2e/desktop/26-service-state-machine.e2e.ts`）
[前置条件] 可构造残留的 node 服务进程（同 dsh 入口路径）；分别具备 debug 与 release 构建
[测试数据] 触发方式：残留进程 + 应用重启 + 一次核心切换
[测试步骤] 1. 记录清扫被触发的调用点。2. 构造一个指向 dsh 入口路径的残留 node 进程。3. 在 debug 构建下重启应用，读取残留进程是否存活。4. 在 release 构建下重复并读取结果。
[预期结果] 1. 清扫在启动、spawn 前、停止后与两处核心切换共 5 个调用点被触发。2. 残留进程构造成功。3. debug 构建下清扫为 no-op，残留进程仍存活。4. release 构建下残留进程被结束（按 `node.exe` + dsh 入口 + `--profile` + `--port` 匹配并排除 `plugin`）。
[清理] 结束残留进程；`DELETE /session/<id>`

---

## 5. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 状态枚举与查询命令 | 222、226 | 正向 | 只覆盖 `Installing` 与重启轨迹；`Initial` 初值无可观测窗口 |
| 启动转移 | 223、225、232 | 正向 / 边界 | 「已持有进程」与 `LAUNCH_GUARD` 两条去重分支均已覆盖；`NODE_NOT_FOUND` / `HARNESS_NOT_FOUND` 校验失败分支**未覆盖** |
| 安装失败复位 | 224 | 异常 | 依赖可控的安装失败前置 |
| 停止与重启 | 225、226 | 正向 | — |
| 事件载荷契约 | 226、230 | 正向 / 异常 | 9 个发射点中只覆盖重启与意外退出路径 |
| 健康检查 | 227、228、229 | 正向 / 异常 / 边界 | 前端退避与后端 tick 周期是两套时间常数，已分别断言且不互推 |
| 进程意外退出 | 230 | 异常 | 需统计事件次数以证明幂等 |
| tick 兜底 | 231 | 边界 | 双重条件的另一半（缺被持有进程）通过端口占用间接覆盖 |
| 陈旧进程清扫 | 233 | 低频 | debug 空操作分支与 release 实际结束分支需两种构建 |
| Windows 隐藏控制台 | — | — | `spawn_with_hidden_console_owned`（`win_spawn.rs:144`、`:147`、`:162`）不弹窗属系统表面，**未覆盖** |

---

## 6. 缺口与假设

- **G-D26-1**：「无被持有进程但状态仍为 Running」的回退分支（`tick_check_dsh_process/mod.rs:31`）需要一个「仅伪造状态而不持有进程」的注入手段。当前无只读诊断入口，TC-DSK-L3-231 只能通过「端口被非 Harness 服务占用」间接覆盖双重条件的另一半。
- **G-D26-2**：`terminate_stale_harness_processes` 在 debug 构建下是 no-op（`process.rs:357`）。TC-DSK-L3-233 的「被结束」分支只能在 release 构建下验证；L3 测试若跑在 debug 构建，步骤 4 应标记为跳过而非判失败。
- **G-D26-3**：5 秒 tick 是后端兜底（`scheduler/mod.rs:16`），1 秒起退避到 5 秒是前端探测（`constants.ts:11`）。两者周期数值接近但来源不同，接线时不得据前端探测间隔断言后端 tick 周期。
- **G-D26-4**：`emit_status` 的 9 个调用点中，本文件只覆盖重启（`launch.rs:190`、`:201`；`process.rs:478`）、停止（`lifecycle.rs:235`）、意外退出（`process.rs:184`）与 tick（`tick_check_dsh_process/mod.rs:23`、`:31`）路径；安装失败分支（`lifecycle.rs:48`、`:123`）需与 TC-DSK-L3-224 共用前置。
- **G-D26-5**：意外退出监视线程（`launch.rs:721`、`:835`）与 5 秒 tick 兜底存在竞态，两者都经 `on_owned_process_exit`（`process.rs:161`，PID 匹配才清、幂等）。TC-DSK-L3-230 断言「事件恰好一次」需要能统计事件次数。
- **G-D26-6**：Windows 隐藏控制台分配（`win_spawn.rs:144`、`:147`、`:162`）的效果是「服务进程的孙进程不再各弹一个窗口」，属系统窗口表面，无法在窗口内断言；人工确认项。
- **假设**：单位枚举 `Status` 序列化为字符串，因此所有事件载荷断言按字符串比较，不按对象字段比较。
