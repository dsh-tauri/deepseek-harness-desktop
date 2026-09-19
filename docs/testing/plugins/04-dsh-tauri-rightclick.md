# dsh-tauri-rightclick：外部打开接口与自绘右键菜单

> 层级：L2 插件宿主 E2E → L3 桌面端宿主 E2E
> 自动化：`packages/dsh-tauri-rightclick/test/open-routes.e2e.ts`（待建立）、客户端与 L3 见各用例标注
> 前置：`pnpm build:plugins`；L3 另需 debug 二进制 + 空闲端口
> 运行：L2 `pnpm test:e2e:plugin`；L3 见 `00-overview.md` §5.2

本插件是**唯一带真实系统副作用**的 L2 路由（会拉起浏览器/文件管理器），因此正向用例把副作用压到最小，异常与边界用例全部走**不触发副作用**的分支。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| `PLUGIN_ID = 'dsh-tauri-rightclick'` | `packages/dsh-tauri-rightclick/src/shared/constants.ts:1` |
| `POST /api/desktop/dsh-tauri-rightclick/open/url` | `packages/dsh-tauri-rightclick/src/host/routes/index.ts:6` |
| `POST /api/desktop/dsh-tauri-rightclick/open/path` | `packages/dsh-tauri-rightclick/src/host/routes/index.ts:7` |
| JSON content-type 守卫 → 415 `unsupported-media-type` | `packages/dsh-tauri-rightclick/src/host/routes/open/url/post.ts:9`、`packages/dsh-tauri-rightclick/src/host/config/constants.ts:1` |
| url 校验失败 → 400 `invalid-url`；打开失败 → 500 | `packages/dsh-tauri-rightclick/src/host/routes/open/url/post.ts:16`、`packages/dsh-tauri-rightclick/src/host/service/opener.ts:17` |
| path 校验失败 → 400 `invalid-path`；非目录 → 400 `not-a-directory` | `packages/dsh-tauri-rightclick/src/host/routes/open/path/post.ts:19`、`packages/dsh-tauri-rightclick/src/host/service/opener.ts:30` |
| 打开动作串行化（一次一个） | `packages/dsh-tauri-rightclick/src/host/service/mutation-queue.ts:11` |
| 客户端**不注册任何 slot**，用 capture 阶段事件接管 | `packages/dsh-tauri-rightclick/src/client/index.ts:9`、`packages/dsh-tauri-rightclick/src/client/register/context-menu.ts:201` |
| 菜单 DOM：`div.dshp-menu[role=menu]`、`button.dshp-menu__item[role=menuitem]`、`div.dshp-toast` | `packages/dsh-tauri-rightclick/src/client/register/menu-dom.ts:12`、`packages/dsh-tauri-rightclick/src/client/register/menu-dom.ts:20`、`packages/dsh-tauri-rightclick/src/client/register/context-menu.ts:52` |
| 键盘交互：方向键移动、Escape 关闭、打开后聚焦首项 | `packages/dsh-tauri-rightclick/src/client/register/context-menu.ts:175`、`packages/dsh-tauri-rightclick/src/client/register/menu-dom.ts:54` |
| 扩展协议：全局事件 `dsh:rightclick-menu`、`Symbol.for('dsh.rightclick-menu.extensions')` | `packages/dsh-tauri-rightclick/src/client/constants/index.ts:30`、`packages/dsh-tauri-rightclick/src/client/service/registry.ts:6` |
| 无 Tauri 桥（客户端只调自家 HTTP 路由） | `packages/dsh-tauri-rightclick/src/client/apis/index.ts:11` |

---

## 2. L2：宿主路由

### [P1] 验证合法外链经 open/url 被接受

[Case ID] TC-RC-L2-001
[层级] L2（真实 dsh 进程）
[类型] 正向
[追踪] `packages/dsh-tauri-rightclick/src/host/routes/open/url/post.ts:22`
[自动化] 是（`packages/dsh-tauri-rightclick/test/open-routes.e2e.ts`）
[前置条件] 插件已构建并挂载；执行环境允许拉起系统浏览器
[测试数据] `POST /open/url`，body `{ "url": "https://example.com" }`，`content-type: application/json`
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 200。2. 响应体 `{ ok: true }`。3. 宿主日志无 `open-url-failed`。
[清理] 关闭被拉起的浏览器标签（人工）；该用例不适合放进无人值守流水线

### [P3] [反向] 验证非 JSON 请求体被 415 拒绝

[Case ID] TC-RC-L2-002
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-rightclick/src/host/routes/open/url/post.ts:9`
[自动化] 是
[前置条件] 同 TC-RC-L2-001
[测试数据] body `url=https://example.com`，`content-type: text/plain`
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 415。2. 响应体 `{ ok: false, error: 'unsupported-media-type' }`。3. 不产生任何系统打开动作。
[清理] 无

### [P3] [反向] 验证危险 scheme 被 open/url 拒绝

[Case ID] TC-RC-L2-003
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-rightclick/src/host/routes/open/url/post.ts:16`
[自动化] 是
[前置条件] 同 TC-RC-L2-001
[测试数据] 依次提交 `javascript:alert(1)`、`file:///etc/passwd`、`""`、`123`
[测试步骤] 1. 逐一发起请求。2. 每次读状态码与响应体。
[预期结果] 1. 四次均返回 400。2. 响应体均为 `{ ok: false, error: 'invalid-url' }`。3. 无任何系统打开动作。
[清理] 无

### [P3] [反向] 验证空路径与带 scheme 的值被 open/path 拒绝

[Case ID] TC-RC-L2-004
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-rightclick/src/host/routes/open/path/post.ts:19`
[自动化] 是
[前置条件] 同 TC-RC-L2-001
[测试数据] 依次提交 `{ "path": "" }`、`{ "path": "   " }`、`{ "path": "https://example.com" }`
[测试步骤] 1. 逐一发起请求。2. 每次读状态码与响应体。
[预期结果] 1. 三次均返回 400。2. 响应体均为 `{ ok: false, error: 'invalid-path' }`。3. 无任何系统打开动作。
[清理] 无

### [P4] [反向] 验证不存在的目录返回 not-a-directory 且不产生副作用

[Case ID] TC-RC-L2-005
[层级] L2（真实 dsh 进程）
[类型] 边界
[追踪] `packages/dsh-tauri-rightclick/src/host/service/opener.ts:30`
[自动化] 是
[前置条件] 同 TC-RC-L2-001
[测试数据] `{ "path": "<scratch DSH_HOME>/definitely-missing-dir" }`（由 `inject('dshHome')` 拼接，保证不存在）
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 400。2. 响应体 `{ ok: false, error: 'not-a-directory' }`。
[清理] 无

---

## 3. L2：客户端（真实浏览器页面，未接线）

> 依赖浏览器驱动，当前仓库无 `playwright`（`00-overview.md` G2），标注**未接线**。

### [P1] 验证会话行右键弹出菜单且焦点落在首项

[Case ID] TC-RC-C-001
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-rightclick/src/client/register/context-menu.ts:131`
[自动化] 未接线（G2）
[前置条件] 页面为 iframe 内的 dsh 界面；存在至少一条会话行（`[role="treeitem"]`）
[测试数据] 在 `[data-slot="conversation.session"]` 上派发 `contextmenu`
[测试步骤] 1. 派发右键事件。2. 查询 `div.dshp-menu[role=menu]`。3. 读 `document.activeElement`。
[预期结果] 1. 菜单存在且唯一。2. 菜单内至少一个 `button.dshp-menu__item[role=menuitem]`。3. 焦点位于第一个菜单项。
[清理] 派发 `Escape` 关闭菜单

### [P2] 验证 Escape 与点击空白关闭菜单，且重复右键不叠加菜单

[Case ID] TC-RC-C-002
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-rightclick/src/client/register/context-menu.ts:136`、`packages/dsh-tauri-rightclick/src/client/register/context-menu.ts:203`
[自动化] 未接线（G2）
[前置条件] 同 TC-RC-C-001
[测试数据] 连续两次右键同一行，随后 Escape
[测试步骤] 1. 右键两次。2. 查询 `div.dshp-menu` 数量。3. 派发 `Escape`。4. 再次查询。
[预期结果] 1. 第二次右键后菜单数量仍为 1（旧菜单先移除再新建）。2. `Escape` 后菜单数量为 0。
[清理] 无

### [P3] [反向] 验证输入控件内的右键不弹自定义菜单

[Case ID] TC-RC-C-003
[层级] L2（真实浏览器页面，未接线）
[类型] 异常
[追踪] `packages/dsh-tauri-rightclick/src/client/constants/index.ts:23`
[自动化] 未接线（G2）
[前置条件] 页面存在 `textarea` 或 `[contenteditable="true"]`
[测试数据] 在 `textarea` 上派发 `contextmenu`
[测试步骤] 1. 派发右键。2. 查询 `div.dshp-menu`。3. 检查事件默认行为是否被阻止。
[预期结果] 1. 无自定义菜单。2. `contextmenu` 默认行为未被 `preventDefault`（保留系统编辑菜单）。
[清理] 无

### [P3] [反向] 验证剪贴板不可用时给出可见错误提示

[Case ID] TC-RC-C-004
[层级] L2（真实浏览器页面，未接线）
[类型] 异常
[追踪] `packages/dsh-tauri-rightclick/src/client/register/context-menu.ts:61`
[自动化] 未接线（G2）
[前置条件] 通过驱动移除 `navigator.clipboard`，或令 `writeText` 抛错
[测试数据] 在可选中的文本上右键并点击「复制」
[测试步骤] 1. 打开菜单。2. 点击复制项。3. 查询 `div.dshp-toast`。
[预期结果] 1. 出现 `div.dshp-toast` 且文案对应 `clipboardUnavailable`。2. 菜单已关闭（点击项先 close 再执行）。
[清理] 恢复剪贴板替身

---

## 4. L3：桌面端宿主（真实 Tauri 窗口）

### [P1] 验证桌面端壳层内右键菜单行为与浏览器层一致

[Case ID] TC-RC-L3-001
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `packages/dsh-tauri-rightclick/src/client/register/context-menu.ts:201`
[自动化] 待接线（`desktop` project 未配置，`00-overview.md` G4）
[前置条件] 应用与内置 DSH 界面就绪；至少一条会话行可见
[测试数据] 在会话行上派发 `contextmenu`
[测试步骤] 1. 建立 WebDriver 会话并切到 iframe。2. 派发右键。3. 查询菜单根与菜单项。4. Escape 关闭。
[预期结果] 1. `div.dshp-menu[role=menu]` 出现且含 `[role=menuitem]`。2. Escape 后消失。3. 应用日志无 `dsh://plugin-error` 上报。
[清理] `DELETE /session/<id>`

### [P4] 验证键盘导航在 WebView2 上可用

[Case ID] TC-RC-L3-002
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `packages/dsh-tauri-rightclick/src/client/register/context-menu.ts:175`
[自动化] 待接线（G4）
[前置条件] 同 TC-RC-L3-001
[测试数据] `ArrowDown` ×2、`Home`、`End`、`Escape`
[测试步骤] 1. 打开菜单。2. 逐键派发并读 `document.activeElement`。3. `Escape`。
[预期结果] 1. 每次按键后焦点落在 `[role=menuitem]` 元素上且位置符合按键语义。2. `Escape` 后菜单关闭且焦点回到触发元素。
[清理] `DELETE /session/<id>`

---

## 5. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `open/url/post.ts` 三态（415/400/500） | TC-RC-L2-001、TC-RC-L2-002、TC-RC-L2-003 | 正向 / 异常 | 500 分支无法在不破坏系统默认打开器的前提下构造，**未覆盖** |
| `open/path/post.ts` 三态（415/400/not-a-directory） | TC-RC-L2-004、TC-RC-L2-005 | 异常 / 边界 | 415 已由 TC-RC-L2-002 同源覆盖，不重复 |
| 菜单挂载与关闭 | TC-RC-C-001、TC-RC-C-002 | 正向 | 依赖浏览器驱动 |
| `EDITABLE_SELECTOR` 例外 | TC-RC-C-003 | 异常 | 依赖浏览器驱动 |
| 剪贴板降级 | TC-RC-C-004 | 异常 | `execCommand` 回退分支需单独造环境，**未覆盖** |
| 桌面端 WebView 内行为一致性 | TC-RC-L3-001、TC-RC-L3-002 | 正向 / 边界 | 依赖 `desktop` project |

---

## 6. 缺口与假设

- **G-RC-1**：`open/url` 的 500 分支（`opener.ts:17`）需要让系统打开动作失败。当前不构造该环境，**未覆盖**，登记为已知盲区。
- **G-RC-2**：`src/host/routes/index.test.ts:146` 已有 415/400 的单元级回归；本文件的 L2 用例是**真实宿主**下的同一断言，属有意重复的信任边界加固。
- **G-RC-3**：扩展注册表（`Symbol.for('dsh.rightclick-menu.extensions')`）在本包内无注册者，第三方扩展项的行为**不在范围**。
- **假设**：菜单容器类名 `dshp-menu` 属于插件前缀 class，按 `plugin.client.md` §4「允许使用插件前缀 class」可作为稳定选择器；若改为 `data-testid`，用例同步更新。
