# 多窗口与缩放

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/desktop/19-multi-window.e2e.ts`（待建立）
> 前置：`12-window-tray.md` 通过
> 运行：`vitest --project desktop -- test/e2e/desktop/19-multi-window.e2e.ts`（待配置，见 G2）

「文件 → 新建窗口」以同一 `index.html` 再开一个独立 webview；所有窗口共享同一数据目录与同一 DSH 服务实例。缩放有两条入口：壳层快捷键（焦点在导航栏等壳层元素时）与 iframe 内转发的桥消息（跨源 iframe 内的快捷键不会冒泡到壳层）。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 「新建窗口」→ `create_app_window`（异步命令） | `src/layout/components/navbar.tsx:239-247`、`:388-395` |
| `create_app_window` → `build_extra_window` | `src-tauri/src/desktop/window.rs:144-149` |
| 额外窗口与主窗口同标题、同尺寸、同最小尺寸 | `src-tauri/src/desktop/builder.rs:617-626` |
| 建窗必须在异步运行时（主线程调用会死锁） | `src-tauri/src/desktop/window.rs:140-143` |
| 主窗口几何保存与服务回收在退出时触发 | `src-tauri/src/lib.rs:51` |
| 壳层缩放快捷键（capture 阶段） | `src/layout/components/iframe.tsx:78`、`:122-128` |
| 快捷键映射：`+`/`=` 增大、`-`/`_` 减小、`0` 重置 | `src/utils/zoom.ts:16-27` |
| iframe 内缩放桥 `dsh://zoom-shortcut` | `src/layout/components/iframe.tsx:112-115`、`:171-175` |
| 桥消息动作值域 `increase`/`decrease`/`reset` | `src/utils/zoom.ts:29-41` |
| 缩放步长 `0.1`，上下限 `0.5`/`2.0` | `src/utils/zoom.ts:62-68` |
| 缩放应用到 WebView（`Webview.setZoom`） | `src/hooks/use-zoom-factor.ts:143-150` |
| 导航命令：`dsh://session:new`、`dsh://workspace:add` | `src/layout/components/webview.tsx:71-72` |
| 命令经 `useIframePost` 发出 | `src/layout/components/webview.tsx:33` |

---

## 2. 多窗口

### [P1] 验证「文件 → 新建窗口」创建第二个窗口

[Case ID] TC-DSK-L3-142
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/navbar.tsx:239-247`、`:388-395`；`src-tauri/src/desktop/window.rs:144-149`
[自动化] 待接线（`test/e2e/desktop/19-multi-window.e2e.ts`）
[前置条件] 应用处于 `ready`；当前仅 1 个窗口；平台非 macOS
[测试数据] 菜单项 id `new-window`；期望标题 `Deepseek Harness Desktop`
[测试步骤] 1. 记录窗口句柄集合。2. 打开「文件」菜单并点击「新建窗口」。3. 等待新窗口出现。4. 读取句柄集合与各窗口标题。
[预期结果] 1. 句柄数为 1。2. 点击被接受。3. 新窗口在超时内出现。4. 句柄数为 2；两个窗口标题均为 `Deepseek Harness Desktop`。
[清理] 关闭第二个窗口；`DELETE /session/<id>`

### [P2] 验证新窗口独立加载自己的 iframe

[Case ID] TC-DSK-L3-143
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/desktop/builder.rs:617-626`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-142 通过；服务健康
[测试数据] 选择器 `dsh-shell-iframe`
[测试步骤] 1. 在窗口 A 中读取 iframe 的 `src` 与实例标识。2. 切到窗口 B 并读取其 iframe 的 `src` 与实例标识。3. 比较两个 `src` 的协议、主机与端口。
[预期结果] 1. 读取成功。2. 读取成功。3. 两者同源；两个 iframe 各自独立存在（窗口 B 的 iframe 不依赖窗口 A 的渲染，实例标识不同）。
[清理] 关闭第二个窗口；`DELETE /session/<id>`

### [P4] 验证新窗口继承同一服务地址

[Case ID] TC-DSK-L3-144
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/desktop/builder.rs:617`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-142 通过
[测试数据] 观察点：各窗口内 `get_runtime_info().service_url`
[测试步骤] 1. 在窗口 A 中读取 `service_url`。2. 在窗口 B 中读取 `service_url`。3. 比较两者。
[预期结果] 1. 读取成功。2. 读取成功。3. 两者完全相等（共享同一 DSH 服务实例，不重复拉起服务）。
[清理] 关闭第二个窗口；`DELETE /session/<id>`

### [P3] 验证关闭其中一个窗口不影响另一个

[Case ID] TC-DSK-L3-145
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/lib.rs:51`（`RunEvent::ExitRequested` 语义）
[自动化] 待接线（同上）
[前置条件] 存在 2 个窗口；服务健康
[测试数据] 无
[测试步骤] 1. 完整关闭窗口 B。2. 等待窗口句柄集合变化。3. 读取句柄数、窗口 A 的 iframe 状态与服务状态。
[预期结果] 1. 关闭被接受。2. 句柄集合变化。3. 句柄数为 1；窗口 A 的 iframe 仍存在且未报错；服务仍在运行。
[清理] `DELETE /session/<id>`

---

## 3. 缩放

### [P2] 验证缩放快捷键 Ctrl+0 重置为 100%

[Case ID] TC-DSK-L3-146
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/iframe.tsx:78`、`:122-128`；`src/utils/zoom.ts:16-27`
[自动化] 待接线（同上）
[前置条件] 应用处于 `ready`；当前缩放为 150%
[测试数据] 快捷键 `Ctrl+0`；观察点 `window.innerWidth`
[测试步骤] 1. 记录当前 `window.innerWidth`。2. 在壳层焦点下按下 `Ctrl+0`。3. 等待缩放应用。4. 再次读取 `window.innerWidth` 与已保存缩放值。
[预期结果] 1. 记录成功。2. 快捷键被接受。3. 应用完成。4. `window.innerWidth` 恢复为 100% 下的基准宽度（允许 ±2px 误差）；已保存缩放值为 `1`。
[清理] 缩放改回 `1`；`DELETE /session/<id>`

### [P2] 验证 iframe 内缩放桥消息被宿主处理

[Case ID] TC-DSK-L3-147
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/iframe.tsx:112-115`、`:171-175`；`src/utils/zoom.ts:29-41`
[自动化] 待接线（同上）
[前置条件] 应用处于 `ready`；当前缩放为 100%
[测试数据] 桥消息 `{ type: 'dsh://zoom-shortcut', action: 'increase' }`；另测 `decrease` 与 `reset`
[测试步骤] 1. 由 iframe 侧发出 `increase` 桥消息。2. 等待缩放应用。3. 读取已保存缩放值。4. 依次发出 `decrease` 与 `reset`，每次读取已保存缩放值。
[预期结果] 1. 消息发出成功。2. 应用完成。3. 已保存缩放值为 `1.1`。4. `decrease` 后为 `1.0`（不低于下限 `0.5`）；`reset` 后为 `1`。
[清理] 缩放改回 `1`；`DELETE /session/<id>`

---

## 4. 导航命令

### [P4] 验证「新聊天」向 iframe 发送新建会话命令

[Case ID] TC-DSK-L3-148
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/layout/components/webview.tsx:71`；`src/layout/components/navbar.tsx:222-225`
[自动化] 待接线（同上）
[前置条件] 应用处于 `ready`；已安装 `dsh-tauri`
[测试数据] 桥消息 `{ type: 'dsh://session:new' }`；菜单项 id `new-chat`
[测试步骤] 1. 打开「文件」菜单并点击「新聊天」。2. 读取 iframe 侧收到的桥消息。3. 对「打开文件夹」重复（期望 `dsh://workspace:add`）。
[预期结果] 1. 点击被接受。2. iframe 侧收到 `type` 为 `dsh://session:new` 的消息。3. 第二次收到 `type` 为 `dsh://workspace:add` 的消息。
[清理] `DELETE /session/<id>`

---

## 5. 选择器契约（待补）

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-shell-iframe` | 当前窗口内的 iframe | 待补 |

---

## 6. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 新建窗口 | 142、144 | 正向 / 边界 | 建窗失败分支（`WINDOW_CREATE_FAILED`）**未覆盖** |
| 窗口隔离 | 143、145 | 正向 / 异常 | 两窗口并发操作同一档案时的状态一致性**未覆盖** |
| 缩放快捷键 | 146 | 正向 | 增大/减小快捷键未逐条覆盖（与桥消息同源） |
| 缩放桥 | 147 | 正向 | 非法 `action` 被忽略的分支**未覆盖** |
| 导航命令 | 148 | 边界 | 只断言消息发出，未断言 iframe 内实际新建会话 |
| 平台缩放降级 | — | — | macOS < 11 不支持 `pageZoom` 的分支**未覆盖**（与 `13` G-D13-4 同源） |

---

## 7. 缺口与假设

- **G-D19-1**：TC-DSK-L3-145 关闭第二个窗口时，若实现把「最后一个窗口关闭」与「应用退出」绑定，则该用例会终止会话。需先确认 `RunEvent::ExitRequested` 的判定条件（`src-tauri/src/lib.rs:51` 附近），再决定清理顺序。
- **G-D19-2**：多窗口共享同一 DSH 服务，因此两窗口并发写同一档案（如同时改设置）时的一致性**未覆盖**，属高价值补充项。
- **G-D19-3**：缩放的实际视觉系数无回读接口（`use-zoom-factor.ts:20-26`），本文件以 `window.innerWidth` 作为代理指标。该代理在极端缩放（`0.5`/`2.0`）下仍应成立，但属近似断言（`00-overview.md` G10）。
- **G-D19-4**：TC-DSK-L3-148 只断言宿主发出了桥消息；iframe 内是否真的新建会话取决于 `dsh-tauri` 的接收实现，归 [插件用例集](../plugins/00-overview.md)。
- **假设**：额外窗口与主窗口共享同一前端产物与同一 WebView 数据目录，因此缩放设置与语言设置在窗口间一致。
