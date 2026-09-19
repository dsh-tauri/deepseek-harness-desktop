# 插件清单与文件监控

> 层级：L3 桌面端宿主 E2E（真实 Tauri 窗口）
> 自动化：`test/e2e/plugins/plugin-inventory.e2e.ts`（待接线，见 `00-overview.md` G4）
> 前置：应用已启动；配置对话框可打开在「插件」面板；`<DSH_E2E_HOME>/home/.dsh.dev` 可写
> 运行：待接线（`desktop` project 未配置，见 `00-overview.md` G4）

**与桌面端套件的分工**：`../desktop/09-plugin-panel.md` 断言「界面上看到什么」；本文件断言**清单真值从哪来、文件改了会怎样、坏数据如何降级**——即落盘与事件层。两者共同覆盖归档套件 `06-plugin/01-已安装插件列表与监控` 的 5 条用例。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 清单解析入口：由 profile 目录 + 预设清单推导 | `src-tauri/src/service/plugin/watch.rs:136` |
| 插件元信息读取失败返回 `None`（不抛错） | `src-tauri/src/service/plugin/watch.rs:127` |
| 插件目录定位 `plugin_dir(profile, id)` | `src-tauri/src/service/plugin/watch.rs:106` |
| 事件名 `dsh-plugins-updated` | `src-tauri/src/service/plugin/watch.rs:26` |
| 指纹防抖窗口 2s | `src-tauri/src/service/plugin/watch.rs:30` |
| 指纹计算 / 变化检测 / 推送 | `src-tauri/src/service/plugin/watch.rs:283`、`src-tauri/src/service/plugin/watch.rs:320`、`src-tauri/src/service/plugin/watch.rs:351` |
| 错误合并：已恢复的 install 错误不再暴露 | `src-tauri/src/service/plugin/watch.rs:230` |
| 强制推送（写操作后） | `src-tauri/src/service/plugin/watch.rs:258` |
| 清单命令 `get_dsh_plugins`（非 `Result`） | `src-tauri/src/bridge/plugin.rs:127` |
| 直接依赖读取与 bundles 读取 | `src-tauri/src/service/plugin/installed.rs:44` |
| 行为契约（单测已固化）：直接依赖、bundled 优先、内置标记、禁用 vs 未加载、配置覆盖禁用、包名别名 patch 禁用、无 manifest 为空 | `src-tauri/src/service/plugin/watch.rs:416`、`src-tauri/src/service/plugin/watch.rs:451`、`src-tauri/src/service/plugin/watch.rs:472`、`src-tauri/src/service/plugin/watch.rs:601`、`src-tauri/src/service/plugin/watch.rs:656`、`src-tauri/src/service/plugin/watch.rs:688`、`src-tauri/src/service/plugin/watch.rs:588` |
| 禁用/未加载/配置覆盖禁用的判定字段 | `src-tauri/src/service/plugin/disable.rs:274`、`src-tauri/src/service/plugin/disable.rs:342` |

---

## 2. 用例

### [P1] 验证清单只列直接依赖并排除传递依赖

[Case ID] TC-INV-L3-001
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/watch.rs:136`、`src-tauri/src/service/plugin/watch.rs:416`
[自动化] 待接线（`desktop` project 未配置）
[前置条件] 活动档案 `web`；该档案已装至少 2 个插件，且其 `node_modules` 内存在传递依赖
[测试数据] 读取 `<DSH_HOME>/profiles/web/package.json` 的 `dependencies` 键集合
[测试步骤] 1. 打开插件面板，读取 `get_dsh_plugins` 返回的 id 集合。2. 与 `dependencies` 键集合求差集。3. 在 `node_modules` 下任选一个传递依赖包名，确认其不在清单中。
[预期结果] 1. 清单 id 集合是 `dependencies` 键集合的子集。2. 传递依赖名不出现在清单中。3. 清单长度 ≥ 1。
[清理] 不改动档案；关闭设置面板

### [P2] 验证内置与预设插件被标记并优先排序

[Case ID] TC-INV-L3-002
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/watch.rs:451`、`src-tauri/src/service/plugin/watch.rs:472`
[自动化] 待接线（同上）
[前置条件] 内置插件已随应用装配（`src-tauri/resources/internal-plugins.json` 的 10 条）
[测试数据] 无
[测试步骤] 1. 读清单。2. 找出全部内置 id（与 `internal-plugins.json` 的 `id` 比对）。3. 记录首个非内置项的下标。
[预期结果] 1. 每个内置项都带「内置」标记。2. 全部内置项排在非内置项之前（bundled 优先）。3. 已装插件参与排序，未装插件不出现在清单中。
[清理] 关闭设置面板

### [P4] [反向] 验证插件自身 package.json 缺失或损坏时仍列出该插件

[Case ID] TC-INV-L3-003
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/plugin/watch.rs:127`、`src-tauri/src/service/plugin/watch.rs:451`
[自动化] 待接线（同上）
[前置条件] 活动档案 `dependencies` 含某插件，但其 `node_modules/<id>/package.json` 被临时改名为 `.bak` 或写成非法 JSON
[测试数据] 目标插件 id（选一个非内置、不影响壳层的插件）
[测试步骤] 1. 破坏该插件的 `package.json`。2. 触发一次面板刷新（关闭再打开）。3. 读该行的名称与版本字段。
[预期结果] 1. 清单不整体失败，其他插件仍在。2. 该插件仍出现在清单中。3. 版本为空字符串，名称回落为预设 `name` 或依赖键。
[清理] 恢复 `package.json`；再次刷新确认版本回填

### [P2] 验证 profile 依赖变化在防抖窗口后触发一次清单事件

[Case ID] TC-INV-L3-004
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/watch.rs:26`、`src-tauri/src/service/plugin/watch.rs:30`、`src-tauri/src/service/plugin/watch.rs:351`
[自动化] 待接线（同上）
[前置条件] 应用运行中；插件面板已打开；记录当前清单长度
[测试数据] 手工编辑 `<DSH_HOME>/profiles/web/package.json`：向 `dependencies` 写入仓库内的一个测试包（`link:` 指向 `packages/dsh-tauri-pet`）
[测试步骤] 1. 写入后开始计时。2. 监听 `dsh-plugins-updated` 事件并记录 payload 长度。3. 读界面清单长度。
[预期结果] 1. 事件在约 2s 后到达（不早于防抖窗口、不超过 10s）。2. payload 长度比基线多 1。3. 界面清单同步新增该插件。
[清理] 从 `dependencies` 与 `dsh.profile.bundles` 移除测试项并删除链接目录；确认清单回到基线

### [P4] 验证防抖窗口内的连续写盘只推送一次

[Case ID] TC-INV-L3-005
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/plugin/watch.rs:30`
[自动化] 待接线（同上）
[前置条件] 同 TC-INV-L3-004
[测试数据] 在 1s 内连续 3 次改写 `dependencies`（最终态与首次态不同）
[测试步骤] 1. 连续写入 3 次。2. 统计 10s 内收到的 `dsh-plugins-updated` 次数。3. 读最后一次 payload。
[预期结果] 1. 事件次数为 1（合并为最终态）。2. 最后一次 payload 反映第 3 次写入的结果。
[清理] 恢复 profile 清单并确认事件收敛

### [P3] 验证无 profile manifest 时清单为空且界面显示空态

[Case ID] TC-INV-L3-006
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/plugin/watch.rs:588`
[自动化] 待接线（同上）
[前置条件] 活动档案目录存在但 `package.json` 被临时移走（模拟档案被破坏）
[测试数据] 无
[测试步骤] 1. 移走 manifest。2. 刷新面板。3. 读清单与界面状态。
[预期结果] 1. `get_dsh_plugins` 返回空数组且不抛错。2. 界面显示空态而非错误态。3. 应用其余部分可用（不崩溃）。
[清理] 恢复 manifest；刷新确认清单回填

### [P3] 验证禁用与「已在 bundles 外」两种状态可区分

[Case ID] TC-INV-L3-007
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/plugin/watch.rs:601`、`src-tauri/src/service/plugin/disable.rs:302`
[自动化] 待接线（同上）
[前置条件] 已有一项被桌面端禁用（`disabled-plugins.json` 含其 id 且已从 `dsh.profile.bundles` 摘除）
[测试数据] 该插件 id
[测试步骤] 1. 读该行的两个标记字段（禁用标记 / 内置标记）。2. 手工把另一个插件从 `bundles` 摘除但不写 `disabled-plugins.json`。3. 再次读清单。
[预期结果] 1. 第一种状态显示「已禁用」标记。2. 第二种状态**不**显示「已禁用」标记（仅表示未在 bundles 中）。3. 两者都仍出现在清单里（仍在 `dependencies`）。
[清理] 复原 bundles 与禁用清单

### [P4] 验证带包名别名的补丁禁用仍被正确标记

[Case ID] TC-INV-L3-008
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/plugin/watch.rs:688`
[自动化] 待接线（同上）
[前置条件] 档案 `cordis.patch.yml` 中存在按**包名**（而非 id）禁用某插件的条目
[测试数据] 目标插件 id 与对应包名
[测试步骤] 1. 写入按包名禁用的 patch。2. 刷新面板。3. 读该行的 patch 禁用标记。
[预期结果] 1. 该行显示「补丁禁用」标记。2. 该标记与桌面端「已禁用」标记互斥显示或同时显示但语义可区分（以 `watch.rs:688` 的判据为准）。
[清理] 移除该 patch 条目

---

## 3. 追踪矩阵

| 来源（归档套件） | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `06-plugin/01` 验证已安装插件列表只读且正确展示 | TC-INV-L3-001 | 正向 | 只读性（无编辑控件）由 `../desktop/09-plugin-panel.md` 断言 |
| `06-plugin/01` 验证列表展示插件名与版本等关键信息 | TC-INV-L3-002、TC-INV-L3-003 | 正向 / 边界 | — |
| `06-plugin/01` 验证插件文件变化后轮询检测并推送 dsh-plugins-updated 事件 | TC-INV-L3-004、TC-INV-L3-005 | 正向 / 边界 | — |
| `06-plugin/01` 验证插件被移除后列表能反应 | TC-LIFE-L3-007（见 `13-plugin-lifecycle-commands.md`） | 正向 | 卸载副作用归 14 |
| `06-plugin/01` 验证插件自身 package.json 缺失或损坏时列表仍展示该插件 | TC-INV-L3-003 | 边界 | — |
| 现行实现新增（禁用 vs 未加载、包名别名 patch 禁用） | TC-INV-L3-007、TC-INV-L3-008 | 正向 / 边界 | 归档套件无对应用例 |
| 无 manifest 降级 | TC-INV-L3-006 | 异常 | 归档套件无对应用例 |

---

## 4. 缺口与假设

- **G-INV-1**：清单真值的稳定断言依赖「`dependencies` 里恰好只有插件」这一前提。若用户档案里混入非插件依赖，TC-INV-L3-001 的差异比较需加入白名单，届时以 `internal-plugins.json` / `preset-plugins.json` 的 id 集合为基准。
- **G-INV-2**：事件监听能力在页面内不可直接订阅 Tauri 事件（iframe 只能 `dsh://tauri:invoke` 白名单内的 9 条命令，见 `00-overview.md` §5.2）。TC-INV-L3-004/005 需由壳层测试侧记录事件计数后再经 DOM 或测试通道回读；接线方式待定。
- **G-INV-3**：`get_dsh_plugins` 声明为非 `Result`，因此「读失败」只能表现为空数组，无法与「真为空」区分（`src-tauri/src/bridge/plugin.rs:127`）。TC-INV-L3-006 以「界面显示空态而非错误态」作为区分代理。
- **假设**：测试代理只改 `<DSH_E2E_HOME>/home/.dsh.dev` 下的 scratch 档案，不触碰用户 `~/.dsh`（`desktop.test.md` §6）。
