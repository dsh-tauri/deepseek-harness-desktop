# 桌面端自更新内部：静默下载、退出自动安装、版本护栏与摘要校验

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/specs/desktop/28-desktop-update-internals.e2e.ts`（待建立）
> 前置：`16-update.md` 通过；应用处于 `ready`；联网
> 运行：`vitest --project desktop -- test/e2e/specs/desktop/28-desktop-update-internals.e2e.ts`（待配置，见 G2）

`16-update.md` 覆盖的是「看得见的入口」；本文件覆盖入口背后的**自动行为**：发现正式版后静默下载、用户不安装时退出即安装、拉起安装器前的版本护栏与停服、以及安装包的摘要校验与路径守卫。判定不依赖界面自述，而依赖落盘结果、store 标记与系统调用返回。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 命令 `check_desktop_update` / `download_desktop_update` / `open_desktop_installer` / `get_desktop_about` | `src-tauri/src/bridge/updater.rs:11`、`:19`、`:27`、`:33` |
| `fetch_latest_release()` 按 feed 顺序（最新在前）扫描，跳过非法 semver / pre-release / 不高于当前版本 | `src-tauri/src/service/update/meta.rs:161`、`:165-176` |
| `UPDATE_SKIP` 四类跳过原因：非法 semver / pre-release / 不高于当前 / 无当前平台资产 | `src-tauri/src/service/update/meta.rs:166`、`:170`、`:174`、`:200` |
| `Ok(None)` = 无更新或当前平台无匹配资产；网络失败为 `Err` | `src-tauri/src/service/update/meta.rs:159-161`、`:181` |
| 摘要必须按**当前平台选中的资产**解析（不能取页面里第一个可解析的摘要） | `src-tauri/src/service/update/meta.rs:184`、`:204` |
| 摘要缺失不阻断官方直连，但禁用镜像兜底（防投毒） | `src-tauri/src/service/update/meta.rs:24-27`；`src-tauri/src/service/update/install.rs:144-154` |
| 正式版判定 `is_stable`（纯数字，无 pre-release / build metadata） | `src-tauri/src/service/update/version.rs:25-27` |
| 严格更高判定 `is_newer`（`0.7.14 > 0.7.14-rc.1`） | `src-tauri/src/service/update/version.rs:33-38` |
| 安装包存放 `AppData/updates/<asset>`，目录不存在则创建 | `src-tauri/src/service/update/install.rs:23-36` |
| `.part` 临时文件 + 原子改名，避免半成品被误判为「已下载」 | `src-tauri/src/service/update/install.rs:247`、`:270-271`、`:297` |
| 摘要存在则强制校验，失败即删除半成品并拒绝 | `src-tauri/src/service/update/install.rs:289-295`；`:178`、`:202-206` |
| 多源全失败错误 `UPDATE_DOWNLOAD: …（已尝试 N 个下载源）` | `src-tauri/src/service/update/install.rs:280-285` |
| 路径守卫：`UPDATE_PATH_REJECTED`（越界）/ `UPDATE_NOT_FOUND`（不存在） | `src-tauri/src/service/update/install.rs:316-337`、`:333`、`:347` |
| 待安装标记 `PendingInstaller { path, version }` 存于独立 store 键 | `src-tauri/src/service/update/pending.rs:34`、`:41-49` |
| 键名 `desktop_pending_installer`，刻意不放进 `Setting`（前端会整对象写回） | `src-tauri/src/config/constants.rs:104`；`src-tauri/src/service/update/pending.rs:6-9` |
| 退出路径 `RunEvent::Exit` → `launch_pending_installer` | `src-tauri/src/lib.rs:57-67`；`src-tauri/src/service/update/pending.rs:82` |
| 版本护栏：待安装版本不高于当前运行版本则记录并跳过 | `src-tauri/src/service/update/pending.rs:88-99` |
| 拉起前先清标记（无论能否打开都不再反复尝试） | `src-tauri/src/service/update/pending.rs:86-88` |
| 拉起前 `workflow::stop_for_installer`，避免 Harness 孤儿占端口 | `src-tauri/src/service/update/pending.rs:106-111`；`src-tauri/src/service/workflow/process.rs:493-501` |
| 对话框「立即更新」路径同样先停服再打开 | `src-tauri/src/service/update/install.rs:412-416`、`:419` |
| 前端轮询间隔 `DESKTOP_UPDATE_POLL_INTERVAL = 10 * 60_000`，启动即检查一次 | `src/layout/index.tsx:21`、`:88-89` |
| 轮询失败静默（`.catch(() => {})`），不打扰用户 | `src/layout/index.tsx:86` |
| 「帮助 → 检查更新」三态：有更新弹框 / 无更新「已是最新」/ 失败危险提示 | `src/layout/components/navbar.tsx:283-295` |
| 「更新可用」chip 与帮助菜单打开同一对话框 | `src/layout/components/navbar.tsx:531-541` |
| 静默下载：`check()` 命中即 `void this.download()`，失败只 `console.error` | `src/store/modules/desktop-updater/store.ts:57-64`、`:94-96` |
| 在途下载单飞（模块级 `downloadTask` 复用） | `src/store/modules/desktop-updater/store.ts:16`、`:82-83` |
| 进度事件 `desktop-update-progress` 写入 store，仅对话框渲染 | `src/store/modules/desktop-updater/store.ts:168-176`；`src/ui/dialog/update.tsx:71-86` |
| 对话框主按钮：已下载→直接打开；未下载→等待/发起下载后打开 | `src/ui/dialog/update.tsx:33-46`、`:96-105` |

---

## 2. 正常路径

### [P2] 验证启动即检查一次并按 10 分钟间隔轮询

[Case ID] TC-DSK-L3-248
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/index.tsx:21`、`:88-89`
[自动化] 待接线（`test/e2e/specs/desktop/28-desktop-update-internals.e2e.ts`）
[前置条件] 应用可启动到 `ready`；已具备统计 `check_desktop_update` 调用次数的编排手段
[测试数据] 观察点：`check_desktop_update` 调用记录；轮询间隔常量 `600000`
[测试步骤] 1. 启动应用并等待壳层就绪。2. 读取启动后第一次更新检查的时机与次数。3. 把编排层时钟推进到下一个轮询周期并再次读取次数。
[预期结果] 1. 壳层就绪。2. 启动后立即发生一次检查，此前无重复触发。3. 下一次检查落在启动检查之后 10 分钟，间隔内无额外触发。
[清理] 恢复时钟；`DELETE /session/<id>`

### [P1] 验证发现正式版后无用户操作即静默下载

[Case ID] TC-DSK-L3-249
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/store/modules/desktop-updater/store.ts:57-64`、`:81-103`；`src-tauri/src/service/update/install.rs:23-36`、`:305`
[自动化] 待接线（`test/e2e/specs/desktop/28-desktop-update-internals.e2e.ts`）
[前置条件] 已构造「存在更高正式版且当前平台有匹配资产」的更新结果；`AppData/updates` 内无该安装包
[测试数据] 选择器 `dsh-navbar-update-chip`；观察点 `AppData/updates/<asset>` 落盘
[测试步骤] 1. 触发一次更新检查。2. 不做任何用户操作，等待下载收敛。3. 读取安装包落盘与 `updateInfo.downloaded`。
[预期结果] 1. 检查返回非空更新信息。2. 下载在无用户操作下完成。3. 安装包位于 `AppData/updates/<asset>` 且 `downloaded` 为 `true`。
[清理] 删除构造的安装包；清除构造的更新结果；`DELETE /session/<id>`

### [P2] 验证已下载未安装时退出应用自动拉起安装器

[Case ID] TC-DSK-L3-250
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/lib.rs:57-67`；`src-tauri/src/service/update/pending.rs:82-83`、`:101-114`
[自动化] 待接线（`test/e2e/specs/desktop/28-desktop-update-internals.e2e.ts`）
[前置条件] `AppData/updates` 内存在安装包且 store 中 `desktop_pending_installer` 标记版本高于当前运行版本；应用处于 `ready`
[测试数据] 观察点：store 键 `desktop_pending_installer`；安装器进程/`UPDATE_OPEN` 告警
[测试步骤] 1. 读取标记与安装包的存在性。2. 用托盘或导航栏退出应用（完整退出语义）。3. 读取退出全过程日志与标记状态。
[预期结果] 1. 标记与安装包均存在。2. 应用退出完成。3. 出现「Launching pending desktop installer on exit」记录，且标记已被清除。
[清理] 删除构造的安装包与标记；`DELETE /session/<id>`

### [P2] 验证打开安装包前先释放 Harness 端口

[Case ID] TC-DSK-L3-251
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/update/pending.rs:106-111`；`src-tauri/src/service/update/install.rs:412-416`；`src-tauri/src/service/workflow/process.rs:493-501`
[自动化] 待接线（`test/e2e/specs/desktop/28-desktop-update-internals.e2e.ts`）
[前置条件] Harness 服务运行中且由本应用持有；已下载安装包；配置端口已记录
[测试数据] 选择器 `dsh-update-dialog-install`；观察点：harness 子进程 pid、配置端口占用、`.harness.pid` 标记
[测试步骤] 1. 记录 harness 子进程 pid、配置端口与 `.harness.pid` 标记。2. 通过对话框「立即更新」打开安装包。3. 重新读取 pid 存活性、端口占用与标记。
[预期结果] 1. 记录成功。2. 安装包被交给系统默认处理器（命令成功返回）。3. 原 harness 进程已结束，配置端口已释放，`.harness.pid` 标记已清除。
[清理] 重新拉起服务；关闭被系统拉起的安装器（人工）；`DELETE /session/<id>`

---

## 3. 异常与边界

### [P3] [反向] 验证静默下载失败不弹用户可见提示

[Case ID] TC-DSK-L3-252
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/store/modules/desktop-updater/store.ts:94-96`、`:140`；`src/layout/index.tsx:86`
[自动化] 待接线（`test/e2e/specs/desktop/28-desktop-update-internals.e2e.ts`）
[前置条件] 已构造「检查成功但下载必然失败」的更新结果（资产不可达）
[测试数据] 观察点：壳层可见提示区、控制台错误收集器、`updateInfo.downloaded`
[测试步骤] 1. 触发静默下载。2. 等待下载失败返回。3. 读取壳层可见提示与 `downloaded`。
[预期结果] 1. 下载被发起。2. 失败在超时内返回并写入控制台日志。3. 无面向用户的提示或弹窗；`downloaded` 仍为 `false`。
[清理] 恢复更新源；清除构造的更新结果；`DELETE /session/<id>`

### [P4] 验证在途下载单飞不重复发起

[Case ID] TC-DSK-L3-253
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/store/modules/desktop-updater/store.ts:16`、`:82-83`
[自动化] 待接线（`test/e2e/specs/desktop/28-desktop-update-internals.e2e.ts`）
[前置条件] 更新信息已就绪且安装包未下载；已具备统计 `download_desktop_update` 调用次数的编排手段
[测试数据] 触发方式：检查返回后立即再次触发 `download()`
[测试步骤] 1. 触发一次静默下载。2. 在该下载完成前再次触发下载。3. 等待下载收敛后读取调用次数。
[预期结果] 1. 首次下载被发起。2. 第二次触发复用同一在途任务。3. `download_desktop_update` 调用次数为 1。
[清理] 删除构造的安装包；`DELETE /session/<id>`

### [P4] 验证下载进度仅在更新对话框内展示

[Case ID] TC-DSK-L3-254
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/store/modules/desktop-updater/store.ts:168-176`；`src/ui/dialog/update.tsx:71-86`
[自动化] 待接线（`test/e2e/specs/desktop/28-desktop-update-internals.e2e.ts`）
[前置条件] 安装包正在下载中
[测试数据] 选择器 `dsh-navbar-update-chip`、`dsh-update-dialog`、`dsh-update-dialog-progress`
[测试步骤] 1. 让下载处于进行中。2. 打开更新对话框并读取进度展示。3. 关闭对话框后再次读取页面中的进度展示。
[预期结果] 1. 下载进行中。2. 对话框内出现进度条与百分比，随事件更新。3. 关闭后主界面不残留进度展示。
[清理] 等待下载收敛并删除安装包；`DELETE /session/<id>`

### [P3] [反向] 验证待安装版本不高于运行版本时退出不拉起安装器

[Case ID] TC-DSK-L3-255
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/update/pending.rs:88-99`；`src-tauri/src/service/update/version.rs:33-38`
[自动化] 待接线（`test/e2e/specs/desktop/28-desktop-update-internals.e2e.ts`）
[前置条件] 可直接构造 store 键 `desktop_pending_installer`；已下载安装包存在；标记版本等于当前运行版本
[测试数据] 标记 `{ path: <updates 内安装包>, version: <当前版本> }`
[测试步骤] 1. 写入 `version` 等于当前运行版本的待安装标记。2. 退出应用。3. 读取日志与安装器拉起痕迹。
[预期结果] 1. 标记写入成功。2. 应用退出完成。3. 出现「is not newer than running … skipping auto update」记录，且未拉起安装器（避免降级安装）。
[清理] 删除构造的标记与安装包；`DELETE /session/<id>`

### [P3] [反向] 验证退出拉起前先清除待安装标记

[Case ID] TC-DSK-L3-256
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/update/pending.rs:86-88`、`:112-114`；`src-tauri/src/service/update/install.rs:347`
[自动化] 待接线（`test/e2e/specs/desktop/28-desktop-update-internals.e2e.ts`）
[前置条件] 可构造 store 键 `desktop_pending_installer`；标记指向一个不存在的安装包路径
[测试数据] 标记 `{ path: <不存在的路径>, version: <高于当前版本> }`
[测试步骤] 1. 写入指向不存在路径的待安装标记。2. 退出应用。3. 读取退出日志与 store 中的标记状态。
[预期结果] 1. 标记写入成功。2. 出现打开失败的告警记录（`UPDATE_NOT_FOUND` 路径）。3. 标记已被清除，后续退出不再尝试。
[清理] 删除构造的标记；`DELETE /session/<id>`

### [P3] [反向] 验证摘要不匹配时删除半成品并拒绝安装

[Case ID] TC-DSK-L3-257
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/update/install.rs:289-295`、`:178`、`:202-206`
[自动化] 待接线（`test/e2e/specs/desktop/28-desktop-update-internals.e2e.ts`）
[前置条件] 已构造摘要与安装包内容不一致的更新结果（资产页摘要与文件字节不符）
[测试数据] 观察点：`AppData/updates/<asset>.part`、`AppData/updates/<asset>`、`desktop_pending_installer`
[测试步骤] 1. 触发下载。2. 等待校验结果返回。3. 读取 `updates` 目录内容、错误文本与待安装标记。
[预期结果] 1. 下载被发起。2. 校验失败并返回 `INTEGRITY_CHECK_FAILED` 语义错误。3. `.part` 半成品已删除，最终路径不存在可安装文件，且未登记待安装标记。
[清理] 清理构造的摘要源与残留文件；`DELETE /session/<id>`

### [P3] [反向] 验证无可信摘要时不启用镜像兜底

[Case ID] TC-DSK-L3-258
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src-tauri/src/service/update/install.rs:144-154`、`:240-246`、`:280-285`；`src-tauri/src/service/update/meta.rs:24-27`
[自动化] 待接线（`test/e2e/specs/desktop/28-desktop-update-internals.e2e.ts`）
[前置条件] 已构造「资产页无 `sha256`」的更新结果，并使官方直连不可达
[测试数据] 观察点：错误文本中的「已尝试 N 个下载源」与镜像源请求记录
[测试步骤] 1. 触发下载。2. 等待失败返回。3. 读取错误文本与网络请求记录。
[预期结果] 1. 下载被发起。2. 失败在超时内返回。3. 错误提示已尝试 1 个下载源；记录「mirror fallback disabled」，未向 ghfast.top 发出请求。
[清理] 恢复更新源与网络；清除构造的更新结果；`DELETE /session/<id>`

### [P4] 验证安装包路径越界与不存在均被拒绝

[Case ID] TC-DSK-L3-259
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src-tauri/src/service/update/install.rs:316-337`、`:333`、`:347`、`:373-374`
[自动化] 待接线（`test/e2e/specs/desktop/28-desktop-update-internals.e2e.ts`）
[前置条件] 更新信息已就绪；可在 `updates` 目录外放置一个可执行文件；可构造 `updates` 目录内的不存在路径
[测试数据] 路径 A：`updates` 目录之外的文件；路径 B：`AppData/updates/<不存在的文件名>`
[测试步骤] 1. 调用「打开安装包」传入路径 A。2. 调用「打开安装包」传入路径 B。3. 读取两次调用的错误文本与系统处理器拉起痕迹。
[预期结果] 1. 拒绝并返回 `UPDATE_PATH_REJECTED: installer path is outside updates directory`。2. 拒绝并返回 `UPDATE_NOT_FOUND: {path}`。3. 两次调用均未把文件交给系统默认处理器。
[清理] 删除构造的路径 A 文件；`DELETE /session/<id>`

---

## 4. 选择器契约（待补）

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-navbar-update-chip` | 「更新可用」Chip（与 `16` 共用） | 待补 |
| `dsh-update-dialog` | 更新对话框根节点（与 `16` 共用） | 待补 |
| `dsh-update-dialog-install` | 主按钮「立即更新」/「打开安装包」（与 `16` 共用） | 待补 |
| `dsh-update-dialog-progress` | 下载进度区（进度条 + 百分比） | 待补 |
| `dsh-update-dialog-state` | 已下载/下载中状态描述文本 | 待补 |

---

## 5. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 检测与轮询 | 248 | 正向 | 10 分钟轮询间隔在真实时钟下不可等待，见 G-D28-2 |
| 静默下载 | 249、252、253、254 | 正向 / 异常 / 边界 | 下载中断（`.part` 残留后再重试）**未覆盖** |
| 退出自动安装 | 250、255、256 | 正向 / 异常 | 只断言标记清除与日志；系统安装器实际启动属系统表面，见 G-D28-4 |
| 交付前停服 | 251 | 正向 | 停服失败分支（`stop` 返回 Err 只告警，`install.rs:413-415`）**未覆盖** |
| 完整性校验 | 257、258 | 异常 | 校验通过路径由 249 间接覆盖；裸 64hex 摘要格式未单列 |
| 路径守卫 | 259 | 边界 | 符号链接指向 `updates` 外的场景未构造 |
| 版本选择规则 | 249、257、258（间接） | — | 资产选择/架构排序归 `16` 与单元测试，见 G-D28-6 |

---

## 6. 缺口与假设

- **G-D28-1**：多数用例需要「可控的更新结果」（有更高正式版 / 无摘要 / 摘要不匹配 / 资产不可达）。按 `00-overview.md` §2 第 7 条，E2E 层禁止 Mock 后端命令，因此只能引入**替身更新源**（本地 HTTP 服务）并改写 `REPO_URL` 可达性；真实检查还会触发 GitHub 未认证限流（`src/layout/index.tsx:20-21`），接线前必须解决。
- **G-D28-2**：TC-DSK-L3-248 需要推进编排层时钟才能验证 10 分钟轮询间隔。当前无该能力时，本用例只能退化为断言「启动即检查一次」（`src/layout/index.tsx:88-89`）。
- **G-D28-3**：TC-DSK-L3-248 与 TC-DSK-L3-253 需要统计 `check_desktop_update` / `download_desktop_update` 的调用次数，当前无计数出口（同 `07` 的 G-D07-1），需在测试编排层计数或增加只读诊断命令。
- **G-D28-4**：TC-DSK-L3-250 只断言标记被清除与日志记录，**不验证系统安装器实际启动**（属系统表面，见 `00-overview.md` G9）。人工确认项。
- **G-D28-5**：摘要校验与路径守卫用例需要在 `AppData/updates` 内伪造/篡改文件，并在测后清理；不得触碰用户真实下载的安装包（`00-overview.md` G8）。
- **G-D28-6**：`pending.rs` 写入 store 失败只告警（`:56-59`、`:72-74`），「store 不可写 → 退出时不自动更新」的降级分支**未覆盖**。
- **G-D28-7**：资产选择规则（扩展名优先级、架构匹配、macOS Rosetta 宿主探测）为纯函数，已在 `src-tauri/src/service/update/version.rs` 的单元测试覆盖，本套不重复。
- **假设**：`check_desktop_update` 返回非空即「有更新」，返回空或抛错分别对应「无更新」与「检查失败」（同 `16-update.md` 假设）；本文件不重复 `16` 已覆盖的界面三态呈现。
