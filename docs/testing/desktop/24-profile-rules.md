# 档案名称规则、初始化形态与隔离性

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/desktop/24-profile-rules.e2e.ts`（待建立）
> 前置：`05-profile.md` 通过；配置对话框可打开在「档案」面板
> 运行：`vitest --project desktop -- test/e2e/desktop/24-profile-rules.e2e.ts`（待配置，见 G2）

本文件只覆盖**后端规则面**：名称规范化、创建与克隆的校验顺序及错误码、初始化落盘的四个文件、以及档案之间的隔离边界。界面呈现与写操作反馈归 `05-profile.md`，此处不重复断言。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 规范化 `normalize_profile_id`：小写 → 仅保留 ASCII 字母数字 → ` `/`-`/`_` 记为待插入分隔符、连续分隔符合并为一个 `-`、仅在输出非空时插入 → 其余字符丢弃 → 去首尾 `-` | `src-tauri/src/service/profile/mod.rs:289` |
| 规范化断言样本 `My Work Space`/`  dev--stage  `/`中文档案`/`a_b-c` | `src-tauri/src/service/profile/mod.rs:1043` |
| `create` 五项校验顺序与错误码（空名 → 规范化为空 → 长度 → 保留名 → 目录已存在） | `src-tauri/src/service/profile/mod.rs:308` |
| 唯一保留名 `web`；64 上限比较的是规范化后的 id | `src-tauri/src/service/profile/mod.rs:42`、`:320` |
| 引导档案 `tauri`、安全档案 `safe`（`create` 不拦截） | `src-tauri/src/service/profile/mod.rs:51`、`:59` |
| `clone_with_root` 对显式名走同一套五项校验（含 64 上限与 `web` 保留） | `src-tauri/src/service/profile/mod.rs:569` |
| 新档案初始化写入 4 个文件 | `src-tauri/src/service/profile/mod.rs:879` |
| 清单来源 `web_profile_manifest` | `src-tauri/src/service/profile/mod.rs:707` |
| `cordis.patch.yml` / `pnpm-workspace.yaml` / `.npmrc` 内容 | `src-tauri/src/service/profile/mod.rs:888` |
| 写权限预检 `perm::ensure_dir_writable(dir, "PROFILE_MKDIR")` 先于落盘 | `src-tauri/src/service/profile/mod.rs:884` |
| 半初始化目录的核心 web 层自愈 `ensure_profile_core_bundles` | `src-tauri/src/service/profile/mod.rs:732` |
| `create` 的目录判存（已存在即 `PROFILE_EXISTS`，不幂等） | `src-tauri/src/service/profile/mod.rs:324` |
| 档案目录 `$DSH_HOME/profiles/<id>`（测试中为 `$E2E_HOME/home/.dsh.dev/profiles/<id>`，见 `00-overview.md` §5.3） | `src-tauri/src/service/profile/mod.rs:99` |
| 启动与插件操作按 `active_profile` 解析该目录 | `src-tauri/src/service/plugin/installed.rs:37` |
| 列表行字段 `id`/`name`/`default`/`active` 与命令注册 | `src-tauri/src/service/profile/mod.rs:85`；`src-tauri/src/bridge/profile.rs:11`；`src-tauri/src/desktop/builder.rs:901` |
| 展示名 `manifest_display_name`（去 `dsh-profile-` 前缀、回落 id、首字母大写） | `src-tauri/src/service/profile/mod.rs:224`、`:1104` |
| 列表跳过点目录与 `node_modules`；`web` 目录缺失时合成行 | `src-tauri/src/service/profile/mod.rs:254` |
| 排序：默认档案在前，其余按 id 字典序 | `src-tauri/src/service/profile/mod.rs:283` |
| `active_profile` 回退 `web`（空值/等于 `web`/目录缺失） | `src-tauri/src/service/profile/mod.rs:211` |
| `set_active` 错误码 | `src-tauri/src/service/profile/mod.rs:337` |
| `remove` 删除守卫 | `src-tauri/src/service/profile/mod.rs:532` |
| home 层 `$DSH_HOME/cordis.patch.yml` 作用于所有档案（含安全档案）；测试路径同受 §5.3 约束 | `src-tauri/src/bridge/lifecycle.rs:349` |
| 档案面板列表、active 标记与克隆对话框 | `src/ui/config/profile.tsx:254`、`:285`、`:104` |

---

## 2. 名称规范化

### [P1] 验证规范化折叠分隔符并保留 ASCII 字母数字

[Case ID] TC-DSK-L3-196
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/profile/mod.rs:289`；`src-tauri/src/service/profile/mod.rs:1043`
[自动化] 待接线（`test/e2e/desktop/24-profile-rules.e2e.ts`）
[前置条件] 配置对话框打开在「档案」面板；`$E2E_HOME/home/.dsh.dev/profiles` 可写（§5.3）
[测试数据] 名称 `My Work Space`、`  dev--stage  `、`a_b-c`
[测试步骤] 1. 依次用三个名称新建档案。2. 每次创建后读取 `get_profiles` 返回行的 `id`。3. 复查 `profiles/` 下的目录名。
[预期结果] 1. 三次创建均成功返回。2. 对应 `id` 依次为 `my-work-space`、`dev-stage`、`a-b-c`。3. 目录名与 `id` 一致：小写、连续分隔符合并为一个 `-`、首尾 `-` 被去除。
[清理] 删除本用例新建的三个档案目录；`DELETE /session/<id>`

### [P2] 验证非字母数字字符被丢弃而非转为 `-`

[Case ID] TC-DSK-L3-197
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/profile/mod.rs:289`
[自动化] 待接线（`test/e2e/desktop/24-profile-rules.e2e.ts`）
[前置条件] 配置对话框打开在「档案」面板；`profiles/` 为空或与测试名无冲突
[测试数据] 名称 `a.b/c`、`A+B`、`中文档案`
[测试步骤] 1. 用 `a.b/c` 新建并读取 `id`。2. 用 `A+B` 新建并读取 `id`。3. 用 `中文档案` 新建。
[预期结果] 1. `id` 为 `abc`：`.` 与 `/` 被丢弃，不产生分隔符。2. `id` 为 `ab`：`+` 被丢弃，不产生分隔符。3. 返回 `PROFILE_INVALID_NAME`，不创建目录。
[清理] 删除前两步新建的档案目录

---

## 3. 创建与克隆的校验与错误码

### [P2] 验证空名与规范化后为空的名称返回不同错误码

[Case ID] TC-DSK-L3-198
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/profile/mod.rs:308`
[自动化] 待接线（`test/e2e/desktop/24-profile-rules.e2e.ts`）
[前置条件] 可调用 `create_profile` 命令（界面或命令层）
[测试数据] 名称 `   `（三个空格）、`中文档案`、`...`
[测试步骤] 1. 用纯空白名请求创建。2. 用 `中文档案` 请求创建。3. 用 `...` 请求创建。
[预期结果] 1. 返回 `PROFILE_EMPTY_NAME: profile name is empty`，未落盘。2. 返回 `PROFILE_INVALID_NAME: profile name has no usable characters`，未落盘。3. 返回同一 `PROFILE_INVALID_NAME`（符号被丢弃后规范化为空），未落盘。
[清理] 无需清理（均未落盘）

### [P2] 验证 64 字符上限按规范化结果比较

[Case ID] TC-DSK-L3-199
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/profile/mod.rs:308`、`:320`
[自动化] 待接线（`test/e2e/desktop/24-profile-rules.e2e.ts`）
[前置条件] `profiles/` 下不存在同名档案
[测试数据] 名称 64 个 `a`；名称 65 个 `a`；名称 64 个 `a` 加一个 `.`（原始 65 字符）
[测试步骤] 1. 用 64 个 `a` 创建。2. 用 65 个 `a` 创建。3. 用 64 个 `a` 加 `.` 创建。
[预期结果] 1. 创建成功，`id` 为 64 个 `a`。2. 返回 `PROFILE_NAME_TOO_LONG: profile id exceeds 64 characters`。3. 创建成功，`id` 仍为 64 个 `a`——上限比较的是规范化后的 id，原始输入长度不计。
[清理] 删除第 1、3 步创建的档案目录

### [P3] [反向] 验证保留名与已存在目录不会被静默重建

[Case ID] TC-DSK-L3-200
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/profile/mod.rs:320`、`:324`
[自动化] 待接线（`test/e2e/desktop/24-profile-rules.e2e.ts`）
[前置条件] 已存在一个档案 `dev-check`，其 `package.json` 内容已记录
[测试数据] 名称 `web`、`WEB`、`dev-check`
[测试步骤] 1. 用 `web` 请求创建。2. 用 `WEB` 请求创建。3. 用 `dev-check` 请求创建并复查该档案的 `package.json`。
[预期结果] 1. 返回 `PROFILE_RESERVED: this name is reserved`。2. 返回同一 `PROFILE_RESERVED`（规范化后等于 `web`）。3. 返回 `PROFILE_EXISTS: profile dev-check already exists`，且既有 `package.json` 内容与记录值逐字一致——`create` 不幂等。
[清理] 删除 `dev-check` 档案目录

### [P4] 验证只有 `web` 被保留，引导与安全档案名不被拦截

[Case ID] TC-DSK-L3-201
[层级] L3（真实 Tauri 窗口）
[类型] 低频
[追踪] `src-tauri/src/service/profile/mod.rs:42`、`:51`、`:59`、`:569`
[自动化] 待接线（`test/e2e/desktop/24-profile-rules.e2e.ts`）
[前置条件] 使用全新的 `$E2E_HOME/home/.dsh.dev`（§5.3），`profiles/` 下不存在 `tauri` 与 `safe`
[测试数据] 名称 `tauri`、`safe`；克隆对话框显式名 `Web`
[测试步骤] 1. 用 `tauri` 创建。2. 用 `safe` 创建。3. 在克隆对话框用显式名 `Web` 克隆任一档案。
[预期结果] 1. 创建成功——`create` 不拦截引导档案名。2. 创建成功——`create` 不拦截安全档案名。3. 返回 `PROFILE_RESERVED`：`clone_with_root` 对显式名套用同一套五项校验。
[清理] 删除本用例新建的两个档案目录

---

## 4. 初始化形态与幂等

### [P1] 验证新档案落盘为四个文件且形态固定

[Case ID] TC-DSK-L3-202
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/profile/mod.rs:879`、`:707`、`:888`
[自动化] 待接线（`test/e2e/desktop/24-profile-rules.e2e.ts`）
[前置条件] 配置对话框打开在「档案」面板；`profiles/init-check` 不存在
[测试数据] 名称 `init-check`
[测试步骤] 1. 新建档案 `init-check`。2. 读取该档案目录下的文件清单。3. 读取 `package.json` 的 `name`/`private`/`dependencies`/`dsh.profile.bundles`。4. 读取 `cordis.patch.yml`、`pnpm-workspace.yaml`、`.npmrc`。
[预期结果] 1. 创建成功。2. 目录下恰含 `package.json`、`cordis.patch.yml`、`pnpm-workspace.yaml`、`.npmrc`。3. `name` 为 `dsh-profile-init-check`；`private` 为 `true`；`dependencies` 为空对象；`dsh.profile.bundles` 为 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`。4. `cordis.patch.yml` 为 3 行注释加 `[]`；`pnpm-workspace.yaml` 含 `packages`、`nodeLinker: hoisted`、`autoInstallPeers: false`、`minimumReleaseAgeExclude: zod@4.4.3`；`.npmrc` 含 `confirmModulesPurge=false`。
[清理] 删除档案目录；`DELETE /session/<id>`

### [P2] 验证重复初始化幂等且不覆盖用户编辑

[Case ID] TC-DSK-L3-203
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/profile/mod.rs:879`、`:888`
[自动化] 待接线（`test/e2e/desktop/24-profile-rules.e2e.ts`）
[前置条件] 存在一个已初始化的档案；可触发一次初始化（启动链路或插件操作链路）
[测试数据] 手工改写后的 `cordis.patch.yml`、`pnpm-workspace.yaml`、`package.json`
[测试步骤] 1. 改写该档案的 `cordis.patch.yml`、`pnpm-workspace.yaml` 与 `package.json`。2. 触发一次档案初始化。3. 复查三个文件内容。
[预期结果] 1. 改写成功。2. 初始化成功返回。3. 三个文件与改写值逐字一致：`package.json` 仅在缺失时写入，patch 与 workspace 由 `!exists()` 守卫，均不覆盖。
[清理] 恢复改写的档案内容或删除档案目录

### [P2] 验证半初始化目录被补齐核心层，不可写目录在预检阶段报错

[Case ID] TC-DSK-L3-204
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/profile/mod.rs:884`、`:732`、`:879`
[自动化] 待接线（`test/e2e/desktop/24-profile-rules.e2e.ts`）
[前置条件] 可手工构造档案目录；可调整目录属主/权限
[测试数据] 仅含 `@deepseek-ai/dsh-base` 的 `package.json` 的目录；无 `package.json` 的目录；当前用户不可写的目录
[测试步骤] 1. 构造只有 `dsh-base` 的档案目录并触发初始化，读取 `dsh.profile.bundles`。2. 构造无 `package.json` 的目录并触发初始化，读取目录内容。3. 构造当前用户不可写的目录并触发初始化。
[预期结果] 1. 核心 web 层被前插补回（`dsh-base` → `dsh-web-app` 顺序），既有插件条目不被删除。2. 按 web 模板写入 `package.json`，并补齐其余三个文件。3. 在建目录与写清单之前返回含 `PROFILE_MKDIR` 的错误——写权限预检先于落盘。
[清理] 删除构造的目录；恢复目录属主与权限

---

## 5. 隔离性与回退

### [P1] 验证各档案独立持有元数据与依赖目录

[Case ID] TC-DSK-L3-205
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/profile/mod.rs:99`；`src-tauri/src/service/plugin/installed.rs:37`
[自动化] 待接线（`test/e2e/desktop/24-profile-rules.e2e.ts`）
[前置条件] 配置对话框打开在「档案」面板；网络或本地包源可用
[测试数据] 档案 `iso-a`、`iso-b`；同一个插件包
[测试步骤] 1. 新建 `iso-a` 与 `iso-b`。2. 在 `iso-a` 下安装该插件后读取两个档案的 `package.json` 与 `node_modules`。3. 在 `iso-a` 为活动档案时记录插件操作解析到的目录，切到 `iso-b` 后重复。
[预期结果] 1. 两个档案目录均创建成功。2. 依赖条目只出现在 `iso-a` 的 `package.json` 与 `node_modules` 中，`iso-b` 不受影响。3. 解析目录分别为 `$E2E_HOME/home/.dsh.dev/profiles/iso-a` 与 `.../profiles/iso-b`，由 `active_profile` 决定。
[清理] 删除两个档案目录；`DELETE /session/<id>`

### [P2] 验证活动档案回退与删除守卫的错误码

[Case ID] TC-DSK-L3-206
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/profile/mod.rs:211`、`:337`、`:532`
[自动化] 待接线（`test/e2e/desktop/24-profile-rules.e2e.ts`）
[前置条件] 记录当前 `active_profile` 原值；存在一个活动档案
[测试数据] store 中 `active_profile` 置为 空串 / `web` / 不存在的 `ghost`
[测试步骤] 1. 把 `active_profile` 置为空串后读取活动档案。2. 置为 `web` 后读取。3. 置为 `ghost` 后读取，并调用 `set_active_profile('ghost')`。4. 分别对 `web` 与当前活动档案请求删除。
[预期结果] 1. 活动档案回退为 `web`。2. 仍回退为 `web`。3. 读取回退为 `web`；`set_active_profile('ghost')` 返回 `PROFILE_NOT_FOUND: profile ghost does not exist`。4. `web` 返回 `PROFILE_DEFAULT_NOT_REMOVABLE`；活动档案返回 `PROFILE_ACTIVE_NOT_REMOVABLE`，两者目录均保留。
[清理] 恢复 `active_profile` 原值；`DELETE /session/<id>`

### [P3] [反向] 验证 home 层补丁跨档案生效

[Case ID] TC-DSK-L3-207
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/bridge/lifecycle.rs:349`
[自动化] 待接线（`test/e2e/desktop/24-profile-rules.e2e.ts`）
[前置条件] 存在两个可用档案；`$E2E_HOME/home/.dsh.dev/cordis.patch.yml` 可写且已备份（§5.3）
[测试数据] home 层 `$E2E_HOME/home/.dsh.dev/cordis.patch.yml` 中一条可解析的补丁条目
[测试步骤] 1. 在 `$E2E_HOME/home/.dsh.dev/cordis.patch.yml` 写入一条可解析补丁条目。2. 在普通档案下启动服务并确认该条目生效。3. 切到安全档案 `safe` 后启动服务并确认该条目是否生效。
[预期结果] 1. 写入成功。2. 普通档案的服务反映该 home 层条目。3. 安全档案同样反映该条目——home 层作用于所有档案，安全档案不是隔离边界。
[清理] 还原 `$E2E_HOME/home/.dsh.dev/cordis.patch.yml`；切回原档案并重启；`DELETE /session/<id>`

---

## 6. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 名称规范化 | 196、197 | 正向 / 边界 | 展示名推导（`mod.rs:224`）未覆盖 |
| 校验顺序与错误码 | 198、199、200、201 | 异常 / 边界 / 低频 | 落盘类错误（`PROFILE_MANIFEST_PARSE_FAILED`、`PROFILE_MANIFEST_READ_FAILED`）未覆盖 |
| 初始化形态与幂等 | 202、203、204 | 正向 / 边界 / 异常 | 非 web 表面档案（headless/acp/sdk）刻意不被改写，未覆盖 |
| 隔离面 | 205、207 | 正向 / 边界 | 「完整隔离」被 home 层打破，见 207 |
| 回退与删除守卫 | 206 | 异常 | 删除不存在的档案与 `PROFILE_REMOVE_FAILED` 未覆盖 |
| 列表形态 | — | — | 跳过点目录与 `node_modules`、`web` 合成行、默认优先排序（`mod.rs:254`、`:283`）**未覆盖** |

---

## 7. 缺口与假设

- **G-D24-1**：本文件全部用例经命令层（`create_profile` / `set_active_profile` / `get_profiles` / 克隆）与磁盘状态断言；界面呈现与提示文案归 `05-profile.md`，不重复断言。
- **G-D24-2**：`create` 不拦截 `tauri`（`mod.rs:51`）与 `safe`（`mod.rs:59`），用户可占用引导与安全档案名。被占用后引导流程与安全模式的实际行为未验证，属已知边界。
- **G-D24-3**：TC-DSK-L3-205 的「插件操作解析到哪个目录」当前无只读出口，接线时需借安装产物或日志间接断言。
- **G-D24-4**：列表的展示名（`mod.rs:224`、`:1104`）、跳过点目录与 `node_modules`、`web` 目录缺失时的合成行、默认优先排序（`mod.rs:254`、`:283`）不在本文件 12 个 Case 内。
- **G-D24-5**：TC-DSK-L3-204 需构造不可写目录（改属主/权限），Windows 上需管理员；接线时按平台选择可用手段。
- **假设**：本文件全部路径均在 `$E2E_HOME` 之下（`00-overview.md` §5.3）。文中 `$DSH_HOME/profiles/<id>` 指 `$E2E_HOME/home/.dsh.dev/profiles/<id>`（debug）。**不得**依赖设置 `DSH_HOME` 来隔离——debug 构建恒用 `<home>/.dsh.dev` 并忽略 `DSH_HOME`（`src-tauri/src/config/runtime.rs:471-485`），隔离只能靠重定向 `USERPROFILE`/`HOME`；`web`、`tauri`、`safe` 档案不得由用例创建或删除。
- **G-D24-6**：本文件是**破坏性最强**的一批用例（新建/删除档案、改写 home 层补丁）。所有用例必须在重定向后的 `$E2E_HOME/home/.dsh.dev` 内运行；在脚手架实现 §5.3 的重定向与失败关闭校验之前**不得执行**。
