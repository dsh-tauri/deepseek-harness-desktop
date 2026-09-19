# 隐私、本地监听与运行时信息

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/specs/desktop/23-privacy.e2e.ts`（待建立）
> 前置：`07-harness-lifecycle.md` 通过；应用处于 `ready`；测试侧可读取 `get_runtime_info`、`proxy_health_check`、`read_run_logs` 的返回值并可枚举本机监听地址
> 运行：`vitest --project desktop -- test/e2e/specs/desktop/23-privacy.e2e.ts`（待配置，见 G2）

本文件验证三条对外承诺：宿主只与本机回环地址通信、不向任何远端上传遥测、运行时信息与日志只在本机留存并以最小必要范围暴露。断言只取外部可观察事实（监听地址、子进程环境、命令返回值、落盘文件），不采信代码注释里的意图陈述。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| `loopback_http_client(timeout)` = `no_proxy()` + `timeout()`，禁用 `HTTP_PROXY`/`ALL_PROXY` 劫持回环探测 | `src-tauri/src/service/workflow/utils.rs:15` |
| 探测地址硬编码 `http://127.0.0.1:<port>`（旧版兼容入口与 boot 图入口同源） | `src-tauri/src/service/workflow/utils.rs:32`、`:85` |
| `DSH_HOST = "http://127.0.0.1"`，仅供 `get_dsh_service_url(port)` 拼地址 | `src-tauri/src/config/constants.rs:48`；`src-tauri/src/config/format.rs:4` |
| 启动参数为 `--profile <p> --port <n>`（可选 `--no-open`、`--skip-auth`），**不传 `--host`**，Windows 与 Unix 分支一致 | `src-tauri/src/service/workflow/launch.rs:640`、`:753` |
| 子进程环境注入 `DSH_TELEMETRY_DISABLED=1` | `src-tauri/src/service/workflow/launch.rs:510` |
| 插件安装子进程同样注入 `DSH_TELEMETRY_DISABLED=1` | `src-tauri/src/service/plugin/install/env.rs:39` |
| 三份 shim 文本（cmd / ps1 / sh）均硬编码 `DSH_TELEMETRY_DISABLED` | `src-tauri/src/service/cli/shim/build.rs:52`、`:100`、`:132` |
| 唯一的 `telemetry` 命中是补丁层测试夹具字符串 `session-telemetry-otel` | `src-tauri/src/service/plugin/patch_guard.rs:215` |
| `RuntimeInfo` 8 字段（snake_case）：`app_version`/`dsh_version`/`node_version`/`service_url`/`data_dir`/`log_path`/`platform`/`arch` | `src-tauri/src/config/runtime.rs:587` |
| `get_runtime_info` 以 `core::active_version` 覆写 `dsh_version`；命令入口先读 store 端口 | `src-tauri/src/bridge/system_os.rs:21` |
| `proxy_health_check` 命令入口先读 store 端口，再转发 | `src-tauri/src/bridge/system_os.rs:13` |
| 无持有进程时按 `LAUNCH_GUARD` 返回 `HARNESS_NOT_OWNED` 或 `HARNESS_NOT_READY: Harness service is still starting` | `src-tauri/src/service/workflow/health.rs:60`、`:34` |
| 就绪要求全部客户端模块可用：`all_client_modules_ready` 需 `total > 0 && ready == total` | `src-tauri/src/service/workflow/health.rs:55`、`:93` |
| 探测的归属门：就绪 = `has_owned_process() && is_dsh_running(port)` | `src-tauri/src/task/tick_check_dsh_process/mod.rs:16` |
| `is_dsh_running(port)` 用 2 秒超时回环客户端并要求 `/` 返回 HTTP 200 | `src-tauri/src/service/workflow/utils.rs:130` |
| 日志只落本机：服务 `logs/dsh-web.log`（debug `logs/dsh-web.dev.log`）、桌面端 `logs/desktop.log`、前端 `logs/desktop.frontdesk.log` | `src-tauri/src/bridge/system_os.rs:164`、`:165`、`:167` |
| `read_run_logs` 输出四段 `### 环境信息` / `### 服务日志` / `### 前台日志` / `### 后台日志`，每段上限 `MAX_LINES = 100`（前端取半数） | `src-tauri/src/bridge/system_os.rs:164`、`:165`、`:167` |
| 环境段含 app 版本、dsh 版本、node 版本、os 与 arch，即支持包内容 | `src-tauri/src/bridge/system_os.rs:198` |
| `open_external_url` 仅接受 `http://` / `https://`，否则 `EXTERNAL_URL_INVALID: {url}` | `src-tauri/src/bridge/system_os.rs:239` |
| `reveal_in_folder` 越界返回 `REVEAL_PATH_REJECTED: {path}`；`open_dir` 越界返回 `OPEN_DIR_REJECTED: {path}` | `src-tauri/src/bridge/system_os.rs:55`、`:66` |
| 允许根 = 系统下载目录、应用数据目录、`$DSH_HOME`（测试中即 `$E2E_HOME/home/.dsh.dev`，§5.3），外加本地核心包目录；两侧 canonicalize 后比较路径组件 | `src-tauri/src/bridge/guard.rs:18`、`:50` |

---

## 2. 本地监听边界

### [P1] 验证服务只监听回环地址

[Case ID] TC-DSK-L3-187
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/config/constants.rs:48`；`src-tauri/src/config/format.rs:4`；`src-tauri/src/service/workflow/launch.rs:640`、`:753`
[自动化] 待接线（`test/e2e/specs/desktop/23-privacy.e2e.ts`）
[前置条件] 服务处于运行中；已具备枚举本机监听地址的手段
[测试数据] 当前服务端口 `3081`；观察点：本机所有网卡的监听列表
[测试步骤] 1. 读取当前服务端口。2. 枚举该端口上的全部监听地址。3. 从非回环网卡地址请求该端口。
[预期结果] 1. 读取成功。2. 监听地址全部为 `127.0.0.1:<port>` 或 `[::1]:<port>`，不存在 `0.0.0.0` 或具体外部网卡地址。3. 非回环地址连接失败。
[清理] `DELETE /session/<id>`

### [P2] 验证回环健康探测不受代理环境变量影响

[Case ID] TC-DSK-L3-188
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/workflow/utils.rs:15`、`:32`
[自动化] 待接线（`test/e2e/specs/desktop/23-privacy.e2e.ts`）
[前置条件] 服务处于运行中；启动应用前已设置指向不可达地址的 `HTTP_PROXY` 与 `ALL_PROXY`
[测试数据] `HTTP_PROXY=http://127.0.0.1:1`、`ALL_PROXY=http://127.0.0.1:1`
[测试步骤] 1. 在上述代理变量下启动应用并等待服务运行中。2. 调用 `proxy_health_check`。3. 读取返回值语义。
[预期结果] 1. 服务进入运行中。2. 命令成功返回。3. 返回值为 `healthy - {ready}/{total} client modules ready` 语义，不出现代理引起的连接失败错误。
[清理] 清除代理变量并重启应用；`DELETE /session/<id>`

### [P4] 验证目标端口被他人占用时不误判为就绪

[Case ID] TC-DSK-L3-189
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/task/tick_check_dsh_process/mod.rs:16`；`src-tauri/src/service/workflow/utils.rs:130`
[自动化] 待接线（`test/e2e/specs/desktop/23-privacy.e2e.ts`）
[前置条件] 服务已停止（本应用不持有服务进程）；测试侧在 store 端口上启动一个返回 HTTP 200 的本地 Web 服务
[测试数据] 测试侧服务响应 `/` 为 HTTP 200；store 端口 `3081`
[测试步骤] 1. 停止应用的服务并确认不再持有进程。2. 在 `3081` 上启动测试侧 HTTP 服务。3. 读取界面连接状态与 `proxy_health_check` 返回值。
[预期结果] 1. 服务停止，本应用不持有进程。2. 测试侧服务成功监听 `3081`。3. 连接状态不显示运行中；`proxy_health_check` 返回 `HARNESS_NOT_OWNED` 语义，未因端口上的 HTTP 200 而报告健康。
[清理] 结束测试侧服务并重新拉起 Harness；`DELETE /session/<id>`

---

## 3. 无遥测与最小暴露

### [P1] 验证服务子进程环境关闭遥测

[Case ID] TC-DSK-L3-190
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/workflow/launch.rs:510`；`src-tauri/src/service/plugin/install/env.rs:39`
[自动化] 待接线（`test/e2e/specs/desktop/23-privacy.e2e.ts`）
[前置条件] 服务处于运行中；已具备读取服务子进程环境块的手段
[测试数据] 期望 `DSH_TELEMETRY_DISABLED=1`
[测试步骤] 1. 读取服务子进程的环境变量集合。2. 在同一环境块中查找遥测相关变量的取值。
[预期结果] 1. 读取成功。2. `DSH_TELEMETRY_DISABLED` 存在且值为 `1`，不存在未关闭遥测的取值。
[清理] `DELETE /session/<id>`

### [P2] 验证运行期信息只含本机环境字段

[Case ID] TC-DSK-L3-191
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/config/runtime.rs:587`；`src-tauri/src/bridge/system_os.rs:21`；`src/ui/config/debug.tsx:21`
[自动化] 待接线（`test/e2e/specs/desktop/23-privacy.e2e.ts`）
[前置条件] 应用处于 `ready`；服务处于运行中
[测试数据] 期望字段集：`app_version`、`dsh_version`、`node_version`、`service_url`、`data_dir`、`log_path`、`platform`、`arch`
[测试步骤] 1. 调用 `get_runtime_info` 并读取返回对象的键集合。2. 读取 `service_url`、`data_dir`、`platform` 与 `arch` 的值。3. 在返回对象中查找凭据类字段。
[预期结果] 1. 键集合恰为上述 8 个字段，无多余字段。2. `service_url` 指向 `http://127.0.0.1:<port>`；`data_dir` 为本机用户目录下的路径；`platform` 与 `arch` 与本机一致。3. 不存在令牌、密钥、代理或远端地址类字段。
[清理] `DELETE /session/<id>`

### [P3] [反向] 验证非 http 协议的外部链接被拒绝

[Case ID] TC-DSK-L3-192
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/bridge/system_os.rs:239`
[自动化] 待接线（`test/e2e/specs/desktop/23-privacy.e2e.ts`）
[前置条件] 应用处于 `ready`；可经测试编排直接调用 `open_external_url`
[测试数据] 非法值：`file:///C:/Windows/System32/calc.exe`、`javascript:alert(1)`、`ftp://127.0.0.1/x`、空串
[测试步骤] 1. 依次以每个非法值调用 `open_external_url`。2. 读取每次的错误返回。3. 读取系统上是否出现由这些调用拉起的新进程。
[预期结果] 1. 四次调用均被拒绝。2. 每次错误均以 `EXTERNAL_URL_INVALID:` 开头并回显传入值。3. 未出现由这四次调用拉起的新进程。
[清理] `DELETE /session/<id>`

### [P4] 验证文件系统命令拒绝允许根之外的路径

[Case ID] TC-DSK-L3-193
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/bridge/system_os.rs:55`、`:66`；`src-tauri/src/bridge/guard.rs:18`、`:50`
[自动化] 待接线（`test/e2e/specs/desktop/23-privacy.e2e.ts`）
[前置条件] 应用处于 `ready`；已存在允许根内的一个真实文件与一个真实目录，以及允许根外的一个真实文件与一个真实目录
[测试数据] 允许根内 `<allowed_root>/<file>`、`<allowed_root>/<dir>`；允许根外 `<system_dir>/<file>`、`<system_dir>/<dir>`
[测试步骤] 1. 以允许根内的文件调用 `reveal_in_folder`。2. 以允许根外的文件调用 `reveal_in_folder`。3. 以允许根内的目录调用 `open_dir`。4. 以允许根外的目录调用 `open_dir`。
[预期结果] 1. 调用成功返回。2. 调用失败，错误以 `REVEAL_PATH_REJECTED:` 开头并回显路径。3. 调用成功返回。4. 调用失败，错误以 `OPEN_DIR_REJECTED:` 开头并回显路径。
[清理] 关闭被拉起的文件管理器窗口；`DELETE /session/<id>`

---

## 4. 日志与支持包

### [P2] 验证运行日志四段结构与本机落盘

[Case ID] TC-DSK-L3-194
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/bridge/system_os.rs:164`、`:165`、`:167`、`:198`
[自动化] 待接线（`test/e2e/specs/desktop/23-privacy.e2e.ts`）
[前置条件] 服务处于运行中；本次会话已产生过服务日志与前端日志
[测试数据] 期望四段标题：`### 环境信息`、`### 服务日志`、`### 前台日志`、`### 后台日志`
[测试步骤] 1. 调用 `read_run_logs` 并读取返回文本。2. 按标题切分文本，核对段数与顺序。3. 读取环境段内容。4. 对照磁盘上的三个日志文件路径。
[预期结果] 1. 命令成功返回纯文本。2. 文本恰含四个标题且顺序与上述一致。3. 环境段含 app 版本、dsh 版本、node 版本、os 与 arch。4. `log_path` 指向本机 `logs` 目录下的服务日志；磁盘上同时存在 `desktop.log` 与 `desktop.frontdesk.log`。
[清理] `DELETE /session/<id>`

### [P4] 验证前台日志段行数上限为服务段的一半

[Case ID] TC-DSK-L3-195
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/bridge/system_os.rs:164`、`:165`、`:167`
[自动化] 待接线（`test/e2e/specs/desktop/23-privacy.e2e.ts`）
[前置条件] 服务处于运行中；服务日志与前端日志均已超过 100 行
[测试数据] `MAX_LINES = 100`；前端段期望上限 50 行
[测试步骤] 1. 令前端产生多于 100 行日志。2. 调用 `read_run_logs`。3. 分别统计「服务日志」段与「前台日志」段的文本行数。
[预期结果] 1. 前端日志成功落盘。2. 命令成功返回。3. 服务段行数不超过 100；前台段行数不超过 50，且均取各自文件的末尾行。
[清理] `DELETE /session/<id>`

---

## 5. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 回环监听边界 | 187、189 | 正向 / 边界 | 只断言监听地址集合；dsh 自身默认绑定策略归上游，未在此断言 |
| 代理隔离 | 188 | 正向 | `no_proxy()` 的实际生效路径无法在页面内直接观测，只能由健康探测结果反推 |
| 遥测关闭 | 190 | 正向 | 需读取子进程环境块；仅断言注入值，不断言 dsh 内部是否另有上报通道 |
| 运行时信息暴露面 | 191 | 正向 | 只断言键集合与字段语义，不断言各字段在 UI 的呈现细节（归 `13`） |
| 外部协议白名单 | 192 | 异常 | 只覆盖非 http(s) 拒绝；`http(s)` 放行分支归 `16` |
| 路径白名单 | 193 | 边界 | 符号链接逃逸与「路径存在但不可 canonicalize」分支**未覆盖** |
| 日志本机留存 | 194、195 | 正向 / 边界 | 「后台日志剔除 `frontend:` 行」的兜底分支**未覆盖**（需旧版残留日志） |

---

## 6. 缺口与假设

- **G-D23-1**：TC-DSK-L3-190 需要读取服务子进程的环境块。当前无该能力的现成出口，接线时需在测试编排层读取（例如启动子进程快照）或增加只读诊断命令。在具备该能力前，闭环证据只能覆盖 shim 文本一侧。
- **G-D23-2**：「无任何遥测/分析上传代码」这一事实来源于对 `src`、`src-tauri/src`、`package.json`、`Cargo.toml` 的关键字检索（`sentry`/`posthog`/`analytics`/`gtag`/崩溃上报均无命中），属**静态证据**而非运行时证据。本文件只能断言「宿主显式注入关闭标志」与「不存在凭据类字段」；「运行期确实没有出站连接」需要网络层捕获，**未覆盖**（见 G-D23-3）。
- **G-D23-3**：TC-DSK-L3-187 断言监听地址与外部网卡不可达，覆盖的是**入站**面。**出站**面（应用进程是否向远端建立连接）需要防火墙或抓包手段，属环境依赖项，当前无该编排。
- **G-D23-4**：TC-DSK-L3-189 构造的是「同端口上存在他人 HTTP 200 服务」的场景。归属门为 `has_owned_process() && is_dsh_running(port)`，本用例覆盖「非本应用进程时结果不健康」；反向的「本应用持有进程但端口上是他人服务」需要杀掉 dsh 后用同 PID 占位，**未覆盖**（不可构造）。
- **G-D23-5**：`--host` 未被传递（Windows 与 Unix 分支均只见 `--profile`/`--port`/可选 `--no-open`/`--skip-auth`），因此绑定地址取决于 dsh 自身默认值。TC-DSK-L3-187 以**实际监听地址**为准，不假设也不断言该默认值的具体实现；若上游默认值变更，本用例会以真实观测结果失败，属预期行为。
- **G-D23-6**：TC-DSK-L3-195 的前端段行数上限来自 `FRONTEND_MAX_LINES = MAX_LINES / 2`。断言「不超过 50」在日志不足 50 行时恒真，接线时必须先确保前端日志已超过 100 行，否则该用例退化为无效断言。
- **假设**：所有探测命令（`get_runtime_info`、`proxy_health_check`、`read_run_logs`、`open_external_url`、`reveal_in_folder`、`open_dir`）均可由测试编排直接调用；这些命令当前无 `data-testid` 前置，属 G3 范畴。
