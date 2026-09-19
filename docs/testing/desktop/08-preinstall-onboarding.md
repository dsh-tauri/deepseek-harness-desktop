# 预装插件引导

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/desktop/08-preinstall-onboarding.e2e.ts`（待建立）
> 前置：`07-harness-lifecycle.md` 通过；可构造首次启动态（预装标记未完成）
> 运行：`vitest --project desktop -- test/e2e/desktop/08-preinstall-onboarding.e2e.ts`（待配置，见 G2）

首次启动（或老版本升级）后，应用先进入预装引导页，由用户确认要安装/卸载哪些推荐插件，再继续启动服务。本文件的重点是**默认勾选的推导**与**失败后的可见反馈**——引导页是用户遇到的第一屏，静默失败会直接卡死首次体验。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| `status === 'preinstall'` 时渲染 `PreinstallSetup` | `src/layout/components/webview.tsx:56-57` |
| 进入页面即拉取插件列表（仅挂载一次） | `src/layout/components/setup-preinstall.tsx:157-159` |
| 默认勾选规则 `initialCheckedSet(plugins, isFirstTime)` | `src/layout/components/setup-preinstall.tsx:30-39` |
| 首次引导：已安装 + 推荐/修复/默认勾选；非首次：仅已安装 | `src/layout/components/setup-preinstall.tsx:26-29` |
| 首次交互以默认集合为种子（取消一个不会误伤其余） | `src/layout/components/setup-preinstall.tsx:168-184` |
| 变更推导：选中且未安装 → 安装；已安装且未选中 → 卸载 | `src/layout/components/setup-preinstall.tsx:192-201` |
| `hasChanges` 决定主按钮是「确定」还是「跳过」 | `src/layout/components/setup-preinstall.tsx:207-210`、`:284-313` |
| 已安装但取消勾选 → 「待卸载」标签 | `src/layout/components/setup-preinstall.tsx:75-79`、`:261` |
| 安装中：Spinner + 日志面板 + 取消入口 | `src/layout/components/setup-preinstall.tsx:344-366` |
| 安装失败：错误块 + 日志 + 跳过/重试 | `src/layout/components/setup-preinstall.tsx:317-342` |
| 列表加载失败：错误块 + 重试（区别于空列表） | `src/layout/components/setup-preinstall.tsx:231-250` |
| 空列表：`Empty` | `src/layout/components/setup-preinstall.tsx:252-256` |
| 仓库跳转 `open_preinstall_repo` | `src/layout/components/setup-preinstall.tsx:186-190` |
| 日志面板上限 100 行 | `src/layout/components/setup-preinstall.tsx:130-132` |

---

## 2. 列表与默认勾选

### [P1] 验证首次启动进入预装引导页并列出插件

[Case ID] TC-DSK-L3-053
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/webview.tsx:56-57`；`src/layout/components/setup-preinstall.tsx:157-159`
[自动化] 待接线（`test/e2e/desktop/08-preinstall-onboarding.e2e.ts`）
[前置条件] 应用处于 `preinstall` 状态（首次启动）
[测试数据] 选择器 `dsh-preinstall-root`、`dsh-preinstall-row`
[测试步骤] 1. 等待引导页根节点出现。2. 读取插件行数量与每行名称。
[预期结果] 1. 根节点在超时内出现。2. 行数量与后端返回的候选插件数量一致；名称均为非空字符串。
[清理] 结束引导页；`DELETE /session/<id>`

### [P2] 验证首次引导的默认勾选规则

[Case ID] TC-DSK-L3-054
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/setup-preinstall.tsx:30-39`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-053 通过；候选中同时存在「已安装」与「未安装且推荐/修复/默认勾选」两类
[测试数据] 期望勾选集合 = `installed ∪ (recommended ∪ fix ∪ defaultChecked)` 中未安装的部分
[测试步骤] 1. 读取每行的勾选态。2. 与期望集合比对。
[预期结果] 1. 读取成功。2. 勾选集合与期望集合完全一致（未安装且非推荐/修复/默认勾选的项不被勾选）。
[清理] 结束引导页；`DELETE /session/<id>`

### [P2] 验证取消勾选仅影响该项

[Case ID] TC-DSK-L3-055
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/setup-preinstall.tsx:168-184`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-054 通过；默认勾选集合大小 ≥ 2
[测试数据] 目标行：默认勾选集合中的任意一项
[测试步骤] 1. 记录默认勾选集合。2. 取消目标行的勾选。3. 读取全部行的勾选态。
[预期结果] 1. 记录成功。2. 取消成功。3. 仅目标行变为未勾选，其余行保持原勾选态（种子机制生效）。
[清理] 结束引导页；`DELETE /session/<id>`

### [P2] 验证无变更时主按钮为「跳过」且无次要按钮

[Case ID] TC-DSK-L3-056
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/setup-preinstall.tsx:207-210`、`:284-313`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-054 通过；未做任何勾选变更
[测试数据] 选择器 `dsh-preinstall-primary`、`dsh-preinstall-secondary`
[测试步骤] 1. 读取主按钮文本。2. 读取次要按钮存在性。3. 改变任一勾选后再次读取两者。
[预期结果] 1. 主按钮文本为「跳过」语义。2. 次要按钮不存在（无重复入口）。3. 有变更后主按钮变为「确定」语义，次要「跳过」按钮出现。
[清理] 结束引导页；`DELETE /session/<id>`

### [P2] 验证已安装项取消勾选后标记为待卸载

[Case ID] TC-DSK-L3-057
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/layout/components/setup-preinstall.tsx:70-79`、`:260-261`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-053 通过；存在已安装的候选插件
[测试数据] 选择器 `dsh-preinstall-row-to-uninstall`
[测试步骤] 1. 取消某已安装项的勾选。2. 读取该行的标签集合。
[预期结果] 1. 取消成功。2. 出现「待卸载」标签，「已安装」标签消失。
[清理] 恢复勾选；结束引导页；`DELETE /session/<id>`

---

## 3. 安装与失败路径

### [P3] 验证安装中显示加载指示与日志且可取消

[Case ID] TC-DSK-L3-058
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/layout/components/setup-preinstall.tsx:344-366`
[自动化] 待接线（同上）
[前置条件] 存在待安装项（勾选了未安装的插件）；联网
[测试数据] 选择器 `dsh-preinstall-installing`、`dsh-preinstall-logs`、`dsh-preinstall-cancel`
[测试步骤] 1. 点击主按钮触发安装。2. 读取加载指示与日志面板。3. 点击「取消」。
[预期结果] 1. 安装被触发。2. 加载指示存在；日志面板出现且内容随安装推进增长（至少 1 行）。3. 取消按钮可点击，点击后进入「正在取消」状态。
[清理] 等待取消收敛；结束引导页；`DELETE /session/<id>`

### [P3] [反向] 验证安装失败展示错误与日志并可重试

[Case ID] TC-DSK-L3-059
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/layout/components/setup-preinstall.tsx:317-342`
[自动化] 待接线（同上）
[前置条件] 构造安装失败（如指向不可达的插件源或断网）
[测试数据] 选择器 `dsh-preinstall-error`、`dsh-preinstall-logs`、`dsh-preinstall-retry`
[测试步骤] 1. 触发安装并等待失败。2. 读取错误区块与日志面板。3. 读取重试按钮的可用性。
[预期结果] 1. 失败在超时内返回。2. 错误区块存在且文案非空；日志面板存在。3. 存在变更时重试按钮可用。
[清理] 恢复网络/源；结束引导页；`DELETE /session/<id>`

### [P3] [反向] 验证列表加载失败展示错误与重试

[Case ID] TC-DSK-L3-060
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/layout/components/setup-preinstall.tsx:231-250`
[自动化] 待接线（同上）
[前置条件] 构造列表加载失败（区别于返回空列表）
[测试数据] 选择器 `dsh-preinstall-load-error`、`dsh-preinstall-load-retry`
[测试步骤] 1. 进入引导页并等待加载失败。2. 读取错误区块与插件行数量。3. 点击重试。
[预期结果] 1. 失败返回。2. 错误区块存在且包含失败原因文本；插件行数量为 0（不渲染列表）。3. 重试被触发，加载期间按钮禁用。
[清理] 恢复加载条件；结束引导页；`DELETE /session/<id>`

---

## 4. 边界

### [P4] 验证打开插件仓库按钮调用系统浏览器

[Case ID] TC-DSK-L3-061
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/layout/components/setup-preinstall.tsx:186-190`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-053 通过；执行环境允许拉起系统浏览器
[测试数据] 选择器 `dsh-preinstall-open-repo`
[测试步骤] 1. 点击任一行的仓库按钮。2. 等待命令返回。3. 读取控制台错误收集器。
[预期结果] 1. 点击被接受。2. 命令成功返回。3. 收集器为空（无 `open_preinstall_repo` 失败错误）。
[清理] 关闭被拉起的浏览器标签（人工）；结束引导页；`DELETE /session/<id>`

---

## 5. 选择器契约（待补）

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-preinstall-root` | 引导页根节点 | 待补 |
| `dsh-preinstall-row` | 单个插件行 | 待补 |
| `dsh-preinstall-row-to-uninstall` | 「待卸载」标签 | 待补 |
| `dsh-preinstall-primary` | 主操作按钮（确定/跳过） | 待补 |
| `dsh-preinstall-secondary` | 次要「跳过」按钮 | 待补 |
| `dsh-preinstall-installing` | 安装中加载指示 | 待补 |
| `dsh-preinstall-logs` | 日志面板 | 待补 |
| `dsh-preinstall-cancel` | 取消安装按钮 | 待补 |
| `dsh-preinstall-error` | 安装失败错误区块 | 待补 |
| `dsh-preinstall-retry` | 安装失败重试按钮 | 待补 |
| `dsh-preinstall-load-error` | 列表加载失败区块 | 待补 |
| `dsh-preinstall-load-retry` | 列表加载失败重试按钮 | 待补 |
| `dsh-preinstall-open-repo` | 仓库跳转按钮 | 待补 |

---

## 6. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 列表加载（成功/空/失败三态） | 053、060 | 正向 / 异常 | 空列表（`Empty`）分支**未单独覆盖**，需构造无候选插件的清单 |
| 默认勾选推导 | 054、055、057 | 正向 | 非首次打开（`isFirstTime=false`）的规则分支**未覆盖**，需从「插件面板 → 打开预设」进入 |
| 变更推导与按钮切换 | 056 | 正向 | — |
| 安装执行 | 058、059 | 异常 | 安装成功后的插件真实落盘未断言（归 `09` 的列表断言） |
| 仓库跳转 | 061 | 边界 | 只断言命令成功，不校验浏览器实际打开 |

---

## 7. 缺口与假设

- **G-D08-1**：需要「首次启动态」。预装完成标记的存储位置与复位方式未在本次调查中确认；接线时必须先确认该标记的读写路径，否则本文件全部用例不可达。
- **G-D08-2**：TC-DSK-L3-058/059 会真实执行 `dsh plugin` 安装，**改动用户档案的插件集合**。按 `00-overview.md` G8，测试必须使用独立数据目录并自行清理，否则会污染 `09` 的前置状态。
- **G-D08-3**：非首次打开引导页（`isFirstTime=false`，从插件面板「打开预设」进入）的默认勾选规则与首次不同（只勾已安装项），**未覆盖**。该入口在 `src/ui/config/plugin.tsx:405`。
- **G-D08-4**：日志面板的 100 行上限（`setup-preinstall.tsx:130-132`）未覆盖，属展示层边界。
- **假设**：安装过程的日志经 `preinstall-log` 事件实时回流；本文件只断言「日志面板出现且内容增长」，不断言具体日志文本。
