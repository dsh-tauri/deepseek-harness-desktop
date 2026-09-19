# 通知与下载

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/desktop/18-notification-download.e2e.ts`（待建立）
> 前置：`06-harness-embed.md` 通过；应用处于 `ready`
> 运行：`vitest --project desktop -- test/e2e/desktop/18-notification-download.e2e.ts`（待配置，见 G2）

三条桥都发生在 **iframe → 宿主**方向：原生通知、下载完成提示、剪贴板图片回退（Linux/WebKitGTK 下 iframe 的 paste 事件拿不到图片，走原生通路）。系统表面的实际呈现无法在页面内断言，因此多数用例止于「桥接层成功返回」。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 通知桥 `dsh://native-notification` → `show_native_notification` | `src/layout/components/iframe.tsx:88-92`、`:130-140` |
| 通知载荷字段 `title`/`body`/`tag`/`sessionId`/`requireInteraction` | `src/layout/components/iframe.tsx:28-46`、`:131-138` |
| 通知权限在页面加载时注册（Windows 走 `on_page_load`） | `src-tauri/src/desktop/window.rs:109-138` |
| 通知点击 → 宿主向 iframe 发 `dsh://focus-session` | `src/layout/components/iframe.tsx:80-84`、`:177-184` |
| 下载接管与重名处理 `unique_download_path` | `src-tauri/src/desktop/window.rs:39-45`；`src-tauri/src/config/utils.rs:29` |
| 下载完成事件 `harness-download-finished` | `src-tauri/src/desktop/window.rs:46-61` |
| 外壳订阅并弹 toast（成功/失败分支） | `src/layout/index.tsx:94-126` |
| 成功且路径非空时提供「在文件夹中显示」 | `src/layout/index.tsx:109-121` |
| 「在文件夹中显示」→ `reveal_in_folder` | `src/layout/index.tsx:116` |
| 新下载完成时关闭上一条同源 toast | `src/layout/index.tsx:97-98`、`:122-124` |
| 剪贴板图片桥 `dsh://clipboard-image:read` → `read_clipboard_image` | `src/layout/components/iframe.tsx:98-101`、`:156-169` |
| 回包 `source: 'dsh://clipboard-image:reply'` | `src/layout/components/iframe.tsx:160-162` |
| 打开外部链接（`window.open` / `target=_blank`） | `src-tauri/src/desktop/window.rs:22-35` |

---

## 2. 通知

### [P1] 验证通知桥转发到原生通知命令

[Case ID] TC-DSK-L3-135
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/iframe.tsx:88-92`、`:130-140`；`src-tauri/src/desktop/window.rs:110-138`
[自动化] 待接线（`test/e2e/desktop/18-notification-download.e2e.ts`）
[前置条件] 应用处于 `ready`；通知权限已在页面加载时注册
[测试数据] 桥消息 `{ type: 'dsh://native-notification', title, body, tag, sessionId, requireInteraction }`
[测试步骤] 1. 由 iframe 侧发出通知桥消息。2. 等待宿主处理。3. 读取控制台错误收集器。
[预期结果] 1. 消息发出成功。2. `show_native_notification` 成功返回。3. 收集器为空（无命令失败错误）。
[清理] 关闭系统通知（若可行）；`DELETE /session/<id>`

### [P4] 验证点击系统通知后 iframe 聚焦对应会话

[Case ID] TC-DSK-L3-136
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/layout/components/iframe.tsx:80-84`、`:177-184`；`src-tauri/src/desktop/notification.rs`
[自动化] 否（手工；需点击系统通知）
[前置条件] 已通过通知桥弹出一条带 `sessionId` 的系统通知
[测试数据] 桥消息 `{ type: 'dsh://focus-session', sessionId }`
[测试步骤] 1. 点击系统通知。2. 观察 iframe 内是否切换到该 `sessionId` 对应的会话。
[预期结果] 1. 通知被点击。2. iframe 内切换到对应会话（宿主已发出 `dsh://focus-session`）。
[清理] 关闭通知

---

## 3. 下载

### [P2] 验证下载完成后弹出已保存提示并显示路径

[Case ID] TC-DSK-L3-137
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/index.tsx:94-126`；`src-tauri/src/desktop/window.rs:39-61`
[自动化] 待接线（同上）
[前置条件] 应用处于 `ready`；可从 iframe 内触发一次下载
[测试数据] 选择器 `dsh-toast-download`、`dsh-toast-download-path`、`dsh-toast-download-action`
[测试步骤] 1. 触发一次下载。2. 等待下载完成事件。3. 读取提示节点、路径文本与操作入口。4. 比对路径与磁盘实际文件。
[预期结果] 1. 下载被触发。2. 完成事件到达。3. 出现「已保存」提示；路径文本包含实际落盘绝对路径；存在「在文件夹中显示」入口。4. 该路径上确实存在文件。
[清理] 删除下载的文件；关闭提示；`DELETE /session/<id>`

### [P3] [反向] 验证下载失败时提示失败且无打开文件夹入口

[Case ID] TC-DSK-L3-138
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/layout/index.tsx:100-121`
[自动化] 待接线（同上）
[前置条件] 构造下载失败（如不可达的下载地址）
[测试数据] 选择器 `dsh-toast-download`、`dsh-toast-download-action`
[测试步骤] 1. 触发下载并等待失败。2. 读取提示文案。3. 读取操作入口存在性。
[预期结果] 1. 失败返回。2. 提示为「下载失败」语义。3. 操作入口不存在（不提供指向空路径的入口）。
[清理] 关闭提示；`DELETE /session/<id>`

### [P3] 验证重名文件自动追加序号

[Case ID] TC-DSK-L3-139
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/desktop/window.rs:41-44`；`src-tauri/src/config/utils.rs:29`
[自动化] 待接线（同上）
[前置条件] 下载目录中已存在同名文件
[测试数据] 已占用文件名 `e2e-download.txt`
[测试步骤] 1. 在下载目录创建 `e2e-download.txt` 并记录其内容。2. 触发同名下载。3. 等待完成并读取提示中的路径。4. 读取原文件内容。
[预期结果] 1. 创建成功。2. 下载完成。3. 落盘路径不等于 `e2e-download.txt`，而是形如 `e2e-download (1).txt`。4. 原文件内容未被覆盖。
[清理] 删除测试创建的两个文件；关闭提示；`DELETE /session/<id>`

### [P4] 验证「在文件夹中显示」调用系统文件管理器

[Case ID] TC-DSK-L3-140
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/layout/index.tsx:112-119`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-137 通过（提示与路径均存在）
[测试数据] 选择器 `dsh-toast-download-action`
[测试步骤] 1. 点击「在文件夹中显示」。2. 读取控制台错误收集器与提示存在性。
[预期结果] 1. 点击被接受。2. 无 `reveal_in_folder` 失败错误。3. 提示被关闭。
[清理] 关闭被拉起的文件管理器窗口；`DELETE /session/<id>`

---

## 4. 剪贴板图片回退

### [P2] 验证剪贴板图片读取请求返回 PNG data URL

[Case ID] TC-DSK-L3-141
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/iframe.tsx:98-101`、`:156-169`
[自动化] 待接线（同上）
[前置条件] 系统剪贴板中已放入一张图片
[测试数据] 桥消息 `{ type: 'dsh://clipboard-image:read', id }`
[测试步骤] 1. 由 iframe 侧发出读取请求。2. 等待回包。3. 读取回包内容。
[预期结果] 1. 请求发出成功。2. 回包到达。3. 回包 `source` 为 `dsh://clipboard-image:reply`，`id` 与请求一致，`data_url` 以 `data:image/png` 开头。
[清理] 清空剪贴板；`DELETE /session/<id>`

---

## 5. 选择器契约（待补）

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-toast-download` | 下载完成/失败提示 | 待补 |
| `dsh-toast-download-path` | 提示中的落盘路径 | 待补 |
| `dsh-toast-download-action` | 「在文件夹中显示」按钮 | 待补 |

---

## 6. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 通知桥转发 | 135 | 正向 | 系统通知的**实际呈现**未验证（属系统表面） |
| 通知点击回焦 | 136 | 边界 | 需点击系统通知，标为手工 |
| 下载成功提示 | 137、140 | 正向 / 边界 | — |
| 下载失败 | 138 | 异常 | — |
| 重名处理 | 139 | 异常 | `(n)` 序号递增到多位的分支**未覆盖** |
| 剪贴板图片回退 | 141 | 正向 | 剪贴板为空的返回分支（`data_url: null`）**未覆盖** |
| 外部链接接管 | — | — | `on_new_window` 的 http(s) 打开与非 http 拒绝两条分支**未覆盖** |
| 连续下载的 toast 复用 | — | — | 关闭上一条同源 toast（`index.tsx:97-98`）**未覆盖** |

---

## 7. 缺口与假设

- **G-D18-1**：系统通知与文件管理器的实际呈现无法通过 WebDriver 断言（`00-overview.md` G9）。TC-DSK-L3-135 只证明桥接层与命令调用成功；**「用户真的看到通知」未被证明**。
- **G-D18-2**：TC-DSK-L3-137 需要「从 iframe 内触发下载」。若 iframe 内无稳定的下载入口，接线时需引入一个测试用的下载链接，并注明这是对真实下载路径的替身。
- **G-D18-3**：`on_new_window`（外部链接接管）是安全边界（只放行 http/https），**未覆盖**。该分支可通过 iframe 内 `window.open('javascript:...')` 构造，属高价值补充项。
- **G-D18-4**：剪贴板图片回退主要为 Linux/WebKitGTK 设计（`iframe.tsx:97-98`），在 Windows 上该路径不会被真实触发。接线时需按平台决定是否跳过。
- **假设**：下载默认保存到系统下载目录（`window.rs:39-44` 的 `destination`）；本文件按该目录读取与清理文件。
