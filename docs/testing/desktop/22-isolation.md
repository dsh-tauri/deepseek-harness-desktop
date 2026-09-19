# 端口与数据隔离

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/specs/desktop/22-isolation.e2e.ts`（待建立）
> 前置：`13-application-settings.md` 通过；应用处于 `ready`；测试侧可占用/释放 `127.0.0.1` 端口并读取 app-data 根与数据目录路径
> 运行：`vitest --project desktop -- test/e2e/specs/desktop/22-isolation.e2e.ts`（待配置，见 G2）

桌面端以构建类型（debug / release）为界，把端口、数据目录、store 文件与可执行核心目录逐层切开，使开发版与已安装版本可以并存而不互写。本文件验证这条边界是外部可观察的事实：默认端口、占用回退、残留清扫与目录归属都必须能由窗口、命令返回值与落盘路径证明，而不是只存在于注释的意图里。

本文件全部路径均在 `$E2E_HOME` 之下（`docs/specs/desktop.test.md` §6）。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| `default_port()` = `cfg!(debug_assertions) ? DSH_DEV_PORT(3081) : DSH_PORT(3080)` | `src-tauri/src/config/setting.rs:149`；`src-tauri/src/config/constants.rs:50`、`:53` |
| `get_dsh_data_path`：debug 恒 `$E2E_HOME/home/.dsh.dev`（忽略 `DSH_HOME`）；release 优先非空 `DSH_HOME`，否则 `<home>/.dsh` | `src-tauri/src/config/runtime.rs:471`、`:455`、`:482` |
| Store 文件名：生产 `.store.dat` / 开发 `.store.dev.dat` / **E2E `.store.test.dat`**，位于 tauri store 的 AppData 根（不在 `dev` 子目录）；首装检测同源同文件名 | `src-tauri/src/config/setting.rs`（`store_dat_file_name`）、`:214`、`:230`；常量在 `config/constants.rs` |
| `get_base_dir` = debug `AppData/dev` : release `AppData`；其下放核心可执行物（`runtime`、`dependencies/dsh`、`dependencies/pnpm`、`dependencies/git`、`logs`） | `src-tauri/src/config/runtime.rs:17`、`:273`、`:491`；`src-tauri/src/config/constants.rs:63` |
| 端口回退 `find_available_port_by` 从 start 起 `checked_add(1)` 找首个空闲；`u16::MAX` 仍占用报 `PORT_EXHAUSTED: no available TCP port after the configured port` | `src-tauri/src/service/workflow/launch.rs:66`、`:75`、`:85` |
| `is_port_in_use` = 绑 `127.0.0.1:port` 失败即占用；调用前 `wait_for_port_release`（≤1500ms） | `src-tauri/src/service/workflow/utils.rs:154`；`src-tauri/src/service/workflow/launch.rs:48` |
| 端口自愈 `heal_target = setting.manual_port.unwrap_or(default_port())`，仅目标空闲时回落，最终端口写回 store | `src-tauri/src/service/workflow/launch.rs:98`、`:319`；`src-tauri/src/bridge/config.rs:48` |
| 启动参数 `--profile <active> --port <n>`（可选 `--no-open`、`--skip-auth`），**未传 `--host`** | `src-tauri/src/service/workflow/launch.rs:638`、`:645`、`:753` |
| `--no-open` 首个支持版本 `0.1.0-rc.8`，按实际将执行的 `bin.js` 判定 | `src-tauri/src/service/workflow/launch.rs:119`、`:144`、`:592` |
| Windows 经 `win_spawn::spawn_with_hidden_console_owned`（`CREATE_NEW_CONSOLE`+`SW_HIDE`）分配隐藏控制台 | `src-tauri/src/service/workflow/win_spawn.rs:144`、`:147`、`:162`；`src-tauri/src/service/workflow/launch.rs:625` |
| Unix 用 `.process_group(0)` 独立进程组 + 空 stdin | `src-tauri/src/service/workflow/launch.rs:766`、`:771` |
| Windows 早退重试：探测 ≤2.5s，命中 `duplicate loader entry` 签名则重置档案根重试，最多 3 次 | `src-tauri/src/service/workflow/launch.rs:665`、`:684`、`:256` |
| `.harness.pid` = `$DSH_HOME/.harness.pid`（两行：PID、端口），spawn 成功后落盘 | `src-tauri/src/service/workflow/sweep.rs:16`；`src-tauri/src/service/workflow/launch.rs:854` |
| 孤儿清扫双重确认：LISTENING 端口的 owner PID 必须等于文件 PID，否则不动；`port_owner_pid` 为探测函数 | `src-tauri/src/service/workflow/sweep.rs:34`、`:76` |
| `terminate_stale_harness_processes` 在 debug 为 no-op | `src-tauri/src/service/workflow/process.rs:357` |
| 迁移：debug 直接 `Ok`；release 检查 `dsh_home_migrated` 幂等标记 | `src-tauri/src/service/migrate.rs:38`；`src-tauri/src/desktop/builder.rs:108` |

---

## 2. 端口默认值与占用回退

### [P1] 验证 debug 默认端口为 3081 且可读回配置

[Case ID] TC-DSK-L3-175
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/config/setting.rs:149`；`src-tauri/src/config/constants.rs:53`
[自动化] 待接线（`test/e2e/specs/desktop/22-isolation.e2e.ts`）
[前置条件] Debug 二进制；`$E2E_HOME` 下无历史 store（首次启动）
[测试数据] 期望端口 `3081`
[测试步骤] 1. 启动应用并等待 `ready`。2. 读取 `get_runtime_info().service_url`。3. 读取已保存的 `port`。
[预期结果] 1. 应用进入 `ready`。2. `service_url` 为 `http://127.0.0.1:3081`。3. 已保存 `port` 等于 `3081`。
[清理] `DELETE /session/<id>`

### [P1] 验证默认端口被占用时自动递增避让

[Case ID] TC-DSK-L3-176
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/workflow/launch.rs:66`、`:85`
[自动化] 待接线（同上）
[前置条件] 测试侧先占用 `127.0.0.1:3081`
[测试数据] 占用端口 `3081`；期望服务落在 `3082`
[测试步骤] 1. 占用 `3081`。2. 启动应用并等待服务健康。3. 读取 `service_url` 与已保存 `port`。
[预期结果] 1. 占用成功。2. 服务进入运行中。3. `service_url` 使用 `3082`，已保存 `port` 同步为 `3082`。
[清理] 释放测试占用的端口；`DELETE /session/<id>`

### [P4] 验证端口段耗尽时报可判定错误

[Case ID] TC-DSK-L3-177
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/workflow/launch.rs:85`
[自动化] 待接线（同上）
[前置条件] 把 store 的 `port` 设为 `65535`，并由测试占用 `127.0.0.1:65535`
[测试数据] 端口 `65535`（`src/ui/config/debug.tsx:143-146` 的合法上限）
[测试步骤] 1. 写入 `port=65535` 并占用该端口。2. 启动应用并等待收敛。3. 读取错误信息与最终状态。
[预期结果] 1. 写入与占用成功。2. 启动失败并进入错误态。3. 错误信息含 `PORT_EXHAUSTED: no available TCP port after the configured port`；应用不崩溃。
[清理] 释放端口并复位 `port`；`DELETE /session/<id>`

### [P4] 验证重启前等待旧端口释放

[Case ID] TC-DSK-L3-178
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/workflow/launch.rs:48`、`:55`
[自动化] 待接线（同上）
[前置条件] 服务处于运行中
[测试数据] `PORT_RELEASE_WAIT = 1500ms`
[测试步骤] 1. 触发重启。2. 观察重启期间是否出现端口争用导致的失败。3. 读取最终 `service_url`。
[预期结果] 1. 重启被接受。2. 等待窗口内旧端口释放完成，不出现 `EADDRINUSE` 类失败。3. 新实例使用同一端口，服务进入运行中。
[清理] `DELETE /session/<id>`

### [P2] 验证端口避让后回落到设置端口

[Case ID] TC-DSK-L3-179
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/workflow/launch.rs:98`、`:319`、`:337`
[自动化] 待接线（同上）
[前置条件] 先构造「已自动避让递增」的中间态（占用 `3081` → 启动 → 服务落在 `3082`），随后释放 `3081`
[测试数据] `manual_port` 为空，`heal_target` 回落 `default_port()`
[测试步骤] 1. 释放被占用的 `3081`。2. 触发重启。3. 读取 `service_url` 与已保存 `port`。
[预期结果] 1. 释放成功。2. 重启完成。3. `service_url` 回落 `3081`，已保存 `port` 同步为 `3081`。
[清理] `DELETE /session/<id>`

---

## 3. 子进程启动与平台隔离

### [P1] 验证服务使用当前档案与配置端口启动

[Case ID] TC-DSK-L3-180
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/workflow/launch.rs:638`、`:640`、`:642`
[自动化] 待接线（同上）
[前置条件] 当前档案非默认档案（如已新建 `args-check`）
[测试数据] 观察点：服务子进程命令行
[测试步骤] 1. 切到目标档案并启动服务。2. 读取服务子进程命令行。3. 读取当前档案与端口。
[预期结果] 1. 服务进入运行中。2. 命令行含 `--profile <当前档案>` 与 `--port <配置端口>`；**不含** `--host`。3. 命令行中的档案与端口和运行期真值一致。
[清理] 切回原档案并重启；删除测试档案；`DELETE /session/<id>`

### [P3] 验证 dsh 版本低于 rc.8 时不传 --no-open

[Case ID] TC-DSK-L3-181
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/workflow/launch.rs:119`、`:144`、`:592`
[自动化] 待接线（同上）
[前置条件] 活动核心版本低于 `0.1.0-rc.8`
[测试数据] 观察点：`--no-open` 是否出现
[测试步骤] 1. 以低于 rc.8 的核心启动服务。2. 读取命令行是否含 `--no-open`。3. 换用 ≥ rc.8 的核心重复。
[预期结果] 1. 服务进入运行中。2. 命令行**不含** `--no-open`。3. 使用 ≥ rc.8 核心时命令行**含** `--no-open`。
[清理] 复位活动核心；`DELETE /session/<id>`

### [P3] [反向] 验证 Windows 早退命中重复装载签名后重试

[Case ID] TC-DSK-L3-182
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/workflow/launch.rs:665`、`:684`、`:256`
[自动化] 待接线（同上）
[前置条件] Windows；把当前档案根构造成会让首个实例以 `duplicate loader entry` 早退的状态
[测试数据] 观察点：服务日志中的重启尝试与最终 PID
[测试步骤] 1. 构造早退条件并启动服务。2. 读取服务日志中的早退签名与重置记录。3. 读取最终服务状态与 `.harness.pid`。
[预期结果] 1. 启动被接受。2. 日志出现 `duplicate loader entry` 签名，实例被丢弃并重置档案根后重试（不超过 3 次）。3. 最终服务进入运行中，`.harness.pid` 指向最终采用实例的 PID。
[清理] 还原档案根；`DELETE /session/<id>`

---

## 4. 数据目录与残留清扫隔离

### [P1] 验证 debug 数据目录恒为 $E2E_HOME/home/.dsh.dev 且忽略 DSH_HOME

[Case ID] TC-DSK-L3-183
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/config/runtime.rs:471`、`:455`、`:482`；`src-tauri/src/config/constants.rs:61`
[自动化] 待接线（同上）
[前置条件] 启动前设置非空 `DSH_HOME` 指向一个可区分的临时目录
[测试数据] `DSH_HOME=$E2E_HOME/decoy`；期望 `data_dir = $E2E_HOME/home/.dsh.dev`
[测试步骤] 1. 带上述 `DSH_HOME` 启动应用。2. 读取 `get_runtime_info().data_dir`。3. 读取「应用」面板显示的数据目录文本。
[预期结果] 1. 应用进入 `ready`。2. `data_dir` 为 `$E2E_HOME/home/.dsh.dev`，不等于 `DSH_HOME` 的值。3. 面板文本与 `data_dir` 一致。
[清理] 删除诱饵目录；`DELETE /session/<id>`

### [P2] 验证 debug 的 store 与可执行核心落在独立位置

[Case ID] TC-DSK-L3-184
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/config/setting.rs:191`、`:214`；`src-tauri/src/config/runtime.rs:17`、`:273`
[自动化] 待接线（同上）
[前置条件] Debug 应用首次启动
[测试数据] 期望 `$E2E_HOME/appdata/io.github.hairyf.deepseek-harness-desktop/.store.dev.dat` 与同根 `dev/runtime`、`dev/dependencies/dsh`、`dev/logs`
[测试步骤] 1. 启动应用并等待 `ready`，触发一次设置写入。2. 检查 app-data 根下的 store 文件。3. 检查 `dev` 子目录下的核心目录与 `data_dir` 归属。
[预期结果] 1. 应用进入 `ready`。2. app-data 根下存在 `.store.dev.dat`，本次运行未创建 `.store.dat`。3. `dev` 子目录下存在 `runtime`、`dependencies/dsh`、`logs`；store 文件不在 `dev` 子目录内；`data_dir` 位于 `$E2E_HOME` 之下。
[清理] `DELETE /session/<id>`

### [P2] 验证残留标记落盘并按 PID 与端口双确认清扫

[Case ID] TC-DSK-L3-185
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/workflow/sweep.rs:16`、`:34`、`:76`；`src-tauri/src/service/workflow/launch.rs:854`
[自动化] 待接线（同上）
[前置条件] 服务处于运行中；测试侧可在应用外部强杀应用进程而不结束其服务子进程
[测试数据] `$E2E_HOME/home/.dsh.dev/.harness.pid`，内容两行：PID、端口
[测试步骤] 1. 读取 `.harness.pid` 路径与两行内容。2. 在应用外部强制结束应用进程。3. 重新启动应用并读取服务状态与 `.harness.pid`。
[预期结果] 1. 文件位于 `$E2E_HOME/home/.dsh.dev/`，第一行等于当前服务 PID，第二行等于当前服务端口。2. 应用进程结束，`.harness.pid` 保留。3. 新实例完成孤儿清扫后服务进入运行中，`.harness.pid` 被更新为新实例的 PID 与端口。
[清理] `DELETE /session/<id>`

### [P4] 验证 debug 构建不执行旧数据迁移

[Case ID] TC-DSK-L3-186
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/migrate.rs:38`；`src-tauri/src/desktop/builder.rs:108`
[自动化] 待接线（同上）
[前置条件] Debug 应用；预先在 `$E2E_HOME/appdata/io.github.hairyf.deepseek-harness-desktop/dev/data/dsh` 放置可识别的旧目录内容
[测试数据] 旧目录标记文件 `.e2e-marker`
[测试步骤] 1. 预置旧目录与标记文件。2. 启动应用并等待 `ready`。3. 检查旧目录与标记文件是否仍在原处。4. 读取 `get_runtime_info().data_dir`。
[预期结果] 1. 预置成功。2. 应用进入 `ready`。3. 旧目录与标记文件仍存在于原位，未被搬移或删除。4. `data_dir` 为 `$E2E_HOME/home/.dsh.dev`，未承接旧目录内容。
[清理] 删除预置的旧目录；`DELETE /session/<id>`

---

## 5. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 默认端口与占用递增 | 175、176 | 正向 | 占用者为本应用残留与为第三方程序未分别断言 |
| 端口段耗尽 | 177 | 边界 | 需把 store 端口写到 `65535` 并占用它 |
| 端口释放等待窗口 | 178 | 边界 | 依赖真实释放滞后，稳定性待接线时验证 |
| 端口自愈回落 | 179 | 正向 | 需先构造避让递增态；`manual_port` 为空时回落默认端口的分支未单列 |
| 启动参数 | 180 | 正向 | 只断言参数，不断言 dsh 对参数的解释 |
| `--no-open` 能力判定 | 181 | 边界 | 需同时具备低于与不低于 `0.1.0-rc.8` 的核心；「按实际 `bin.js` 判定」与「按活动核心登记版本判定」的分歧**未覆盖** |
| Windows 早退重试 | 182 | 异常 | 需构造 `duplicate loader entry` 档案根；Unix 同逻辑分支未单列 |
| 数据目录隔离 | 183、184 | 正向 | debug 与 release 并存互不干扰**未覆盖**（需同时运行两个构建） |
| 残留清扫 | 185 | 正向 | 「无法确认占用者则不杀进程」的负向分支**未覆盖** |
| 旧数据迁移 | 186 | 边界 | 只覆盖 debug 跳过；release 真实迁移路径归迁移相关用例 |

---

## 6. 缺口与假设

- **G-D22-1**：TC-DSK-L3-179 需要先构造「已自动避让递增」的中间态（占用 `manual_port` → 启动 → 释放），再断言回落。构造步骤本身会拉起额外实例，接线时必须保证清扫与端口释放先完成，否则用例会观测到递增中间态而非回落结果。
- **G-D22-2**：TC-DSK-L3-182 需要把当前档案根构造成 `duplicate loader entry` 早退状态，且「重试次数不超过 3」只能从日志行断言。当前无结构化日志采集出口，接线时需在编排层解析服务日志，或在具备只读诊断出口前降级为「最终状态健康」。
- **G-D22-3**：TC-DSK-L3-185 只覆盖「标记 PID == 端口占用者」的正向分支。「标记不可解析 → 仅清标记」「端口占用者非标记 PID → 不动」「探测不到占用者 → 不动」三条负向分支（`sweep.rs:46-66`）**未覆盖**，需要构造一个非本应用占用同端口的场景。
- **G-D22-4**：debug 与 release 的并存隔离（3081/3080、`.dsh.dev`/`.dsh`、`.store.dev.dat`/`.store.dat`、app-data 根与 `dev` 子目录）是本文件的核心主张，但单次 L3 运行只能拉起一个构建。需两条流水线并发执行，或分两次运行后比对路径集合；当前无该编排。
- **G-D22-5**：store 键 `window_state`、`pet_window_state`、`desktop_pending_installer` 与 `setting` 的隔离只做了基线登记。本文件断言到 store 文件名与位置（TC-DSK-L3-184），**未逐键断言**；键级归属归 `12`、`16`、`17`。
- **G-D22-6**：TC-DSK-L3-177 需要把 store 端口写成 `65535`。壳层端口输入域的合法上限正是 `65535`（`src/ui/config/debug.tsx:143-146`），可经 UI 构造，但该用例会短暂占用最后一档端口，接线时须与其它用例串行。
- **假设**：store 真值一律以运行期回读为准（同 `13-application-settings.md`），TC-DSK-L3-184 是唯一按落盘路径断言的用例；前置构造的目录与占用进程一律由测试侧自行清理。
