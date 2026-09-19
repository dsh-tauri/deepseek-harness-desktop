# 系统集成、路径守卫、跨平台与 Windows 极简模式

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/specs/desktop/29-system-integration.e2e.ts`（待建立）
> 前置：`01-window-boot.md` 通过；应用处于 `ready`；Windows 用例需 Windows 宿主
> 运行：`vitest --project desktop -- test/e2e/specs/desktop/29-system-integration.e2e.ts`（待配置，见 G2）

壳层与操作系统的接触面由 `bridge/system_os.rs` 收口：唤起浏览器与文件管理器、读写日志、代理健康检查、透传前端日志。本文件的重点是**这些接触面同时是安全边界**——来自可被第三方插件注入脚本操纵的 iframe 的路径参数必须被白名单限制，越界即拒绝；其次是 Windows 极简模式的落盘修复与平台门控。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 命令集 `proxy_health_check` / `get_runtime_info` / `open_in_browser` / `copy_service_url` / `reveal_in_folder` / `open_dir` / `reveal_data_dir` | `src-tauri/src/bridge/system_os.rs:15`、`:22`、`:31`、`:45`、`:52`、`:64`、`:74` |
| 命令集 `log_frontend` / `read_service_logs` / `clear_service_logs` / `read_run_logs` / `open_external_url` | `src-tauri/src/bridge/system_os.rs:101`、`:122`、`:142`、`:164`、`:239` |
| `reveal_in_folder` 越界拒绝 `REVEAL_PATH_REJECTED: {path}` | `src-tauri/src/bridge/system_os.rs:55-57` |
| `open_dir` 越界拒绝 `OPEN_DIR_REJECTED: {path}` | `src-tauri/src/bridge/system_os.rs:66-68` |
| 允许根 = 系统下载目录 + 应用数据目录 + `$DSH_HOME`（测试中即 `$E2E_HOME/home/.dsh.dev`，§5.3）+ 检测到的本地核心包目录 | `src-tauri/src/bridge/guard.rs:18-34` |
| 匹配前两侧都 canonicalize（`dunce`，剥 Windows verbatim 前缀）后按组件比较 | `src-tauri/src/bridge/guard.rs:50-61` |
| 路径不存在直接判不允许 | `src-tauri/src/bridge/guard.rs:51-53` |
| `reveal_data_dir` 先 `create_dir_all`，再按平台 `explorer` / `open` / `xdg-open` | `src-tauri/src/bridge/system_os.rs:74-95` |
| `open_external_url` 仅放行 `http://` / `https://`，否则 `EXTERNAL_URL_INVALID: {url}` | `src-tauri/src/bridge/system_os.rs:239-242` |
| `read_run_logs` 四段：`### 环境信息` / `### 服务日志` / `### 前台日志` / `### 后台日志` | `src-tauri/src/bridge/system_os.rs:164`、`:216-222` |
| 行数上限 `MAX_LINES = 100`，前台日志减半 `FRONTEND_MAX_LINES = 50` | `src-tauri/src/bridge/system_os.rs:165`、`:167` |
| 环境段含 app 版本、dsh 版本、node 版本、os 与 arch | `src-tauri/src/bridge/system_os.rs:198-210` |
| 后台日志段剔除 `target: frontend` 残余行 | `src-tauri/src/bridge/system_os.rs:184-196`、`:229-235` |
| `read_service_logs` 默认上限 64 KiB，超出取尾部 | `src-tauri/src/bridge/system_os.rs:122-138`、`:132` |
| 尾部裁剪回退到 UTF-8 字符边界（`tail_bytes`） | `src-tauri/src/bridge/system_os.rs:111-118` |
| 日志文件不存在时返回空串（非错误） | `src-tauri/src/bridge/system_os.rs:127-129` |
| `clear_service_logs` 以空串覆写日志文件 | `src-tauri/src/bridge/system_os.rs:142-145` |
| `RuntimeInfo` 字段：`app_version` / `dsh_version` / `node_version` / `service_url` / `data_dir` / `log_path` / `platform` / `arch` | `src-tauri/src/config/runtime.rs:587-598` |
| `get_runtime_info` 优先取当前活动核心版本 | `src-tauri/src/bridge/system_os.rs:22-27` |
| `dsh_version` 为 `Option<String>`，取不到即 `null` | `src-tauri/src/config/runtime.rs:591`；`src-tauri/src/config/runtime.rs:563-585` |
| `proxy_health_check` 无持有进程：`HARNESS_NOT_OWNED: no Harness process is owned by this app` | `src-tauri/src/service/workflow/health.rs:47-53`、`:61-63` |
| `launch` 仍在进行（守卫未释放）时返回可重试的 `HARNESS_NOT_READY: Harness service is still starting` | `src-tauri/src/service/workflow/health.rs:47-53` |
| 模块就绪判定 `healthy - {ready}/{total} client modules ready` | `src-tauri/src/service/workflow/health.rs:90-92` |
| 前端：服务日志面板 2 秒回读、清空、复制服务地址、打开数据目录 | `src/ui/config/debug.tsx:69-73`、`:98-108`、`:130-139`、`:173-179`、`:280-289` |
| 前端：核心「打开目录」调 `open_dir` | `src/ui/config/core.tsx:216-226` |
| 前端：下载完成提示的「在文件夹中显示」调 `reveal_in_folder` | `src/layout/index.tsx:113-118` |
| 前端：帮助→文档与关于页仓库链接调 `open_external_url` | `src/layout/components/navbar.tsx:260-267`；`src/ui/dialog/about.tsx:59` |
| 前端：启动失败页「复制日志」调 `read_run_logs` | `src/layout/components/setup.tsx:28`；`src/layout/components/navbar.tsx:299` |
| 前端：`console.*` 劫持经 `log_frontend` 落盘 | `src/utils/logger.ts:81` |
| 启动失败诊断按 16 KiB 上限取服务日志尾部 | `src/store/modules/harness/utils.ts:147`；`src/store/modules/harness/constants.ts:28` |
| Windows 极简模式：`apply` 由预装插件安装成功与启动自愈调用 | `src-tauri/src/service/plugin/install/mod.rs:387-391`；`src-tauri/src/service/plugin/install/single.rs:391-395`；`src-tauri/src/service/workflow/launch.rs:409-411` |
| `PATCH_ENTRY` 用显式相对入口 `./node_modules/dsh-win-terminal-inspector/index.js` + `id: win-terminal-inspector` | `src-tauri/src/service/workflow/win_inspector.rs:45-49` |
| 注入判定标记 `dsh-win-terminal-inspector` | `src-tauri/src/service/workflow/win_inspector.rs:52` |
| 用户 preset id `minimal-win` | `src-tauri/src/service/workflow/win_inspector.rs:55` |
| Git Bash 候选路径（含 x86 变体）与环境变量 `DSH_GIT_BASH_PATH` 覆盖 | `src-tauri/src/service/workflow/win_inspector.rs:58-63`、`:241-252` |
| 插件是否装入读 profile `package.json` 的 `dependencies` | `src-tauri/src/service/workflow/win_inspector.rs:87-99` |
| `ensure_patch` 把顶层数组整体改写给 YAML 库，并迁移遗留裸包名/目录写法 | `src-tauri/src/service/workflow/win_inspector.rs:106-134`、`:224-228` |
| `prune_patch_if_uninstalled` 只删本插件块，删空后自愈为 `[]` | `src-tauri/src/service/workflow/win_inspector.rs:145-168` |
| `ensure_patch_scaffold` 修复「仅注释」scaffold（YAML `null`） | `src-tauri/src/service/workflow/win_inspector.rs:177-200` |
| 错误串 `PATCH_RENDER_FAILED` / `PATCH_WRITE_FAILED` / `PATCH_PARSE_FAILED` / `PATCH_NOT_ARRAY` / `PATCH_PRUNE_FAILED` | `src-tauri/src/service/workflow/win_inspector.rs:132`、`:133`、`:208`、`:212`、`:167` |
| 官方 inspector 版本边界：`0.1.0-rc.8` 起可用，rc.6/rc.7 走兼容分支 | `src-tauri/src/service/workflow/win_inspector.rs:398-406` |
| 新核心路径：清理遗留挂载并记日志后返回 | `src-tauri/src/service/workflow/win_inspector.rs:410-418` |
| 旧核心路径：scaffold → 未装插件则清理返回 → 装了就写 patch 与 preset | `src-tauri/src/service/workflow/win_inspector.rs:419-427` |
| preset 组成：`terminal-bash.shellPath` 指向 Git Bash，`shellArgs: ['--noprofile','--norc','-i']` | `src-tauri/src/service/workflow/win_inspector.rs:328-333` |
| persistent-shell 组内 `sandbox-policy` 为 `danger-full-access` | `src-tauri/src/service/workflow/win_inspector.rs:322-326` |
| preset 落盘于 `${DSH_HOME}/.agent-presets/minimal-win/`，含 `agent.cordis.yml` 与 `preset.yml` | `src-tauri/src/service/workflow/win_inspector.rs:369-395`；`:277-285` |
| Git Bash 未找到时跳过并告警，不阻断主流程 | `src-tauri/src/service/workflow/win_inspector.rs:370-375` |
| 非 Windows 的 `apply` 为无操作，`git_bash_bin_dirs` 返回空 | `src-tauri/src/service/workflow/win_inspector.rs:695-706`；`:712-714` |
| 档案 `parse_workspace_document` 归一化多文档 YAML（后者覆盖前者同名键） | `src-tauri/src/service/profile/mod.rs:123-152` |
| 自愈时记 `PROFILE_WORKSPACE_MULTI_DOCUMENT: normalized …` 并回写 | `src-tauri/src/service/profile/mod.rs:164-171`、`:191-202` |
| 单文档策略注入由插件安装路径调用（跨平台） | `src-tauri/src/service/profile/mod.rs:154`；`src-tauri/src/service/plugin/install/mod.rs:213`；`src-tauri/src/service/plugin/install/single.rs:266` |
| 打包目标 `bundle.targets = "all"` | `src-tauri/tauri.conf.json:21` |
| macOS 打包：`hardenedRuntime` / `infoPlist` / `entitlements` | `src-tauri/tauri.conf.json:34-39` |
| Windows 打包：NSIS 模板与中英语言、WiX 语言与开机自启清理 fragment | `src-tauri/tauri.conf.json:40-52` |
| 麦克风与相机用途说明（TCC 缺少即杀进程） | `src-tauri/Info.plist:19`、`:21` |
| Hardened Runtime 下的音频输入与相机 entitlement | `src-tauri/Entitlements.plist:16`、`:18` |
| Linux 托盘自建（KSNI），构建失败只告警不阻断启动 | `src-tauri/src/desktop/linux_tray.rs:35-39`、`:37` |
| Linux 托盘左键单击唤起主窗口，菜单项 `open` / `quit` | `src-tauri/src/desktop/linux_tray.rs:88-95`、`:48-50`、`:106-110` |

---

## 2. 路径守卫与系统唤起

### [P1] 验证在文件夹中显示允许根内的文件

[Case ID] TC-DSK-L3-260
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/bridge/system_os.rs:52-58`；`src-tauri/src/bridge/guard.rs:18-34`；`src/layout/index.tsx:113-118`
[自动化] 待接线（`test/e2e/specs/desktop/29-system-integration.e2e.ts`）
[前置条件] 应用处于 `ready`；系统下载目录内存在一个普通文件
[测试数据] 路径 = `<系统下载目录>/<已存在文件>`
[测试步骤] 1. 调用 `reveal_in_folder` 传入该路径。2. 读取返回结果与系统文件管理器唤起记录。
[预期结果] 1. 返回成功（无错误文本）。2. 未出现 `REVEAL_PATH_REJECTED`，调用被交给系统文件管理器。
[清理] 删除构造的文件；`DELETE /session/<id>`

### [P3] [反向] 验证拒绝定位允许根之外的文件

[Case ID] TC-DSK-L3-261
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/bridge/system_os.rs:55-57`；`src-tauri/src/bridge/guard.rs:50-61`
[自动化] 待接线（`test/e2e/specs/desktop/29-system-integration.e2e.ts`）
[前置条件] 应用处于 `ready`；可在系统临时目录（不在任何允许根内）放置一个文件
[测试数据] 路径 = `<系统临时目录>/dsh-guard-probe.txt`
[测试步骤] 1. 调用 `reveal_in_folder` 传入该路径。2. 读取错误文本。3. 读取文件管理器唤起记录。
[预期结果] 1. 返回失败。2. 错误文本以 `REVEAL_PATH_REJECTED` 开头且包含该路径。3. 未发生文件夹定位动作。
[清理] 删除构造的文件；`DELETE /session/<id>`

### [P3] [反向] 验证拒绝打开允许根之外的目录

[Case ID] TC-DSK-L3-262
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/bridge/system_os.rs:66-68`；`src-tauri/src/bridge/guard.rs:50-61`；`src/ui/config/core.tsx:216-226`
[自动化] 待接线（`test/e2e/specs/desktop/29-system-integration.e2e.ts`）
[前置条件] 应用处于 `ready`；系统临时目录存在（不在任何允许根内）
[测试数据] 路径 = `<系统临时目录>`；选择器 `dsh-config-core-open-dir`
[测试步骤] 1. 调用 `open_dir` 传入该目录。2. 读取错误文本。3. 从「核心」面板点击「打开目录」并读取界面提示。
[预期结果] 1. 返回失败。2. 错误文本以 `OPEN_DIR_REJECTED` 开头且包含该路径。3. 界面出现「打开目录失败」语义的提示（`core.open_dir_failed`），且目录未被打开。
[清理] 关闭配置对话框；`DELETE /session/<id>`

### [P2] 验证打开数据目录时先创建再交给系统

[Case ID] TC-DSK-L3-263
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/bridge/system_os.rs:74-95`；`src/ui/config/debug.tsx:173-179`、`:280-289`
[自动化] 待接线（`test/e2e/specs/desktop/29-system-integration.e2e.ts`）
[前置条件] 应用处于 `ready`；`get_runtime_info` 已可返回 `data_dir`；该目录可被临时改名为不存在
[测试数据] 选择器 `dsh-config-reveal-data-dir`；观察点：`data_dir` 指向的目录
[测试步骤] 1. 记录 `data_dir` 并把该目录改名为不存在。2. 点击「打开数据目录」。3. 读取命令返回与目录存在性。
[预期结果] 1. 记录成功，目录当前不存在。2. 命令成功返回（无危险提示）。3. 目录已在调用后创建，并已交给系统文件管理器。
[清理] 恢复被改名的数据目录；关闭配置对话框；`DELETE /session/<id>`

### [P3] [反向] 验证拒绝非 http(s) 方案的外部链接

[Case ID] TC-DSK-L3-264
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/bridge/system_os.rs:239-242`
[自动化] 待接线（`test/e2e/specs/desktop/29-system-integration.e2e.ts`）
[前置条件] 应用处于 `ready`
[测试数据] URL = `file:///C:/Windows/System32/calc.exe`（方案非 http(s)）
[测试步骤] 1. 调用 `open_external_url` 传入该 URL。2. 读取错误文本。3. 用合法 `https://` URL 再调用一次并读取返回。
[预期结果] 1. 返回失败。2. 错误文本为 `EXTERNAL_URL_INVALID: {url}`。3. 合法 URL 返回成功，系统浏览器被唤起。
[清理] 关闭被拉起的浏览器标签（人工）；`DELETE /session/<id>`

---

## 3. 日志与运行时诊断

### [P1] 验证运行时诊断文本框返回完整四段

[Case ID] TC-DSK-L3-265
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/bridge/system_os.rs:164`、`:165`、`:167`、`:198-210`、`:216-222`；`src/layout/components/setup.tsx:28`
[自动化] 待接线（`test/e2e/specs/desktop/29-system-integration.e2e.ts`）
[前置条件] 应用处于 `ready`；`logs/desktop.log` 与 `logs/desktop.frontdesk.log` 均存在且行数分别超过 100 与 50；服务日志存在
[测试数据] 调用 `read_run_logs` 的返回文本
[测试步骤] 1. 调用 `read_run_logs`。2. 读取返回文本中的段标题。3. 分段统计行数并读取环境段字段。
[预期结果] 1. 调用成功返回文本。2. 依次出现 `### 环境信息`、`### 服务日志`、`### 前台日志`、`### 后台日志` 四段。3. 服务段与后台段各不超过 100 行、前台段不超过 50 行；环境段含 app 版本、dsh 版本、node 版本、os 与 arch。
[清理] `DELETE /session/<id>`

### [P2] 验证服务日志按 64 KiB 取尾且不截断多字节字符

[Case ID] TC-DSK-L3-266
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/bridge/system_os.rs:122-138`、`:132`、`:111-118`；`src/ui/config/debug.tsx:69-73`
[自动化] 待接线（`test/e2e/specs/desktop/29-system-integration.e2e.ts`）
[前置条件] 应用处于 `ready`；服务日志文件大于 64 KiB 且含中文（多字节）字符
[测试数据] 默认调用（不传 `maxBytes`）与显式 `maxBytes: 16384`（`LOG_TAIL_MAX_BYTES`，`src/store/modules/harness/constants.ts:28`）
[测试步骤] 1. 读取日志文件字节数。2. 调用 `read_service_logs` 不传上限并读取返回长度与首字符。3. 传 `maxBytes: 16384` 再调用一次并读取返回长度。
[预期结果] 1. 文件大于 64 KiB。2. 返回字节数不超过 65536，且等于文件尾部的完整文本（起点落在字符边界、无替换字符）。3. 返回字节数不超过 16384 且为同一尾部文本的后缀。
[清理] `DELETE /session/<id>`

### [P2] 验证清空服务日志后回读为空

[Case ID] TC-DSK-L3-267
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/bridge/system_os.rs:142-145`、`:127-129`；`src/ui/config/debug.tsx:98-108`
[自动化] 待接线（`test/e2e/specs/desktop/29-system-integration.e2e.ts`）
[前置条件] 应用处于 `ready`；服务日志文件非空；配置对话框打开在「应用」面板
[测试数据] 选择器 `dsh-config-clear-service-logs`、`dsh-config-service-logs`
[测试步骤] 1. 读取日志面板内容确认非空。2. 点击清空按钮。3. 等待回读周期后读取日志面板与日志文件。
[预期结果] 1. 面板内容非空。2. 清空成功并出现「日志已清空」语义提示。3. 面板显示空态文案；日志文件字节数为 0。
[清理] 关闭配置对话框；`DELETE /session/<id>`

### [P3] [反向] 验证无持有进程时健康检查返回可区分的失败信号

[Case ID] TC-DSK-L3-268
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/workflow/health.rs:47-53`、`:60-63`；`src-tauri/src/bridge/system_os.rs:15-18`
[自动化] 待接线（`test/e2e/specs/desktop/29-system-integration.e2e.ts`）
[前置条件] 应用处于 `ready` 后主动停止 Harness，或在新实例启动瞬间探测
[测试数据] 两种状态：无持有进程且 `launch` 已结束；`launch` 仍在进行（守卫未释放）
[测试步骤] 1. 在「无持有进程且启动已结束」状态下调用 `proxy_health_check` 并读取错误文本。2. 在「启动进行中」状态下再次调用并读取错误文本。3. 对比两次前缀。
[预期结果] 1. 错误以 `HARNESS_NOT_OWNED: no Harness process is owned by this app` 开头。2. 错误以 `HARNESS_NOT_READY: Harness service is still starting` 开头。3. 两次前缀不同（前者快速失败，后者可继续轮询）。
[清理] 重新拉起服务；`DELETE /session/<id>`

---

## 4. Windows 极简模式（Windows 专属）

### [P1] 验证官方内置 inspector 的核心不再挂载社区注入

[Case ID] TC-DSK-L3-269
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/workflow/win_inspector.rs:398-406`、`:410-418`；`src-tauri/src/service/plugin/install/single.rs:391-395`
[自动化] 待接线（`test/e2e/specs/desktop/29-system-integration.e2e.ts`）
[前置条件] Windows 宿主；活动核心版本 ≥ `0.1.0-rc.8`；活动档案的 `cordis.patch.yml` 内含本插件的遗留 `- insert:` 块
[测试数据] 观察点：`$E2E_HOME/home/.dsh.dev/profiles/<档案>/cordis.patch.yml`（§5.3）、桌面端日志
[测试步骤] 1. 读取 patch 文件并确认遗留块存在。2. 触发一次会调用 `win_inspector::apply` 的流程（启动自愈或插件操作）。3. 重新读取 patch 文件与日志。
[预期结果] 1. 遗留块存在。2. 流程完成且无 `PATCH_*` 错误。3. patch 中不再含 `win-terminal-inspector`，且未追加新的挂载块；日志出现「provides the official Windows process inspector」。
[清理] 恢复 patch 文件原始内容；`DELETE /session/<id>`

### [P2] 验证 rc.6/rc.7 已装插件时写入显式入口挂载并创作 preset

[Case ID] TC-DSK-L3-270
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/workflow/win_inspector.rs:45-49`、`:419-427`、`:328-333`、`:369-395`；`src-tauri/src/service/plugin/install/mod.rs:387-391`
[自动化] 待接线（`test/e2e/specs/desktop/29-system-integration.e2e.ts`）
[前置条件] Windows 宿主；活动核心版本为 `0.1.0-rc.6` 或 `0.1.0-rc.7`；profile `package.json` 的 `dependencies` 含 `dsh-win-terminal-inspector`；`${DSH_HOME}/.agent-presets/minimal-win/` 不存在；`DSH_GIT_BASH_PATH` 指向存在的 `bash.exe`
[测试数据] 环境变量 `DSH_GIT_BASH_PATH`；观察点 patch 文件与 `${DSH_HOME}/.agent-presets/minimal-win/`
[测试步骤] 1. 触发一次会调用 `win_inspector::apply` 的流程。2. 读取 patch 文件中的挂载块。3. 读取 preset 目录内的两个文件内容。
[预期结果] 1. 流程成功（无 `PATCH_*` 错误）。2. 存在 `- insert:` 块，含 `id: win-terminal-inspector` 与 `name: ./node_modules/dsh-win-terminal-inspector/index.js`，且不含裸包名写法。3. `agent.cordis.yml` 的 `shellPath` 等于被测的 `bash.exe` 且 `shellArgs` 为 `--noprofile --norc -i`；同目录存在 `preset.yml`；persistent-shell 组内 `sandbox-policy` 的 `mode` 为 `danger-full-access`。
[清理] 删除构造的 preset 目录；恢复 patch 与 profile 清单；清除 `DSH_GIT_BASH_PATH`；`DELETE /session/<id>`

### [P4] 验证挂载幂等且遗留裸包名被迁移为显式入口

[Case ID] TC-DSK-L3-271
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/workflow/win_inspector.rs:106-134`、`:224-228`、`:600-626`（单元测试 `ensure_patch_upgrades_existing_bare_name_entry`）
[自动化] 待接线（`test/e2e/specs/desktop/29-system-integration.e2e.ts`）
[前置条件] Windows 宿主；旧核心版本；插件已装入；patch 内本插件块的 `name` 为裸包名 `dsh-win-terminal-inspector`
[测试数据] patch 文件预置内容：`- insert:` + `id: win-terminal-inspector` + `name: dsh-win-terminal-inspector`
[测试步骤] 1. 触发 `win_inspector::apply`。2. 读取 patch 文件全文并记录。3. 再次触发 `apply` 并再次读取全文。
[预期结果] 1. 写入成功。2. 该块的 `name` 已迁移为 `./node_modules/dsh-win-terminal-inspector/index.js`，裸包名写法消失。3. 第二次调用后文件内容与第一次逐字相同（未重复追加、未再次改写）。
[清理] 恢复 patch 文件原始内容；`DELETE /session/<id>`

---

## 5. 平台门控与档案自愈

### [P4] 验证非 Windows 平台极简模式修复为无操作

[Case ID] TC-DSK-L3-272
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/workflow/win_inspector.rs:695-706`、`:712-714`、`:716-724`
[自动化] 待接线（`test/e2e/specs/desktop/29-system-integration.e2e.ts`）
[前置条件] macOS 或 Linux 宿主；应用处于 `ready`
[测试数据] 观察点：`win_inspector::apply` 返回值与档案目录改动、`git_bash_bin_dirs` 返回值
[测试步骤] 1. 触发一次会调用 `win_inspector::apply` 的流程。2. 对比触发前后活动档案目录的文件清单与 patch 内容。3. 读取 `git_bash_bin_dirs` 的返回。
[预期结果] 1. 调用返回 `Ok`。2. 档案目录无任何新增或改写（未创建 `minimal-win` preset、未改 patch）。3. `git_bash_bin_dirs` 返回空集合。
[清理] `DELETE /session/<id>`

### [P4] 验证 pnpm-workspace 多文档被自愈归一化为单文档

[Case ID] TC-DSK-L3-273
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/profile/mod.rs:123-152`、`:164-171`、`:191-202`；`src-tauri/src/service/plugin/install/mod.rs:213`
[自动化] 待接线（`test/e2e/specs/desktop/29-system-integration.e2e.ts`）
[前置条件] 应用处于 `ready`；活动档案的 `pnpm-workspace.yaml` 已被改写成含 `---` 分隔符的多文档 YAML（前后两份都是映射，含同名键）
[测试数据] 文件内容示例：`packages:\n  - .\n---\nnodeLinker: hoisted\n`
[测试步骤] 1. 写入多文档内容并记录。2. 触发一次会调用 `ensure_profile_pnpm_policy` 的流程（插件安装）。3. 读取文件全文与桌面端日志。
[预期结果] 1. 写入成功，文件确为多文档。2. 流程成功，未返回 `PROFILE_WORKSPACE_INVALID_YAML`。3. 文件已被回写为单文档映射，同名键取后一份的值；日志出现 `PROFILE_WORKSPACE_MULTI_DOCUMENT: normalized …`。
[清理] 恢复 `pnpm-workspace.yaml` 原始内容；`DELETE /session/<id>`

---

## 6. 选择器契约（待补）

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-config-reveal-data-dir` | 「打开数据目录」按钮 | 待补 |
| `dsh-config-clear-service-logs` | 清空日志按钮 | 待补 |
| `dsh-config-service-logs` | 日志展示区 | 待补 |
| `dsh-config-core-open-dir` | 核心「打开目录」按钮 | 待补 |
| `dsh-toast-download-show-in-folder` | 下载完成提示的「在文件夹中显示」动作 | 待补 |

---

## 7. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `reveal_in_folder` 允许根 | 260、261 | 正向 / 异常 | 符号链接指向根外的场景未构造；根不存在时的降级（`guard.rs:38-43` 只保留已存在根）**未覆盖** |
| `open_dir` 允许根 | 262 | 异常 | 本地核心包目录作为允许根的**正向**用例未覆盖（需本地核心环境） |
| `reveal_data_dir` | 263 | 正向 | 系统文件管理器实际呈现属系统表面，见 G-D29-1 |
| `open_external_url` 方案校验 | 264 | 异常 | 大小写变体（`HTTPS://`）未覆盖，见 G-D29-2 |
| 运行日志四段 | 265 | 正向 | 后台段剔除 `frontend:` 行的效果未单独断言 |
| 服务日志读取/清空 | 266、267 | 正向 | `maxBytes` 极值（0、超大）未覆盖 |
| 健康检查失败信号 | 268 | 异常 | 模块未就绪的 `healthy - n/m` 分支（`health.rs:90-92`）**未覆盖** |
| Windows 极简模式 | 269、270、271 | 正向 / 边界 | preset「已存在即跳过」（`win_inspector.rs:381-384`）与「Git Bash 未找到则跳过」（`:370-375`）**未覆盖** |
| 平台门控 | 272 | 边界 | — |
| 档案 YAML 自愈 | 273 | 边界 | 真语法错误（不合法的 YAML）保持报错的分支**未覆盖** |
| 跨平台打包与托盘 | 全局 | — | 归 §8 缺口，见 G-D29-3 / G-D29-4 |

---

## 8. 缺口与假设

- **G-D29-1**：`reveal_in_folder` / `open_dir` / `reveal_data_dir` 只断言桥接层成功返回与错误串，**不验证系统文件管理器/浏览器的实际呈现**（属系统表面，见 `00-overview.md` G9）。人工确认项。
- **G-D29-2**：`open_external_url` 的方案判定是**字面前缀匹配**（`src-tauri/src/bridge/system_os.rs:240`），`HTTPS://` 或 `https:/` 一类变体的行为由实现决定，本套未断言；接线前需要先确认期望语义，否则会把实现的宽松/严格当成缺陷。
- **G-D29-3**：跨平台打包配置（`bundle.targets = "all"`、macOS `hardenedRuntime` + `Info.plist` + `Entitlements.plist`、Windows NSIS/WiX）是**构建期**事实，无法在真实窗口的页面内断言。本文件只把它们登记为事实基线；若需覆盖，应另立构建产物校验批次（对 `.app` / `.dmg` / `.exe` 的签名与 plist 键做静态检查），不在 L3 页面用例内实现。
- **G-D29-4**：Linux 托盘（`src-tauri/src/desktop/linux_tray.rs`）的单击唤起与菜单动作是**系统托盘表面**，页面内不可断言；本文件只引用其「失败只告警不阻断启动」的语义（`:35-39`），实际托盘交互归 `12-window-tray.md` 或手工确认。
- **G-D29-5**：TC-DSK-L3-269 与 TC-DSK-L3-270 需要切换活动核心版本到 `0.1.0-rc.6` / `rc.7` 与 `≥ 0.1.0-rc.8` 两侧。旧 rc 核心可能已无法下载，接线时需准备本地核心（`00-overview.md` 未覆盖该前置）。此外两条用例都会改写 `cordis.patch.yml` 与 `$E2E_HOME/home/.dsh.dev/.agent-presets/`（§5.3），测试必须备份与还原（`00-overview.md` G8）。
- **G-D29-6**：TC-DSK-L3-272 的「无副作用」断言依赖档案目录的文件清单快照能力，当前无该工具；退化为断言 `apply` 返回 `Ok` 与 `git_bash_bin_dirs` 为空集合。
- **G-D29-7**：Windows 极简模式的错误串（`PATCH_RENDER_FAILED` / `PATCH_WRITE_FAILED` / `PATCH_PARSE_FAILED` / `PATCH_NOT_ARRAY` / `PATCH_PRUNE_FAILED`）**未覆盖**：需要在写入时制造 YAML 库渲染失败或非法顶层类型，属难以稳定构造的故障注入。
- **假设**：`read_run_logs` 的四个段标题在无内容时仍然出现（段标题由 `format!` 固定拼接，`src-tauri/src/bridge/system_os.rs:216-222`），因此 TC-DSK-L3-265 的段结构断言不依赖日志是否为空，但行数上限断言依赖日志足够长。
- **假设**：路径守卫的「允许根之外」以系统临时目录为例；`00-overview.md` §5.1 未把临时目录列入允许根，本文件据此假定它必然被拒绝（`src-tauri/src/bridge/guard.rs:18-34`）。
