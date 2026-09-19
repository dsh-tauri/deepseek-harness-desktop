# 备份与还原

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/specs/desktop/15-backup-restore.e2e.ts`（待建立）
> 前置：`05-profile.md` 通过；配置对话框可打开在「档案」面板
> 运行：`vitest --project desktop -- test/e2e/specs/desktop/15-backup-restore.e2e.ts`（待配置，见 G2）

备份子视图从「档案」面板的「备份」Chip 进入。**还原会改写 profile 目录**，因此先停服务、轮询确认已停止、再还原、最后自动拉起服务。本文件覆盖创建、还原（覆盖 / 为新档案）、删除三条写路径。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 从档案行进入备份子视图 | `src/ui/config/profile.tsx:241-245`、`:285-294` |
| 返回入口 | `src/ui/config/backup.tsx:176-179` |
| 创建备份（可选包含凭据） | `src/ui/config/backup.tsx:60-69` |
| 勾选凭据时显示危险警告 | `src/ui/config/backup.tsx:213-217` |
| 还原：先确认 → 停服务 → 轮询确认停止 → 还原 → 自动拉起 | `src/ui/config/backup.tsx:71-119` |
| 停服轮询 `waitForHarnessStopped`（10s 上限 / 500ms 间隔） | `src/ui/config/backup.tsx:31-51` |
| 「还原为新档案」不覆盖当前档案 | `src/ui/config/backup.tsx:121-145` |
| 删除备份需危险确认 | `src/ui/config/backup.tsx:147-172` |
| 空列表空态（标题 + 说明） | `src/ui/config/backup.tsx:223-288` |
| 备份行展示时间戳与大小（MB，1 位小数） | `src/ui/config/backup.tsx:20-23`、`:228-241` |
| `busy` 期间全部写入口禁用 | `src/ui/config/backup.tsx:55`、`:187`、`:248` |
| 还原后 toast 提供「重启」入口 | `src/ui/config/backup.tsx:103-113` |

---

## 2. 视图与创建

### [P1] 验证从档案进入备份子视图

[Case ID] TC-DSK-L3-113
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/config/profile.tsx:241-245`、`:285-294`
[自动化] 待接线（`test/e2e/specs/desktop/15-backup-restore.e2e.ts`）
[前置条件] 「档案」面板已渲染
[测试数据] 选择器 `dsh-profile-backup`、`dsh-backup-back`
[测试步骤] 1. 点击某档案行的「备份」Chip。2. 读取备份视图根节点与返回入口。
[预期结果] 1. 点击被接受（不触发档案切换）。2. 备份视图出现（含「手动备份」与「备份列表」两个区块）；返回入口存在。
[清理] 关闭对话框；`DELETE /session/<id>`

### [P1] 验证创建备份后列表出现新项

[Case ID] TC-DSK-L3-114
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/config/backup.tsx:60-69`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-113 通过
[测试数据] 选择器 `dsh-backup-create`、`dsh-backup-row`
[测试步骤] 1. 记录当前备份行数量。2. 点击「立即备份」。3. 等待完成并读取行数量与最新行的时间戳与大小。
[预期结果] 1. 记录成功。2. 点击被接受，按钮出现进行中指示。3. 行数量比记录值多 1；最新行时间戳非空且可解析，大小大于 0，并出现创建成功提示。
[清理] 删除本次创建的备份；关闭对话框；`DELETE /session/<id>`

### [P2] 验证勾选凭据时显示风险警告

[Case ID] TC-DSK-L3-115
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/config/backup.tsx:198-217`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-113 通过
[测试数据] 选择器 `dsh-backup-include-credentials`、`dsh-backup-credentials-warning`
[测试步骤] 1. 读取警告节点存在性。2. 勾选「包含凭据」。3. 再次读取警告节点。
[预期结果] 1. 警告节点不存在。2. 勾选成功。3. 警告节点存在且为危险语义文案。
[清理] 取消勾选；关闭对话框；`DELETE /session/<id>`

### [P4] 验证返回入口回到档案列表

[Case ID] TC-DSK-L3-116
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/ui/config/backup.tsx:176-179`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-113 通过
[测试数据] 选择器 `dsh-backup-back`
[测试步骤] 1. 点击返回。2. 读取档案列表根节点与备份视图根节点。
[预期结果] 1. 点击被接受。2. 档案列表出现；备份视图消失。
[清理] 关闭对话框；`DELETE /session/<id>`

---

## 3. 还原

### [P3] 验证还原前需确认并停止服务

[Case ID] TC-DSK-L3-117
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/ui/config/backup.tsx:71-119`
[自动化] 待接线（同上）
[前置条件] 备份列表至少 1 项；服务处于运行中
[测试数据] 选择器 `dsh-backup-restore`
[测试步骤] 1. 点击某项的「还原」。2. 读取确认框。3. 取消后读取服务状态。4. 再次点击并确认，读取服务状态与提示。
[预期结果] 1. 确认框出现（危险语义）且包含该备份时间戳。2. 确认框存在。3. 取消后服务仍在运行、档案未变化。4. 确认后服务被停止（连接状态非运行中），出现「已停止服务」提示。
[清理] 重新拉起服务；关闭对话框；`DELETE /session/<id>`

### [P3] 验证「还原为新档案」不覆盖当前档案

[Case ID] TC-DSK-L3-118
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/ui/config/backup.tsx:121-145`
[自动化] 待接线（同上）
[前置条件] 备份列表至少 1 项；记录当前激活档案
[测试数据] 选择器 `dsh-backup-restore-as-new`
[测试步骤] 1. 记录激活档案与档案数量。2. 点击「还原为新档案」。3. 在确认框中确认并等待完成。4. 读取档案数量、激活档案与新增档案。
[预期结果] 1. 记录成功。2. 确认框出现（警告语义）。3. 完成。4. 档案数量增加 1；激活档案未变化；新增档案内容与备份一致。
[清理] 删除新增档案；关闭对话框；`DELETE /session/<id>`

---

## 4. 删除与空态

### [P3] [反向] 验证删除备份需确认

[Case ID] TC-DSK-L3-119
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/ui/config/backup.tsx:147-172`
[自动化] 待接线（同上）
[前置条件] 备份列表至少 2 项
[测试数据] 选择器 `dsh-backup-delete`
[测试步骤] 1. 记录备份行数量。2. 点击某项的删除。3. 在确认框中取消并读取行数量。4. 再次点击并确认，读取行数量。
[预期结果] 1. 记录成功。2. 确认框出现（危险语义）。3. 行数量不变。4. 行数量比记录值少 1，并出现删除成功提示。
[清理] 关闭对话框；`DELETE /session/<id>`

### [P4] 验证空备份列表显示空态

[Case ID] TC-DSK-L3-120
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/ui/config/backup.tsx:223-288`
[自动化] 待接线（同上）
[前置条件] 当前档案下无任何备份
[测试数据] 选择器 `dsh-backup-empty`
[测试步骤] 1. 进入备份视图。2. 读取空态节点与备份行数量。
[预期结果] 1. 视图渲染完成。2. 空态节点存在且包含标题与说明两段非空文案；备份行数量为 0。
[清理] 关闭对话框；`DELETE /session/<id>`

---

## 5. 选择器契约（待补）

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-backup-back` | 「返回档案列表」按钮 | 待补 |
| `dsh-backup-create` | 「立即备份」按钮 | 待补 |
| `dsh-backup-include-credentials` | 「包含凭据」勾选框 | 待补 |
| `dsh-backup-credentials-warning` | 凭据风险警告 | 待补 |
| `dsh-backup-row` | 单个备份行 | 待补 |
| `dsh-backup-restore` | 「还原」按钮 | 待补 |
| `dsh-backup-restore-as-new` | 「还原为新档案」按钮 | 待补 |
| `dsh-backup-delete` | 删除 Chip | 待补 |
| `dsh-backup-empty` | 空态区块 | 待补 |

---

## 6. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 视图进出 | 113、116 | 正向 / 边界 | — |
| 创建备份 | 114、115 | 正向 | 「包含凭据」的**实际内容差异**未断言（需解包备份产物） |
| 还原（覆盖当前档案） | 117 | 异常 | **还原成功后的内容一致性未覆盖**（用例止于「服务已停止」） |
| 还原为新档案 | 118 | 异常 | 新增档案内容与备份一致属关键断言，需要备份产物解包能力 |
| 删除 | 119 | 异常 | — |
| 空态 | 120 | 边界 | — |
| 停服轮询 `waitForHarnessStopped` | 117 | 异常 | 502/ECONNREFUSED 重试分支与 10s 超时分支**未覆盖**（属单元测试职责，`test/archive/backup.test.ts` 有归档版本） |

---

## 7. 缺口与假设

- **G-D15-1**：还原会**改写 profile 目录**，是本套中破坏性最强的操作。接线时必须在独立数据目录下执行，且清理步骤要能恢复原 profile 内容（或直接重建环境）。
- **G-D15-2**：备份产物（时间戳、大小、是否含凭据）的内容级校验需要解包能力（归档格式未在本次调查中确认）。当前只断言「列表出现新项且大小大于 0」。
- **G-D15-3**：`waitForHarnessStopped` 的错误分类逻辑（`502|ECONNREFUSED|ETIMEDOUT` 视为 transient 继续重试，其余视为已停止）**未覆盖**；该分支属纯逻辑，应在单元测试覆盖，而非 L3。
- **假设**：还原后会自动异步 `launch_harness`（`backup.tsx:100-102`），因此 TC-DSK-L3-117 的清理可直接等待服务恢复，无需手动点击重启。
