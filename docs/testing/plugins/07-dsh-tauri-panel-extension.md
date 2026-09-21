# dsh-tauri-panel-extension：扩展管理面板（技能 / MCP / 市场）

> 层级：L2 插件宿主 E2E → L3 桌面端宿主 E2E
> 自动化：`test/e2e/plugins/extension-routes.e2e.ts`（待建立）；客户端与 L3 见各用例标注
> 前置：`pnpm build:plugins`；网络用例（预设/MCP 探测）另需注明
> 运行：L2 `pnpm test:e2e:plugin`；L3 见 `00-overview.md` §5.2

这是**路由面最大的插件**（19 个 path+method 项），也是桌面端「扩展管理」的唯一实现方。本文件按「只读 → 缺参 → 领域拒绝 → 面板呈现」渐进覆盖，不触碰会真实改动用户配置的写入分支。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| `PLUGIN_ID = 'dsh-tauri-panel-extension'` | `packages/dsh-tauri-panel-extension/src/shared/constants.ts:1` |
| 19 个 path+method 项声明 | `packages/dsh-tauri-panel-extension/src/host/routes/index.ts:24` |
| 技能清单 `GET /skills`；刷新 `POST /skills/refresh` | `packages/dsh-tauri-panel-extension/src/host/routes/skills/get.ts:6`、`packages/dsh-tauri-panel-extension/src/host/routes/skills/refresh/post.ts:6` |
| 技能详情 404 `skill not found` | `packages/dsh-tauri-panel-extension/src/host/routes/skill/get.ts:6` |
| 只读来源保存 → 403 | `packages/dsh-tauri-panel-extension/src/host/routes/skill/post.ts:29` |
| 运行期注册技能改策略 → 422 | `packages/dsh-tauri-panel-extension/src/host/routes/skill/policy/post.ts:6` |
| `open/dir` 的 `target` 白名单 `user-skills｜plugin-state｜skill｜root` | `packages/dsh-tauri-panel-extension/src/host/routes/open/dir/post.ts:13` |
| MCP：`GET/POST/DELETE /mcp`、`/mcp/toggle`、`/mcp/check`、`/mcp/copy` | `packages/dsh-tauri-panel-extension/src/host/routes/index.ts:37` |
| MCP 列表恒带 `restartNeeded: true` | `packages/dsh-tauri-panel-extension/src/host/routes/mcp/get.ts:5` |
| 导入：`GET /import/scan`、`POST /import/apply` | `packages/dsh-tauri-panel-extension/src/host/routes/import/scan/get.ts:6` |
| 技能根：`GET/POST/DELETE /roots` | `packages/dsh-tauri-panel-extension/src/host/routes/roots/get.ts:5` |
| 宿主重启：403 `untrusted origin`、409 由壳层接管 | `packages/dsh-tauri-panel-extension/src/host/routes/host/restart/post.ts:18`、`packages/dsh-tauri-panel-extension/src/host/routes/host/restart/post.ts:24` |
| 面板：`definePanel` order 20，落 `sidebar.panellist` + `main` | `packages/dsh-tauri-panel-extension/src/client/register/extension-panel.tsx:44` |
| 面板归属：仅桌面 iframe 收编市场（`hostsMarketPanel` / `currentScope`） | `packages/dsh-tauri-panel-extension/src/client/service/market.ts:42`、`packages/dsh-tauri-panel-extension/src/client/service/market.ts:47` |
| 市场设置页入口：收编时撤下，撤下前记住原状态，服务撤下或插件卸载时还原 | `packages/dsh-tauri-panel-extension/src/client/register/extension-panel.tsx:18` |
| 标签页 market / skills / mcp，`role="tab"` + `aria-selected` | `packages/dsh-tauri-panel-extension/src/client/components/extension-panel.tsx:30`、`packages/dsh-tauri-panel-extension/src/client/components/extension-panel.tsx:54` |
| 输入区预填槽位 `conversation.input.left`（id `.skill-prefill`） | `packages/dsh-tauri-panel-extension/src/client/constants/index.ts:10` |

---

## 2. L2：宿主路由

### [P1] 验证技能清单在无技能时返回空数组

[Case ID] TC-EXT-L2-07-001
[层级] L2（真实 dsh 进程）
[类型] 正向
[追踪] `packages/dsh-tauri-panel-extension/src/host/routes/skills/get.ts:6`
[自动化] 是（`test/e2e/plugins/extension-routes.e2e.ts`）
[前置条件] scratch `DSH_HOME` 全新（无用户技能、无仓库根）
[测试数据] `GET /api/desktop/dsh-tauri-panel-extension/skills`
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 200。2. 响应体含 `skills` 数组字段（允许为空）。3. 不存在 `error` 字段。
[清理] 无

### [P3] [反向] 验证查询不存在的技能返回 404

[Case ID] TC-EXT-L2-07-002
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-panel-extension/src/host/routes/skill/get.ts:6`
[自动化] 是
[前置条件] 同 TC-EXT-L2-07-001
[测试数据] `GET /skill?name=definitely-missing`
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 404。2. 响应体 `error` 恰为 `skill not found`。
[清理] 无

### [P2] 验证 MCP 列表结构固定且标记需要重启

[Case ID] TC-EXT-L2-07-003
[层级] L2（真实 dsh 进程）
[类型] 正向
[追踪] `packages/dsh-tauri-panel-extension/src/host/routes/mcp/get.ts:5`
[自动化] 是
[前置条件] 同 TC-EXT-L2-07-001
[测试数据] `GET /mcp`
[测试步骤] 1. 发起请求。2. 读状态码与响应体字段。
[预期结果] 1. 状态码 200。2. 响应体含 `servers` 数组与 `restartNeeded: true` 两个字段。
[清理] 无

### [P3] [反向] 验证 MCP 删除缺 id 返回 400

[Case ID] TC-EXT-L2-07-004
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-panel-extension/src/host/routes/mcp/delete.ts:7`
[自动化] 是
[前置条件] 同 TC-EXT-L2-07-001
[测试数据] `DELETE /mcp`，body `{}`
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 400。2. 响应体 `error` 恰为 `id is required`。3. 配置文件未被改写。
[清理] 无

### [P3] [反向] 验证 MCP 切换缺字段返回 400

[Case ID] TC-EXT-L2-07-005
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-panel-extension/src/host/routes/mcp/toggle/post.ts:7`
[自动化] 是
[前置条件] 同 TC-EXT-L2-07-001
[测试数据] `POST /mcp/toggle`，body `{ "id": "x" }`（缺 `disabled`）
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 400。2. 响应体 `error` 恰为 `id and disabled are required`。
[清理] 无

### [P4] [反向] 验证打开目录的未知 target 被拒

[Case ID] TC-EXT-L2-07-006
[层级] L2（真实 dsh 进程）
[类型] 边界
[追踪] `packages/dsh-tauri-panel-extension/src/host/routes/open/dir/post.ts:52`
[自动化] 是
[前置条件] 同 TC-EXT-L2-07-001
[测试数据] `POST /open/dir`，body `{ "target": "unknown-target" }`
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 400。2. 响应体 `error` 恰为 `unknown target`。3. 无系统打开动作。
[清理] 无

### [P4] [反向] 验证技能根创建只接受 local / git

[Case ID] TC-EXT-L2-07-007
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-panel-extension/src/host/routes/roots/post.ts:7`
[自动化] 是
[前置条件] 同 TC-EXT-L2-07-001
[测试数据] `POST /roots`，body `{ "kind": "svn", "path": "/tmp" }`
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 400。2. 响应体 `error` 恰为 `kind must be local or git`。
[清理] 无

### [P3] [反向] 验证宿主重启在本机无来源头时被拒

[Case ID] TC-EXT-L2-07-008
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-panel-extension/src/host/routes/host/restart/post.ts:18`
[自动化] 是
[前置条件] 同 TC-EXT-L2-07-001；请求不携带 `Origin`
[测试数据] `POST /host/restart`
[测试步骤] 1. 发起请求。2. 读状态码与响应体。3. 确认宿主进程未重启（`baseUrl` 仍可用且进程号不变）。
[预期结果] 1. 状态码 403。2. 响应体 `error` 恰为 `untrusted origin`。3. 宿主未重启。
[清理] 无

### [P3] [反向] 验证带转发头的重启请求同样被拒

[Case ID] TC-EXT-L2-07-009
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-panel-extension/src/host/routes/host/restart/post.ts:18`
[自动化] 是
[前置条件] 同 TC-EXT-L2-07-008
[测试数据] 同源 `Origin` + `x-forwarded-for: 10.0.0.1`
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 403。2. 响应体 `error` 恰为 `untrusted origin`（转发头视为不可信）。
[清理] 无

---

## 3. 客户端

### 3.1 L1：纯函数（`unit` project，已接线）

> 回归背景（`#658`）：同一份 profile 也服务普通浏览器标签页。面板无条件收编市场时，浏览器里市场自带的设置页入口被一并撤下，市场只剩「扩展管理 → 市场」一条路径；而面板自身在浏览器里同样注册，于是入口位置被静默改变。面板归属改为与 `dsh-tauri-ui` 的 `im-panel` 同一判据：只有桌面 iframe 接管。

#### [P1] 桌面 iframe 由扩展面板收编市场

[Case ID] TC-EXT-U-07-001
[层级] L1（`unit` project 纯函数）
[类型] 正向
[追踪] `packages/dsh-tauri-panel-extension/src/client/service/market.ts:42`
[自动化] 是（`packages/dsh-tauri-panel-extension/src/client/service/market.test.ts`）
[前置条件] 无（纯函数）
[测试数据] `scope = { parent: {} }`（`parent` 不是自身，即桌面跨域 iframe）
[测试步骤] 1. 调用 `hostsMarketPanel(scope)`。
[预期结果] 1. 返回 `true`：市场收进面板，其设置页重复入口被撤下。
[清理] 无

#### [P1] 独立浏览器标签页不收编市场并保留其设置页入口

[Case ID] TC-EXT-U-07-002
[层级] L1（`unit` project 纯函数）
[类型] 正向
[追踪] `packages/dsh-tauri-panel-extension/src/client/service/market.ts:42`
[自动化] 是（`packages/dsh-tauri-panel-extension/src/client/service/market.test.ts`）
[前置条件] 无（纯函数）
[测试数据] `scope.parent === scope`（顶层窗口）
[测试步骤] 1. 调用 `hostsMarketPanel(scope)`。
[预期结果] 1. 返回 `false`：面板不出「市场」标签页，市场自带的设置页入口保留。
[清理] 无

#### [P3] [反向] 无窗口的非浏览器环境不收编

[Case ID] TC-EXT-U-07-003
[层级] L1（`unit` project 纯函数）
[类型] 边界
[追踪] `packages/dsh-tauri-panel-extension/src/client/service/market.ts:42`、`packages/dsh-tauri-panel-extension/src/client/service/market.ts:47`
[自动化] 是（`packages/dsh-tauri-panel-extension/src/client/service/market.test.ts`）
[前置条件] 无（纯函数）
[测试数据] `scope = undefined`
[测试步骤] 1. 调用 `hostsMarketPanel(undefined)`。
[预期结果] 1. 返回 `false`，且不抛错。
[清理] 无

### 3.2 L2：真实浏览器页面（未接线）

#### [P1] 验证扩展面板渲染并按顺序激活首个标签

[Case ID] TC-EXT-C-07-001
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-panel-extension/src/client/components/extension-panel.tsx:37`
[自动化] 未接线（`00-overview.md` G2）
[前置条件] iframe 内 dsh 界面已加载；`sidebar.panellist` 槽位可用
[测试数据] 无
[测试步骤] 1. 从面板列表打开扩展面板。2. 查询 `.dshp-extension__tabs` 与其中的 `[role="tab"]`。3. 读被激活标签的 `aria-selected`。
[预期结果] 1. tablist 存在。2. 至少包含 `skills` 与 `mcp` 两个标签。3. 恰有一个 `aria-selected="true"`，且为列表中的第一个可见标签。
[清理] 关闭面板

#### [P2] 验证技能页空态与主要入口可见

[Case ID] TC-EXT-C-07-002
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-panel-extension/src/client/components/skills-tab.tsx:195`
[自动化] 未接线（G2）
[前置条件] 无用户技能
[测试数据] 无
[测试步骤] 1. 切到技能标签。2. 查询「打开技能目录」「导入仓库」「新建技能」三个按钮。3. 查询卡片列表容器。
[预期结果] 1. 三个入口均存在。2. 卡片列表为空。
[清理] 关闭面板

#### [P3] [反向] 验证市场插件缺席时市场标签不出现且不报错

[Case ID] TC-EXT-C-07-003
[层级] L2（真实浏览器页面，未接线）
[类型] 异常
[追踪] `packages/dsh-tauri-panel-extension/src/client/service/market.ts:32`
[自动化] 未接线（G2）
[前置条件] 未安装提供 `market.render` 的市场插件
[测试数据] 无
[测试步骤] 1. 打开扩展面板。2. 统计 `[role="tab"]` 的文案集合。3. 收集 `pageerror`。
[预期结果] 1. 标签集合不含市场项。2. `pageerror` 为空（缺席被静默处理，不是抛错）。
[清理] 关闭面板

#### [P1] 验证独立浏览器标签页不出市场标签且保留市场设置页入口

[Case ID] TC-EXT-C-07-004
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-panel-extension/src/client/register/extension-panel.tsx:13`、`packages/dsh-tauri-panel-extension/src/client/register/extension-panel.tsx:52`
[自动化] 未接线（G2）
[前置条件] 已安装提供 `market.render` 的市场插件；页面为顶层窗口（`window.parent === window`）
[测试数据] 无
[测试步骤] 1. 打开扩展面板。2. 统计 `[role="tab"]` 的文案集合。3. 打开 dsh 设置，读导航项集合。4. 收集 `pageerror`。
[预期结果] 1. 标签集合不含「市场」。2. 设置导航含「插件市场」。3. `pageerror` 为空。
[清理] 关闭面板

---

## 4. L3：桌面端宿主（真实 Tauri 窗口）

### [P1] 验证桌面端壳层可打开扩展面板并切换标签

[Case ID] TC-EXT-L3-07-001
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `packages/dsh-tauri-panel-extension/src/client/register/extension-panel.tsx:44`
[自动化] 待接线（`desktop` project 未配置，`00-overview.md` G4）
[前置条件] 应用就绪；`get_dsh_plugins` 返回中包含本插件
[测试数据] 无
[测试步骤] 1. 建 WebDriver 会话并切到 iframe。2. 打开扩展面板。3. 依次点击 `skills` 与 `mcp` 标签。
[预期结果] 1. 面板容器 `.dshp-extension__tabs` 存在。2. 每次点击后对应 `[role="tabpanel"]` 从 `hidden` 变为可见，且被点标签 `aria-selected="true"`。3. 应用日志无 `dsh://plugin-error`。
[清理] `DELETE /session/<id>`

### [P1] 验证桌面端 iframe 内市场由面板收编且撤下设置页重复入口

[Case ID] TC-EXT-L3-07-002
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `packages/dsh-tauri-panel-extension/src/client/register/extension-panel.tsx:18`
[自动化] 待接线（`desktop` project 未配置，`00-overview.md` G4）
[前置条件] 应用就绪；已安装提供 `market.render` 的市场插件；帧内 `window.parent !== window`
[测试数据] 无
[测试步骤] 1. 建 WebDriver 会话并切到 iframe。2. 打开扩展面板，读 `[role="tab"]` 文案集合与首项 `aria-selected`。3. 打开 dsh 设置，读导航项集合。
[预期结果] 1. 标签集合含「市场」，且恰有一个 `aria-selected="true"` 落在该列表首项。2. 设置导航**不含**「插件市场」（重复入口已撤下）。
[清理] `DELETE /session/<id>`

---

## 5. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `/skills` 只读 | TC-EXT-L2-07-001 | 正向 | — |
| `/skill` 404 | TC-EXT-L2-07-002 | 异常 | — |
| `/mcp` 结构 | TC-EXT-L2-07-003 | 正向 | — |
| `/mcp` 与 `/mcp/toggle` 缺参 | TC-EXT-L2-07-004、TC-EXT-L2-07-005 | 异常 | — |
| `/open/dir` target 白名单 | TC-EXT-L2-07-006 | 边界 | 其余 target 的 404/422 分支需要真实技能与仓库，**未覆盖** |
| `/roots` kind 校验 | TC-EXT-L2-07-007 | 异常 | — |
| `/host/restart` 双重拒绝 | TC-EXT-L2-07-008、TC-EXT-L2-07-009 | 异常 | 409「由壳层接管」分支只在壳层内触发，**未覆盖** |
| 面板与标签 | TC-EXT-C-07-001、TC-EXT-C-07-002、TC-EXT-L3-07-001 | 正向 | 依赖浏览器驱动 / `desktop` project |
| 市场标签缺席 | TC-EXT-C-07-003 | 异常 | 依赖未安装市场插件的前置 |
| 面板归属判据（`hostsMarketPanel`） | TC-EXT-U-07-001 ～ TC-EXT-U-07-003 | 正向 / 边界 | 已由 `unit` project 覆盖（`#658`：浏览器保留市场设置页入口） |
| 浏览器端市场入口归属 | TC-EXT-C-07-004 | 正向 | 依赖浏览器驱动与已装市场，**未接线** |
| 桌面端市场收编与重复入口撤下 | TC-EXT-L3-07-002 | 正向 | 依赖 `desktop` project，**未接线** |
| 技能写入 / 只读 403 / 422 | — | — | **未覆盖**：会改用户技能目录，留待带备份的专项批次 |

---

## 6. 缺口与假设

- **G-EXT-1**：`POST /skills/refresh` 与 `POST /import/apply` 无同步完成点（provider remount 是异步的），E2E 需轮询 `GET /skills` 直到稳定；本文件不覆盖这两条。
- **G-EXT-2**：市场标签页依赖外部市场插件发布 `market.render`（`packages/dsh-tauri-panel-extension/src/client/service/market.ts:32`），本包无法自足构造。
- **G-EXT-3**：`packagedSkillsDir()` 指向的 `skills` 目录在本 checkout 内无 git 文件；随包分发技能的有无**待确认**，相关断言暂不成立。
- **假设**：`SKILLS_DATA_DIR = $DSH_HOME/skills`（`packages/dsh-tauri-panel-extension/src/host/config/constants.ts:5`）；用例不直接读写该目录，只经路由观察。
