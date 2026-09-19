# dsh-tauri-ui：壳层注入（设置侧栏 / 触发器 / 续跑补丁）

> 层级：L2 插件宿主 E2E → L3 桌面端宿主 E2E
> 自动化：`packages/dsh-tauri-ui/test/resume-route.e2e.ts`（待建立）；客户端与 L3 见各用例标注
> 前置：`pnpm build:plugins`；L3 另需 debug 二进制 + 空闲端口
> 运行：L2 `pnpm test:e2e:plugin`；L3 见 `00-overview.md` §5.2

本插件是**桌面端与 dsh 界面之间真正的主桥**：它把设置侧栏、触发器与「继续任务」补丁注入 dsh 界面，并独占一条续跑路由。壳层侧的设置对话框、侧栏折叠等能力都依赖它存在。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| `PLUGIN_ID = 'dsh-tauri-ui'` | `packages/dsh-tauri-ui/src/shared/constants.ts:1` |
| 唯一路由 `POST /api/desktop/dsh-tauri-ui/session/resume` | `packages/dsh-tauri-ui/src/host/routes/index.ts:5` |
| 缺 sessionId → 400 | `packages/dsh-tauri-ui/src/host/routes/session/resume/post.ts:10` |
| 未知会话 → 404；运行中 → 409；已正常结束 → 409 | `packages/dsh-tauri-ui/src/host/service/session.ts:30`、`packages/dsh-tauri-ui/src/host/service/session.ts:32`、`packages/dsh-tauri-ui/src/host/service/session.ts:35` |
| 成功注入固定续跑指令，来源标记 `{kind:'plugin', plugin: PLUGIN_ID}` | `packages/dsh-tauri-ui/src/host/service/session.ts:39` |
| 客户端 5 个槽位：`shell.overlay` / `sidebar.settings` / `settings.section` / `settings.trigger` / `settings.onboarding` | `packages/dsh-tauri-ui/src/client/constants/index.ts:6` |
| 设置侧栏根：`class="dshp-settings-sidebar"` + `data-slot-sidebar="dsh-tauri-ui"` | `packages/dsh-tauri-ui/src/client/components/sidebar.tsx:92` |
| 触发器 `.dshp-settings-trigger`，带 `aria-haspopup` 与 `aria-expanded` | `packages/dsh-tauri-ui/src/client/components/trigger.tsx:44` |
| 续跑补丁依赖 `[data-composer-card]` 与 `[data-composer-placeholder]` | `packages/dsh-tauri-ui/src/client/register/composer-resume.ts:17`、`packages/dsh-tauri-ui/src/client/register/composer-resume.utils.ts:5` |
| 可续跑轮次类型 `aborted` / `error` / `interrupted` | `packages/dsh-tauri-ui/src/client/register/composer-resume.ts:7` |
| 客户端同样只在 iframe 内生效 | `packages/dsh-tauri/src/client/apply.ts:29` |

---

## 2. L2：宿主路由

### [P3] [反向] 验证续跑缺 sessionId 返回 400

[Case ID] TC-UI-L2-001
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-ui/src/host/routes/session/resume/post.ts:10`
[自动化] 是（`packages/dsh-tauri-ui/test/resume-route.e2e.ts`）
[前置条件] 插件已构建并挂载
[测试数据] `POST /session/resume`，body `{}`
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 400。2. 响应体 `error` 恰为 `缺少 sessionId`。3. 无后续消息注入。
[清理] 无

### [P3] [反向] 验证未知会话返回 404

[Case ID] TC-UI-L2-002
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-ui/src/host/service/session.ts:30`
[自动化] 是
[前置条件] 同 TC-UI-L2-001
[测试数据] `{ "sessionId": "does-not-exist" }`
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 404。2. 响应体 `error` 恰为 `会话不存在或尚未运行`。
[清理] 无

### [P3] [反向] 验证运行中的会话被拒绝续跑

[Case ID] TC-UI-L2-003
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-ui/src/host/service/session.ts:32`
[自动化] 待补（需要一条真实「运行中」会话）
[前置条件] scratch 宿主内存在正在运行的会话
[测试数据] 该会话 id
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 409。2. 响应体 `error` 恰为 `会话仍在运行，无需继续`。3. 该会话的 turn 数不变。
[清理] 中止该会话

### [P4] [反向] 验证已正常结束的会话被拒绝续跑

[Case ID] TC-UI-L2-004
[层级] L2（真实 dsh 进程）
[类型] 边界
[追踪] `packages/dsh-tauri-ui/src/host/service/session.ts:35`
[自动化] 待补（同 TC-UI-L2-003 的前置）
[前置条件] 存在一条已正常结束（`completed` / `blocked` / `max-tokens`）的会话
[测试数据] 该会话 id
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 409。2. 响应体 `error` 以 `上一轮已正常结束（` 开头，且括号内为 `completed`、`blocked`、`max-tokens` 之一。
[清理] 无

---

## 3. L2：客户端（真实浏览器页面，未接线）

### [P1] 验证设置侧栏与触发器被注入 dsh 界面

[Case ID] TC-UI-C-001
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-ui/src/client/components/sidebar.tsx:92`、`packages/dsh-tauri-ui/src/client/components/trigger.tsx:44`
[自动化] 未接线（`00-overview.md` G2）
[前置条件] iframe 内 dsh 界面已加载；`sidebar.settings` 槽位存在
[测试数据] 无
[测试步骤] 1. 等待首屏稳定。2. 查询 `[data-slot-sidebar="dsh-tauri-ui"]` 与 `.dshp-settings-trigger`。3. 收集 `pageerror`。
[预期结果] 1. 两者均存在且各自唯一。2. 触发器位于 `[data-slot="sidebar"]` 内。3. `pageerror` 为空。
[清理] 关闭页面

### [P2] 验证触发器 `aria-expanded` 随设置侧栏开合变化

[Case ID] TC-UI-C-002
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-ui/src/client/components/trigger.tsx:46`
[自动化] 未接线（G2）
[前置条件] 同 TC-UI-C-001
[测试数据] 点击触发器两次
[测试步骤] 1. 读初始 `aria-expanded`。2. 点击触发器。3. 再读该属性。4. 再次点击并读第三次。
[预期结果] 1. 初始为 `"false"`。2. 首次点击后为 `"true"` 且 `[data-slot-sidebar="dsh-tauri-ui"]` 可见。3. 二次点击后回到 `"false"`。
[清理] 关闭页面

### [P2] 验证中断轮次后主按钮被改写为「继续任务」

[Case ID] TC-UI-C-003
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-ui/src/client/register/composer-resume.ts:53`
[自动化] 未接线（G2）
[前置条件] 存在最近一轮以 `aborted` / `error` / `interrupted` 结束的会话；composer 草稿为空
[测试数据] 无
[测试步骤] 1. 等待补丁生效。2. 读 `[data-composer-card]` 内主按钮的 `aria-label` 与 `svg path` 的 `d`。3. 读按钮 `disabled`。
[预期结果] 1. `aria-label` 为 `继续任务`（中文 locale）。2. `svg` 宽度为 `14px`。3. 按钮可点击（`disabled` 为 false）。
[清理] 关闭页面

### [P3] [反向] 验证非空草稿时补丁不生效

[Case ID] TC-UI-C-004
[层级] L2（真实浏览器页面，未接线）
[类型] 异常
[追踪] `packages/dsh-tauri-ui/src/client/register/composer-resume.utils.ts:15`
[自动化] 未接线（G2）
[前置条件] 同 TC-UI-C-003，但在 composer 中填入任意文本
[测试数据] 草稿文本 `hello`
[测试步骤] 1. 等待补丁周期。2. 读主按钮 `aria-label`。
[预期结果] 1. `aria-label` **不是** `继续任务`（回落官方文案）。2. 无异常抛出。
[清理] 清空草稿并关闭页面

---

## 4. L3：桌面端宿主（真实 Tauri 窗口）

### [P1] 验证桌面端壳层内设置侧栏可开合

[Case ID] TC-UI-L3-001
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `packages/dsh-tauri-ui/src/client/components/sidebar.tsx:92`
[自动化] 待接线（`desktop` project 未配置，`00-overview.md` G4）
[前置条件] 应用与 iframe 内界面均已就绪；`dsh-tauri-ui` 已挂载（经 `get_dsh_plugins` 确认）
[测试数据] 无
[测试步骤] 1. 建 WebDriver 会话并切到 iframe。2. 点击 `.dshp-settings-trigger`。3. 查询 `[data-slot-sidebar="dsh-tauri-ui"]`。
[预期结果] 1. 侧栏元素出现且可见。2. 触发器 `aria-expanded="true"`。3. 侧栏内可见搜索框与至少一个导航项。4. 应用日志无 `dsh://plugin-error`。
[清理] 关闭侧栏；`DELETE /session/<id>`

### [P2] 验证侧栏折叠后触发器进入 Rail 形态

[Case ID] TC-UI-L3-002
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `packages/dsh-tauri-ui/src/client/components/trigger.tsx:52`
[自动化] 待接线（G4）
[前置条件] 同 TC-UI-L3-001；壳层侧栏折叠按钮存在（依赖 `dsh-tauri` 已挂载）
[测试数据] 无
[测试步骤] 1. 折叠侧栏。2. 读触发器几何宽度与相关 class。
[预期结果] 1. 触发器宽度收敛为 rail 宽度（由 `--dsh-settings-rail-width` 控制）。2. 触发器仍未脱离可见区域（宽 > 0）。
[清理] 展开侧栏；`DELETE /session/<id>`

---

## 5. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `resume/post.ts:10` 缺参 | TC-UI-L2-001 | 异常 | — |
| `session.ts:30` 会话不存在 | TC-UI-L2-002 | 异常 | — |
| `session.ts:32` / `:35` 状态判定 | TC-UI-L2-003、TC-UI-L2-004 | 异常 / 边界 | 需要造真实会话，当前待补 |
| 侧栏与触发器注入 | TC-UI-C-001、TC-UI-C-002、TC-UI-L3-001 | 正向 | 依赖浏览器驱动 / `desktop` project |
| 续跑补丁 | TC-UI-C-003、TC-UI-C-004 | 正向 / 异常 | 需要中断轮次数据 |
| Rail 形态 | TC-UI-L3-002 | 正向 | 需要 `dsh-tauri` 同时挂载 |
| 续跑成功路径（真发消息） | — | — | **未覆盖**：需要真实 Agent 会话，属后续批次 |

---

## 6. 缺口与假设

- **G-UI-1**：本插件 `inject` 依赖 `slots` / `layout` / `locale` / `sessions`（`packages/dsh-tauri-ui/src/client/index.ts:27`）。若宿主未提供 `SlotOutlet`，设置注册整体跳过并 warn（`packages/dsh-tauri-ui/src/client/register/settings.ts:15`）——用例失败信息必须能区分「槽位缺失」与「组件报错」。
- **G-UI-2**：`settings.section` / `settings.onboarding` 的内容由其它插件提供（`packages/dsh-tauri-ui/src/client/register/sections.ts:6`）。单独挂载本插件时该槽位为空，属预期。
- **G-UI-3**：`[data-composer-card]` / `[data-composer-placeholder]` 是内核 DOM 约定，本仓库内无定义处；内核升级时补丁会静默失效，因此 TC-UI-C-003 必须断言「按钮文案已改写」而非「未报错」。
- **G-UI-4**：TC-UI-L2-003 / TC-UI-L2-004 需要一条真实「运行中 / 已正常结束」的会话，而当前 scratch 宿主无造会话手段，故标记为**待补**；补齐造会话能力后这两条进入核心集。
- **假设**：中文 locale 固定（用例断言 `继续任务`）；多语种覆盖留待 locale 专项。
