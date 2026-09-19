# 应用设置

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/specs/desktop/13-application-settings.e2e.ts`（待建立）
> 前置：`03-config-dialog.md` 通过；配置对话框可打开在「应用」面板
> 运行：`vitest --project desktop -- test/e2e/specs/desktop/13-application-settings.e2e.ts`（待配置，见 G2）

「应用」面板是设置真值的写入口。设置由前端与 Rust **共享同一份 `.store.dat`**，因此本文件的断言以「运行期回读」为准，不直接读文件。写操作分两类：走 `update_app_config`（端口、关闭行为）与走独立命令（开机自启、CLI link）。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 运行期信息 `get_runtime_info`（`service_url`/`data_dir`/`log_path` 等） | `src/ui/config/debug.tsx:21-30`、`:51-54` |
| 端口合法域 `1..=65535` 且必须为整数 | `src/ui/config/debug.tsx:143-146` |
| 保存端口成功后 toast 提供「重启」入口，10s 超时 | `src/ui/config/debug.tsx:149-160` |
| 端口非法 → `PORT_INVALID` → 专用失败提示 | `src/ui/config/debug.tsx:162-170` |
| 缩放下拉 16 档 `0.5..2.0` 步长 `0.1` | `src/ui/config/debug.tsx:19` |
| 缩放真值直接写 `store.setting.zoom_factor` | `src/ui/config/debug.tsx:126-128` |
| 缩放归一化与上下限 | `src/utils/zoom.ts:62-84` |
| 缩放应用到 WebView（`Webview.setZoom`） | `src/layout/components/iframe.tsx:75`；`src/hooks/use-zoom-factor.ts:143-150` |
| 语言下拉 | `src/ui/config/debug.tsx:355-372` |
| 开机自启 `get_launch_on_login` / `set_launch_on_login` | `src/ui/config/components/launch-on-login.tsx:10-23` |
| 关闭行为 `close_action`（写入走 `update_app_config`） | `src/ui/config/components/close-action.tsx:24-33` |
| CLI link 开关 + `get_cli_link_status` | `src/ui/config/debug.tsx:64-67`、`:110-120` |
| CLI link 提示：`bin_dir` / `user_dsh_preserved` 分支 | `src/ui/config/debug.tsx:313-329` |
| 日志面板轮询间隔 2000ms | `src/ui/config/debug.tsx:69-73` |
| 清空日志 `clear_service_logs` | `src/ui/config/debug.tsx:98-108` |
| 复制服务地址 `copy_service_url` | `src/ui/config/debug.tsx:130-139` |
| 打开数据目录 `reveal_data_dir` | `src/ui/config/debug.tsx:173-179` |
| `setting_updated` 事件触发运行期信息重拉 | `src/ui/config/debug.tsx:57-59` |
| 端口避让后回落 `manual_port` | `src-tauri/src/service/workflow/launch.rs:316-321`；issue #91 |

---

## 2. 端口

### [P1] 验证保存合法端口写入设置并提示重启

[Case ID] TC-DSK-L3-095
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/config/debug.tsx:141-171`；issue #91
[自动化] 待接线（`test/e2e/specs/desktop/13-application-settings.e2e.ts`）
[前置条件] 服务处于运行中
[测试数据] 端口 `3099`（合法且未占用）
[测试步骤] 1. 在端口输入框填入 `3099`。2. 点击「保存」。3. 读取提示内容与提示中的操作入口。4. 读取已保存的端口值。
[预期结果] 1. 输入成功。2. 保存被接受。3. 出现「端口已修改」提示与「重启后生效」说明，并提供「重启」操作入口。4. 已保存端口为 `3099`。
[清理] 端口改回原值并重启服务；`DELETE /session/<id>`

### [P3] [反向] 验证非法端口被拒绝保存

[Case ID] TC-DSK-L3-096
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/ui/config/debug.tsx:143-146`、`:162-170`
[自动化] 待接线（同上）
[前置条件] 服务处于运行中
[测试数据] 非法值：`0`、`65536`、`1.5`、空值
[测试步骤] 1. 依次填入每个非法值并点击「保存」。2. 每次读取提示内容与语义。3. 最后读取端口输入框的已保存值。
[预期结果] 1. 四次提交均被拒绝。2. 每次均出现「端口非法」提示（危险语义），不出现成功提示。3. 已保存端口保持为提交前的值。
[清理] `DELETE /session/<id>`

---

## 3. 显示与行为

### [P2] 验证缩放选择后 WebView 缩放生效并持久化

[Case ID] TC-DSK-L3-097
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/config/debug.tsx:374-402`、`:126-128`；`src/hooks/use-zoom-factor.ts:143-150`
[自动化] 待接线（同上）
[前置条件] 服务处于运行中；当前缩放为 100%
[测试数据] 目标缩放 `150%`（比例 `1.5`）；观察点 `window.innerWidth`
[测试步骤] 1. 记录当前 `window.innerWidth`。2. 在缩放下拉中选择 `150%`。3. 等待缩放应用。4. 再次读取 `window.innerWidth` 与已保存缩放值。
[预期结果] 1. 记录成功。2. 选择被接受。3. 应用完成。4. `window.innerWidth` 约为原值的 `1/1.5`（允许 ±2px 误差）；已保存缩放值为 `1.5`。
[清理] 缩放改回 `1`；`DELETE /session/<id>`

### [P2] 验证开机自启开关持久化

[Case ID] TC-DSK-L3-098
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/config/components/launch-on-login.tsx:10-23`
[自动化] 待接线（同上）
[前置条件] 服务处于运行中；当前开机自启为关闭
[测试数据] 目标状态：开启
[测试步骤] 1. 读取开关状态。2. 点击开关。3. 等待请求返回并回读。4. 重启应用后再次读取。
[预期结果] 1. 状态为关闭。2. 点击被接受。3. 回读状态为开启，无错误提示。4. 重启后状态仍为开启。
[清理] 关闭开机自启；`DELETE /session/<id>`

### [P2] 验证关闭行为选择持久化

[Case ID] TC-DSK-L3-099
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/config/components/close-action.tsx:24-33`
[自动化] 待接线（同上）
[前置条件] 服务处于运行中；当前关闭行为为 `tray`
[测试数据] 目标值 `quit`
[测试步骤] 1. 在下拉中选择「退出」。2. 等待写入完成。3. 重启应用后读取下拉当前值。
[预期结果] 1. 选择被接受。2. 写入成功且无错误提示。3. 重启后下拉当前值为 `quit`。
[清理] 改回 `tray`；`DELETE /session/<id>`

### [P3] 验证 CLI link 开关创建与删除 shim

[Case ID] TC-DSK-L3-100
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/ui/config/debug.tsx:110-120`、`:64-67`
[自动化] 待接线（同上）
[前置条件] 服务处于运行中；当前 CLI link 为关闭
[测试数据] 选择器 `dsh-config-cli-link`；观察点 `get_cli_link_status` 的 `shim_exists`
[测试步骤] 1. 读取 `shim_exists`。2. 打开开关。3. 回读 `shim_exists` 与 `enabled`。4. 关闭开关并回读。
[预期结果] 1. `shim_exists` 为假。2. 开关被接受。3. `enabled` 为真，`shim_exists` 为真，`shim_path` 非空。4. `enabled` 为假，`shim_exists` 为假。
[清理] 恢复 CLI link 原状态；`DELETE /session/<id>`

---

## 4. 日志与系统入口

### [P2] 验证清空日志后日志面板为空

[Case ID] TC-DSK-L3-101
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/config/debug.tsx:98-108`、`:431-433`
[自动化] 待接线（同上）
[前置条件] 服务处于运行中；日志面板存在非空内容
[测试数据] 选择器 `dsh-config-logs`、`dsh-config-clear-logs`
[测试步骤] 1. 确认日志面板非空。2. 点击清空按钮。3. 等待刷新并读取面板文本。
[预期结果] 1. 面板非空。2. 点击被接受。3. 面板文本变为空态文案，且不再包含清空前的日志行。
[清理] `DELETE /session/<id>`

### [P4] 验证日志面板按固定间隔刷新

[Case ID] TC-DSK-L3-102
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/ui/config/debug.tsx:69-73`（`refetchInterval: 2000`）
[自动化] 待接线（同上）
[前置条件] 服务处于运行中；可让服务持续产生日志
[测试数据] 观察窗口：刷新间隔 `2000ms`
[测试步骤] 1. 让服务产生一行新日志。2. 记录面板文本。3. 等待一个刷新间隔后再次读取。
[预期结果] 1. 日志产生成功。2. 记录成功。3. 面板文本包含新日志行。
[清理] `DELETE /session/<id>`

### [P4] 验证复制服务地址写入剪贴板

[Case ID] TC-DSK-L3-103
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/ui/config/debug.tsx:130-139`
[自动化] 待接线（同上）
[前置条件] 服务处于运行中
[测试数据] 选择器 `dsh-config-copy-url`
[测试步骤] 1. 清空剪贴板。2. 点击复制按钮。3. 读取剪贴板文本与当前服务地址。
[预期结果] 1. 清空成功。2. 点击被接受并出现成功提示。3. 剪贴板文本等于当前服务地址。
[清理] 清空剪贴板；`DELETE /session/<id>`

### [P4] 验证打开数据目录调用系统文件管理器

[Case ID] TC-DSK-L3-104
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/ui/config/debug.tsx:173-179`、`:280-289`
[自动化] 待接线（同上）
[前置条件] 服务处于运行中；执行环境允许拉起系统文件管理器
[测试数据] 选择器 `dsh-config-reveal-dir`
[测试步骤] 1. 点击文件夹按钮。2. 等待命令返回。3. 读取控制台错误收集器。
[预期结果] 1. 点击被接受。2. 命令成功返回。3. 收集器为空（无 `reveal_data_dir` 失败错误）。
[清理] 关闭被拉起的文件管理器窗口；`DELETE /session/<id>`

---

## 5. 选择器契约（待补）

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-config-port` | 端口输入框 | 待补 |
| `dsh-config-port-save` | 端口「保存」按钮 | 待补 |
| `dsh-config-zoom` | 缩放下拉 | 待补 |
| `dsh-config-language-select` | 语言下拉 | 待补 |
| `dsh-config-launch-on-login` | 开机自启开关 | 待补 |
| `dsh-config-close-action` | 关闭行为下拉 | 待补 |
| `dsh-config-cli-link` | CLI link 开关 | 待补 |
| `dsh-config-copy-url` | 复制服务地址按钮 | 待补 |
| `dsh-config-logs` | 日志面板 | 待补 |
| `dsh-config-clear-logs` | 清空日志按钮 | 待补 |
| `dsh-config-copy-logs` | 复制日志按钮 | 待补 |
| `dsh-config-reveal-dir` | 打开数据目录按钮 | 待补 |

---

## 6. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 端口校验与保存 | 095、096 | 正向 / 异常 | 端口避让后回落 `manual_port`（issue #91）**未覆盖**，需占用新端口后重启 |
| 缩放 | 097 | 正向 | 快捷键路径归 `19`；macOS < 11 不支持缩放的降级分支**未覆盖** |
| 开机自启 | 098 | 正向 | 需要真实重新登录系统才能验证实际生效，**只验证持久化** |
| 关闭行为 | 099 | 正向 | 行为分支归 `12` |
| CLI link | 100 | 异常 | `user_dsh_preserved` 为真的提示分支**未覆盖**（需本机已有用户自装 `dsh`） |
| 日志 | 101、102 | 正向 / 边界 | 日志行上限与滚动行为未覆盖 |
| 系统入口 | 103、104 | 边界 | 只断言命令成功，不校验系统窗口实际出现 |

---

## 7. 缺口与假设

- **G-D13-1**：TC-DSK-L3-098 只验证「开关状态持久化」。开机自启**实际生效**需要真实重新登录操作系统，属手工确认项（`00-overview.md` G9）。
- **G-D13-2**：TC-DSK-L3-100 会创建/删除 `%LOCALAPPDATA%\deepseek-harness\bin` 下的 shim 并修改用户 `PATH`（`agents.desktop.md` §5）。接线时必须先记录原始状态并在清理时还原，否则会污染开发者本机环境。
- **G-D13-3**：端口「避让后回落 `manual_port`」（issue #91）是一条独立且易错的行为，需要「占用配置端口 → 重启 → 断言回落到 `manual_port`」三步构造，**未覆盖**。
- **G-D13-4**：macOS 10.15 不支持 `WKWebView.pageZoom`（`use-zoom-factor.ts:79-91`），该平台下缩放只维护数值不实际应用。**未覆盖**，需旧版 macOS。
- **假设**：设置真值由前端与 Rust 共享同一份 `.store.dat`；本文件全部通过运行期回读断言，不直接读写该文件。
