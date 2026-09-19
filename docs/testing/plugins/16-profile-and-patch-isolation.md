# 档案隔离与补丁层治理

> 层级：L3 桌面端宿主 E2E（真实 Tauri 窗口）；部分断言可在 L2 完成
> 自动化：`test/e2e/plugins/profile-plugin-isolation.e2e.ts`（待接线，见 `00-overview.md` G4）
> 前置：应用已启动；可创建/切换 scratch 档案；补丁层可写
> 运行：待接线（`desktop` project 未配置，见 `00-overview.md` G4）

本文件补齐归档套件里**跨档案**与**档案内补丁治理**的一整块：`05-profile/05-档案隔离性`（插件与补丁互不影响）、`06-plugin/03` 的 pnpm-workspace 归一化、`01-install/05` 的数据目录可写性诊断。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 默认档案 `web`、桌面档案 `tauri`、安全档案 `safe`、旧名 `desktop` | `src-tauri/src/service/profile/mod.rs:42`、`src-tauri/src/service/profile/mod.rs:51`、`src-tauri/src/service/profile/mod.rs:59`、`src-tauri/src/service/profile/mod.rs:54` |
| 档案目录定位 | `src-tauri/src/service/profile/mod.rs:99` |
| pnpm-workspace 解析（返回是否需要归一化） | `src-tauri/src/service/profile/mod.rs:123` |
| 归一化触发与日志 `PROFILE_WORKSPACE_MULTI_DOCUMENT` | `src-tauri/src/service/profile/mod.rs:164`、`src-tauri/src/service/profile/mod.rs:168` |
| 非法 YAML 拒绝 `PROFILE_WORKSPACE_INVALID_YAML` | `src-tauri/src/service/profile/mod.rs:165` |
| 档案补丁模板（顶层 YAML 数组） | `src-tauri/src/service/profile/mod.rs:78` |
| 活动档案读写 | `src-tauri/src/service/profile/mod.rs:211`、`src-tauri/src/service/profile/mod.rs:337` |
| 档案创建 / 克隆 / 删除 | `src-tauri/src/service/profile/mod.rs:308`、`src-tauri/src/service/profile/mod.rs:562`、`src-tauri/src/service/profile/mod.rs:532` |
| 启动编排顺序：npmrc → 弃用卸载 → 内置自愈 → 预设补齐 | `src-tauri/src/service/workflow/launch.rs:461`、`src-tauri/src/service/workflow/launch.rs:467`、`src-tauri/src/service/workflow/launch.rs:474`、`src-tauri/src/service/workflow/launch.rs:482` |
| 可写性预检 `PROFILE_NOT_WRITABLE` | `src-tauri/src/service/perm.rs:235`、`src-tauri/src/service/workflow/launch.rs:371`、`src-tauri/src/service/plugin/internal/mod.rs:260` |
| `dsh.profile.bundles` 读点 | `src-tauri/src/service/plugin/installed.rs:44`、`src-tauri/src/service/plugin/watch.rs:146` |
| `dsh.profile.bundles` 写点 | `src-tauri/src/service/plugin/disable.rs:196`、`src-tauri/src/service/plugin/recovery/uninstall.rs:13`、`src-tauri/src/service/plugin/snapshot.rs:537`、`src-tauri/src/service/plugin/internal/materialize.rs:107`、`src-tauri/src/service/profile/mod.rs:732` |
| 档案内文件清单（package.json / pnpm-workspace.yaml / .npmrc / cordis.yml / cordis.patch.yml / disabled-plugins.json / pnpm-lock.yaml / node_modules） | `src-tauri/src/service/profile/mod.rs:81`、`src-tauri/src/service/workflow/launch.rs:461` |

---

## 2. 用例

### [P1] 验证两个档案的插件互不影响

[Case ID] TC-ISO-L3-001
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/profile/mod.rs:99`、`src-tauri/src/service/plugin/installed.rs:44`
[自动化] 待接线（`desktop` project 未配置）
[前置条件] 存在两个 scratch 档案 `alpha`、`beta`，均未装额外插件
[测试数据] 向 `alpha` 安装插件 A（`link:` 指向仓库内某插件），向 `beta` 安装插件 B（另一个插件）
[测试步骤] 1. 分别在两个档案下安装并记录各自 `dependencies` 与 `dsh.profile.bundles`。2. 切到 `alpha` 读清单。3. 切到 `beta` 读清单。
[预期结果] 1. `alpha` 的 `dependencies` 只含 A，`beta` 只含 B。2. 两次读到的清单互不混入对方插件。3. 两个档案的 `node_modules` 各自独立（互不包含对方插件目录）。
[清理] 删除两个档案

### [P1] 验证两个档案的补丁层互不串扰

[Case ID] TC-ISO-L3-002
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/profile/mod.rs:78`
[自动化] 待接线（同上）
[前置条件] 存在两个 scratch 档案
[测试数据] 向 `alpha` 的 `cordis.patch.yml` 写入条目 A，向 `beta` 的写入条目 B（两者都是合法 YAML 数组）
[测试步骤] 1. 分别写入后启动一次服务。2. 分别读取两个补丁文件的内容与服务日志。
[预期结果] 1. 两个文件内容互不相同且各自保留自己的条目。2. 服务启动日志中不出现 `alpha` 的条目在 `beta` 档案下生效的痕迹。3. 未出现 `PATCH_LAYER_*` 错误码。
[清理] 恢复补丁文件；删除档案

### [P2] 验证切换档案后服务以新档案启动且旧档案数据保留

[Case ID] TC-ISO-L3-003
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/profile/mod.rs:337`、`src-tauri/src/service/workflow/launch.rs:461`
[自动化] 待接线（同上）
[前置条件] 两个 scratch 档案均已各自安装不同插件
[测试数据] 无
[测试步骤] 1. 记录 `alpha` 的插件与目录摘要。2. 切换到 `beta` 并等待服务 Running。3. 复查 `alpha` 的目录与文件。
[预期结果] 1. 活动档案变为 `beta`。2. 服务以 `beta` 档案启动（其插件被加载）。3. `alpha` 的 `package.json`、`cordis.patch.yml`、`node_modules` 内容未变化。
[清理] 切回原档案；删除测试档案

### [P4] 验证删除档案不影响其他档案

[Case ID] TC-ISO-L3-004
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/profile/mod.rs:532`
[自动化] 待接线（同上）
[前置条件] 存在 `alpha`、`beta`、`gamma` 三个 scratch 档案
[测试数据] 无
[测试步骤] 1. 删除 `beta`。2. 读档案列表。3. 抽查 `gamma` 的插件依赖与补丁文件。
[预期结果] 1. 列表中不再有 `beta`。2. `alpha` 与 `gamma` 仍在列表中。3. `gamma` 的文件内容未被改动。
[清理] 删除测试档案

### [P1] 验证 pnpm-workspace 多文档被归一化为单文档

[Case ID] TC-ISO-L3-005
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/profile/mod.rs:123`、`src-tauri/src/service/profile/mod.rs:168`
[自动化] 待接线（同上）
[前置条件] 活动档案的 `pnpm-workspace.yaml` 被拼成两个 YAML 文档（`packages:` 段后跟 `---` 再跟 `autoInstallPeers: false`）
[测试数据] 上述双文档内容
[测试步骤] 1. 写入双文档内容。2. 触发一次档案策略检查/服务启动。3. 读回文件内容与日志。
[预期结果] 1. 文件被写回**单个** YAML 文档。2. 日志出现 `PROFILE_WORKSPACE_MULTI_DOCUMENT: normalized <路径> to a single YAML document`。3. 同名键按后者覆盖合并（`packages` / `nodeLinker` / `autoInstallPeers` 均保留）。4. 服务继续启动，不再出现 pnpm 的 `expected a single document in the stream, but found more`。
[清理] 恢复文件

### [P3] [反向] 验证非法 YAML 被拒绝且不做带病归一化

[Case ID] TC-ISO-L3-006
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/profile/mod.rs:165`
[自动化] 待接线（同上）
[前置条件] 构造**真语法错误**的 `pnpm-workspace.yaml`（如重复映射键），而非多文档
[测试数据] 非法 YAML 内容
[测试步骤] 1. 写入非法内容。2. 触发档案策略检查。3. 读错误与文件内容。
[预期结果] 1. 返回错误，前缀为 `PROFILE_WORKSPACE_INVALID_YAML: <路径>: <解析错误>`。2. 文件未被改写（不做「尽力归一化」）。3. 应用给出可操作提示而非静默继续。
[清理] 恢复文件

### [P3] [反向] 验证档案目录不可写时在写入前给出诊断

[Case ID] TC-ISO-L3-007
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/perm.rs:235`、`src-tauri/src/service/workflow/launch.rs:371`
[自动化] 否（手工；需修改目录属主/只读属性）
[前置条件] 目标档案目录可读不可写（Windows 上设置只读或拒绝写入 ACL；类 Unix 上改属主）
[测试数据] 只读档案目录
[测试步骤] 1. 触发服务启动。2. 读错误文案。3. 检查目录与进程状态。
[预期结果] 1. 返回 `PROFILE_NOT_WRITABLE: <路径> 不可写（...）`，并附可执行的修复指引。2. `dsh` 进程**未**被拉起（不在写入失败后才崩）。3. 失败发生在写入前，目录内容未被部分改写。
[清理] 恢复目录权限

### [P2] 验证档案内 `disabled-plugins.json` 只影响本档案

[Case ID] TC-ISO-L3-008
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/disable.rs:302`、`src-tauri/src/service/plugin/watch.rs:601`
[自动化] 待接线（同上）
[前置条件] `alpha` 与 `beta` 都装有同一插件
[测试数据] 该插件 id
[测试步骤] 1. 在 `alpha` 下禁用该插件。2. 切到 `beta` 读清单该行状态。3. 读两个档案的 `disabled-plugins.json`。
[预期结果] 1. `alpha` 的清单该行显示「已禁用」，其 `dsh.profile.bundles` 不含该 id。2. `beta` 的清单该行**不**显示禁用，bundles 仍含该 id。3. `beta` 目录下不存在该禁用记录（或为空文件）。
[清理] 恢复 `alpha` 的启用态；删除测试档案

---

## 3. 追踪矩阵

| 来源（归档套件） | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `05-profile/05` 验证不同档案安装的插件互不影响 | TC-ISO-L3-001 | 正向 | — |
| `05-profile/05` 验证不同档案的补丁设定各自独立 | TC-ISO-L3-002 | 正向 | — |
| `05-profile/05` 验证切换档案后服务以新档案启动且旧档案数据完整保留 | TC-ISO-L3-003 | 正向 | 档案切换本身由 `../desktop/05-profile.md` 覆盖 |
| `05-profile/05` 验证删除档案 A 不影响其他档案 | TC-ISO-L3-004 | 边界 | — |
| `06-plugin/03` 验证 pnpm-workspace.yaml 多文档被归一化并恢复插件安装 | TC-ISO-L3-005、TC-ISO-L3-006 | 正向 / 异常 | — |
| `01-install/05` 验证数据目录不可写时在写入前给出可执行权限诊断 | TC-ISO-L3-007 | 异常 | 系统权限无法在页面内构造，标为手工 |
| 现行实现新增（禁用清单的档案局部性） | TC-ISO-L3-008 | 正向 | 归档套件未覆盖 |

---

## 4. 缺口与假设

- **G-ISO-1**：TC-ISO-L3-007 需要修改文件系统权限，无法由页面内测试自足完成，按 `desktop.test.md` 的规定标为 `[自动化] 否（手工）`，并在执行记录中附上目录属主信息。
- **G-ISO-2**：`PROFILE_WORKSPACE_MULTI_DOCUMENT` 的归一化由档案策略检查触发（`src-tauri/src/service/profile/mod.rs:154`），当前由服务启动链调用（`src-tauri/src/service/workflow/launch.rs:461`）。用例以「启动一次服务」作为触发方式，若后续出现更直接的命令入口，应改用它。
- **G-ISO-3**：本文件的三档案用例要求测试代理只在 `<DSH_E2E_HOME>/home/.dsh.dev/profiles/` 下创建 `alpha`/`beta`/`gamma`，禁止触碰 `web` 与 `tauri`。违反此约束会污染开发环境（`desktop.test.md` §6）。
- **假设**：`dsh.profile.bundles` 是插件加载的唯一开关（除 `disabled-plugins.json` 与 patch 覆盖），因此「档案 A 的插件不影响档案 B」等价于「两份 `package.json` + 两套 `node_modules` 相互独立」。
