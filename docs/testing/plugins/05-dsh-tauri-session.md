# dsh-tauri-session：会话归档资源与工作区菜单补丁

> 层级：L2 插件宿主 E2E → L3 桌面端宿主 E2E
> 自动化：`test/e2e/plugins/archive-routes.e2e.ts`（待建立）；客户端与 L3 见各用例标注
> 前置：`pnpm build:plugins`；L3 另需 debug 二进制 + 空闲端口
> 运行：L2 `pnpm test:e2e:plugin`；L3 见 `00-overview.md` §5.2

本插件是**方法矩阵最复杂**的路由面：9 条 `(方法, 路径)` 收敛为 5 条注册行，且 `DELETE` 也要求 JSON 请求体——这一点与常规 REST 直觉相反，是本文件的主要负向考点。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| `PLUGIN_ID = 'dsh-tauri-session'`；分区 order 220 | `packages/dsh-tauri-session/src/shared/constants.ts:4`、`packages/dsh-tauri-session/src/shared/constants.ts:7` |
| 5 条注册行 / 9 条 `(方法,路径)` | `packages/dsh-tauri-session/src/host/routes/index.ts:19`、`packages/dsh-tauri-session/src/host/routes/index.ts:23`、`packages/dsh-tauri-session/src/host/routes/index.ts:26`、`packages/dsh-tauri-session/src/host/routes/index.ts:29`、`packages/dsh-tauri-session/src/host/routes/index.ts:30` |
| `GET /session/archive` 直接回读账本 | `packages/dsh-tauri-session/src/host/routes/session/archive/get.ts:5` |
| `POST`/`DELETE /session/archive` 空 id → 400 `invalid-session-id` | `packages/dsh-tauri-session/src/host/routes/session/archive/post.ts:8`、`packages/dsh-tauri-session/src/host/routes/session/archive/delete.ts:8` |
| `POST`/`DELETE …/archive/clear` 共用同一处理器 | `packages/dsh-tauri-session/src/host/routes/index.ts:23` |
| 空归档集合执行永久删除会抛 `缺少 sessionIds` | `packages/dsh-tauri-session/src/host/service/archive.ts:62` |
| 工作区批量入参空 → 400 `invalid-session-ids` | `packages/dsh-tauri-session/src/host/routes/session/workspace/archive/post.ts:10` |
| `open/path` 失败 → 400（`session-directory-not-found` / `not-a-directory`） | `packages/dsh-tauri-session/src/host/routes/session/open/path/post.ts:14`、`packages/dsh-tauri-session/src/host/service/session.ts:55` |
| 客户端分区 id `dsh-tauri-session-archive`；仅注册 `settings.section` | `packages/dsh-tauri-session/src/client/constants/index.ts:7`、`packages/dsh-tauri-session/src/client/register/archive-section.ts:18` |
| 工作区菜单补丁标记 | `packages/dsh-tauri-session/src/client/constants/index.ts:31`、`packages/dsh-tauri-session/src/client/constants/index.ts:32` |
| 补丁识别官方项依赖中文/英文文案与 `[class*="itemWrap"]` | `packages/dsh-tauri-session/src/client/constants/index.ts:22`、`packages/dsh-tauri-session/src/client/register/workspace-patch.utils.ts:57` |
| 无 Tauri 桥；禁用官方 `ui-settings-unarchive-sessions` 后由本插件顶替 | `packages/dsh-tauri-session/src/client/apis/index.ts:11`、`packages/dsh-tauri-session/cordis.patch.yml:3` |

---

## 2. L2：宿主路由

### [P1] 验证归档清单在干净环境返回空集合与固定形状

[Case ID] TC-SESS-L2-001
[层级] L2（真实 dsh 进程）
[类型] 正向
[追踪] `packages/dsh-tauri-session/src/host/routes/session/archive/get.ts:5`
[自动化] 是（`test/e2e/plugins/archive-routes.e2e.ts`）
[前置条件] scratch `DSH_HOME` 全新（无历史归档）
[测试数据] `GET /api/desktop/dsh-tauri-session/session/archive`
[测试步骤] 1. 发起请求。2. 读状态码与响应体 JSON。
[预期结果] 1. 状态码 200。2. 响应体恰为 `{ "archivedSessionIds": [], "meta": {} }`（两字段都存在，不允许省略 `meta`）。
[清理] 无

### [P3] [反向] 验证归档写入缺 sessionId 返回 400

[Case ID] TC-SESS-L2-002
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-session/src/host/routes/session/archive/post.ts:8`
[自动化] 是
[前置条件] 同 TC-SESS-L2-001
[测试数据] `POST` 同路径，body `{}`；再以 `{ "sessionId": 123 }` 重复一次
[测试步骤] 1. 两次发起请求。2. 读状态码与响应体。
[预期结果] 1. 两次均 400。2. 响应体均为 `{ ok: false, error: 'invalid-session-id' }`（非字符串同样被拒）。3. `GET` 清单仍为空（未产生副作用）。
[清理] 无

### [P3] [反向] 验证 DELETE 也按 JSON 读体，缺参同样 400

[Case ID] TC-SESS-L2-003
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-session/src/host/routes/session/archive/delete.ts:6`
[自动化] 是
[前置条件] 同 TC-SESS-L2-001
[测试数据] `DELETE` 同路径，无 body
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 400（不是 204 也不是 405）。2. 响应体 `{ ok: false, error: 'invalid-session-id' }`。
[清理] 无

### [P4] 验证空归档集合下执行「清空」的当前行为

[Case ID] TC-SESS-L2-004
[层级] L2（真实 dsh 进程）
[类型] 边界
[追踪] `packages/dsh-tauri-session/src/host/service/archive.ts:62`
[自动化] 是
[前置条件] 归档集合为空（全新 scratch）
[测试数据] 对 `/session/archive/clear` 分别发起 `POST` 与 `DELETE`
[测试步骤] 1. 发起 `POST`，读状态码与响应体。2. 发起 `DELETE`，读状态码与响应体。
[预期结果] 1. 当前实现两者均返回 500，错误信息含 `缺少 sessionIds`。2. `GET` 清单仍为空。
[清理] 无

### [P3] [反向] 验证工作区批量归档缺 ids 返回 400

[Case ID] TC-SESS-L2-005
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-session/src/host/routes/session/workspace/archive/post.ts:10`
[自动化] 是
[前置条件] 同 TC-SESS-L2-001
[测试数据] `POST /session/workspace/archive`，body `{}` 与 `{ "sessionIds": [] }`
[测试步骤] 1. 两次发起请求。2. 读状态码与响应体。
[预期结果] 1. 两次均 400。2. 响应体 `{ ok: false, error: 'invalid-session-ids' }`。
[清理] 无

### [P3] [反向] 验证打开不存在会话的目录返回领域错误

[Case ID] TC-SESS-L2-006
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-session/src/host/routes/session/open/path/post.ts:14`
[自动化] 是
[前置条件] 同 TC-SESS-L2-001；系统文件管理器动作不会真正执行（目录不存在）
[测试数据] `POST /session/open/path`，body `{ "sessionId": "does-not-exist" }`
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 400。2. 响应体 `{ ok: false, error: 'session-directory-not-found' }`。3. 不产生系统打开动作。
[清理] 无

### [P4] 验证五条注册行的方法矩阵互不相同

[Case ID] TC-SESS-L2-007
[层级] L2（真实 dsh 进程）
[类型] 边界
[追踪] `packages/dsh-tauri-session/src/host/routes/index.ts:19`
[自动化] 是
[前置条件] 同 TC-SESS-L2-001
[测试数据] 对 `/session/archive`、`/session/archive/clear`、`/session/workspace/archive`、`/session/archive/restore`、`/session/open/path` 各发一次 `OPTIONS`
[测试步骤] 1. 逐一 `OPTIONS`。2. 读每条响应的 `allow` 头。
[预期结果] 1. `/session/archive` 的 `allow` 含 `GET`、`HEAD`、`POST`、`DELETE`。2. `/session/archive/clear` 与 `/session/workspace/archive` 含 `POST`、`DELETE` 而不含 `GET`。3. `/session/archive/restore` 与 `/session/open/path` 只含 `POST`（HEAD 不适用）。4. 每条都含 `OPTIONS` 且状态码 204。
[清理] 无

---

## 3. L2：客户端（真实浏览器页面，未接线）

### [P1] 验证设置分区出现「已归档会话」页面

[Case ID] TC-SESS-C-001
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-session/src/client/register/archive-section.ts:18`
[自动化] 未接线（`00-overview.md` G2）
[前置条件] iframe 内 dsh 界面已加载；官方 `ui-settings-unarchive-sessions` 已被 patch 关闭
[测试数据] 无
[测试步骤] 1. 等待槽位注册完成。2. 断言 id 为 `dsh-tauri-session-archive` 的分区存在。3. 断言同 id 的分区只有 1 个。4. 收集 `pageerror`。
[预期结果] 1. 分区存在且唯一（patch 生效则官方分区不出现）。2. 分区内可见搜索框与空态容器。3. `pageerror` 为空。
[清理] 关闭页面

### [P2] 验证工作区菜单被插入归档入口

[Case ID] TC-SESS-C-002
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-session/src/client/register/workspace-patch.tsx:87`
[自动化] 未接线（G2）
[前置条件] 页面存在工作区行的「…」按钮与官方「删除工作区」菜单项
[测试数据] 点击工作区行的「…」按钮
[测试步骤] 1. 打开菜单。2. 查询 `[data-dsh-tauri-session-archive-menu-patched="1"]`。3. 查询其内 `[data-dsh-tauri-session-archive-item]`。
[预期结果] 1. 菜单容器带补丁标记。2. 存在恰好 1 个归档项，且位置在官方「删除工作区」项之前。
[清理] 关闭菜单

---

## 4. L3：桌面端宿主（真实 Tauri 窗口）

### [P2] 验证桌面端设置对话框内可打开归档面板

[Case ID] TC-SESS-L3-001
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `packages/dsh-tauri-session/src/client/register/archive-section.ts:18`
[自动化] 待接线（G4）
[前置条件] 应用就绪；iframe 内 dsh 界面加载完成
[测试数据] 无
[测试步骤] 1. 建 WebDriver 会话。2. 切到 iframe 并打开设置。3. 定位 id `dsh-tauri-session-archive` 的分区并读其标题。
[预期结果] 1. 分区存在。2. 标题文案为 `已归档会话`（中文 locale）。3. 面板内出现空态容器而非错误条。
[清理] `DELETE /session/<id>`

### [P4] [反向] 验证点击克隆出的归档项不会触发官方删除动作

[Case ID] TC-SESS-L3-002
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `packages/dsh-tauri-session/src/client/register/workspace-patch.tsx:125`
[自动化] 待接线（G4）
[前置条件] 存在至少 1 个真实工作区；已打开其「…」菜单
[测试数据] 点击 `[data-dsh-tauri-session-archive-item]`
[测试步骤] 1. 记录点击前工作区数量。2. 点击归档项。3. 关闭弹出的确认对话框。4. 重新读取工作区数量。
[预期结果] 1. 官方菜单关闭且未触发「删除工作区」。2. 工作区数量不变（未删除）。3. 归档项点击后 `session/archive` 清单增加对应 id。
[清理] 取消归档并删除 scratch 状态

---

## 5. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `get.ts:5` 清单形状 | TC-SESS-L2-001 | 正向 | — |
| `post.ts:8` / `delete.ts:8` 入参校验 | TC-SESS-L2-002、TC-SESS-L2-003 | 异常 | — |
| `archive.ts:62` 空集合清理 | TC-SESS-L2-004 | 边界 | 当前行为与「幂等」直觉冲突，待产品确认 |
| `workspace/archive/post.ts:10` | TC-SESS-L2-005 | 异常 | — |
| `open/path/post.ts:14` | TC-SESS-L2-006 | 异常 | `not-a-directory` 分支需要真实存在但非目录的路径，**未覆盖** |
| `routes/index.ts:19` 方法矩阵 | TC-SESS-L2-007 | 边界 | 与 `02-dsh-tauri-core.md` 的 405 用例不重复（此处只验 `allow` 集合） |
| 分区注册 | TC-SESS-C-001、TC-SESS-L3-001 | 正向 | 依赖浏览器驱动 / `desktop` project |
| 工作区菜单补丁 | TC-SESS-C-002、TC-SESS-L3-002 | 正向 / 边界 | 依赖真实工作区数据 |
| `restore` 与 `clear` 的历史态流转 | — | — | **未覆盖**：需要宿主会话生命周期配合，见 G-SESS-2 |

---

## 6. 缺口与假设

- **G-SESS-1**：`client/constants/index.ts:18` 与 `:19` 的 `SIDEBAR_ATTACH_POLL_MS` / `SIDEBAR_ATTACH_MAX_TRIES` 在 `src` 内零引用，疑为死常量。**不影响用例**，但清理后需复核本文件是否引用。
- **G-SESS-2**：归档→恢复→删除的完整历史态流转需要宿主真实会话配合（`archive.restore` 依赖 `workspaceRegistry`）。当前 scratch 宿主无会话数据，**未覆盖**；建议后续以「宿主 API 造一条会话」的方式补齐。
- **G-SESS-3**：工作区菜单补丁依赖官方中文/英文文案与 `[class*="itemWrap"]` 结构（`workspace-patch.utils.ts:57`）。宿主 UI 改版时补丁会静默不插入，因此 TC-SESS-C-002 的失败信息必须包含「菜单容器未带补丁标记」而非笼统超时。
- **G-SESS-4**：**待确认期望**——在空归档集合上执行 `/session/archive/clear` 当前返回 500（`packages/dsh-tauri-session/src/host/service/archive.ts:62`）。是否应改为幂等返回 `{ ok: true }` 需产品确认；确认后 TC-SESS-L2-004 的期望同步更新，若判定为缺陷则同时补缺陷单。
- **假设**：`POST /session/archive` 对**不存在的** sessionId 的行为由宿主 `archiveSession` 决定（`archive.ts:13`），本套用例不断言该分支。
