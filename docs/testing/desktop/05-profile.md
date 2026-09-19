# 档案管理

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/specs/desktop/05-profile.e2e.ts`（待建立）
> 前置：`03-config-dialog.md` 通过；配置对话框可打开在「档案」面板
> 运行：`vitest --project desktop -- test/e2e/specs/desktop/05-profile.e2e.ts`（待配置，见 G2）

档案 = `$DSH_HOME/profiles/<id>`（测试中为 `$E2E_HOME/home/.dsh.dev/profiles/<id>`，见 `00-overview.md` §5.3），与官方 dsh CLI 的 profile 语义一致；桌面端把「当前档案」持久化在 store 的 `active_profile`，服务启动与插件管理都以它为准。本文件的重点是**写操作的可见反馈**与**失败不静默**。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 列表真值来自 `get_profiles` 查询 | `src/ui/config/profile.tsx:34-37` |
| 写操作：`create_profile`/`set_active_profile`/`remove_profile`/`clone_profile` | `src/ui/config/profile.tsx:46-61` |
| 写操作后显式 `refetch()`，列表与后端一致 | `src/ui/config/profile.tsx:64-85` |
| 默认档案显示说明文案，且删除入口禁用 | `src/ui/config/profile.tsx:263-267`、`:307-317` |
| 新建「确定」在 `!name.trim()` 或 busy 时禁用 | `src/ui/config/profile.tsx:349` |
| 新建输入框 Enter 触发提交 | `src/ui/config/profile.tsx:337-340` |
| 克隆建议名 `suggestCloneName`：`<base>-<n>`，跳过已占用 id | `src/ui/config/profile.tsx:104-113` |
| 切换档案前弹警告确认框，取消即中止 | `src/ui/config/profile.tsx:144-162` |
| 切换成功后 toast 提供「重启」入口 | `src/ui/config/profile.tsx:165-176` |
| 写操作进行中 `busy` 会禁用所有行内入口 | `src/ui/config/profile.tsx:91`、`:296`、`:308` |
| 备份子视图入口 | `src/ui/config/profile.tsx:241-245`、`:285-294` |

---

## 2. 列表与新建

### [P1] 验证档案列表展示且默认档案标记正确

[Case ID] TC-DSK-L3-031
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] 批次 05；`src/ui/config/profile.tsx:34-40`、`:254-269`
[自动化] 待接线（`test/e2e/specs/desktop/05-profile.e2e.ts`）
[前置条件] 应用处于 `ready`；至少存在 1 个档案
[测试数据] 选择器 `dsh-profile-row`、`dsh-profile-row-default-desc`
[测试步骤] 1. 打开「档案」面板。2. 读取档案行数量与每行名称。3. 读取带默认标记的行。
[预期结果] 1. 面板渲染完成。2. 行数量与 `get_profiles` 返回数量一致，名称均为非空字符串。3. 恰有一行带默认说明文案，且对应后端 `default == true` 的档案。
[清理] 无（只读）；`DELETE /session/<id>`

### [P1] 验证新建档案后列表出现新项

[Case ID] TC-DSK-L3-032
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] 批次 05；`src/ui/config/profile.tsx:194-208`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-031 通过；新建名称未被占用
[测试数据] 名称 `e2e-profile-<时间戳>`
[测试步骤] 1. 点击「新建档案」。2. 在输入框填入测试名称。3. 点击「确定」。4. 等待列表刷新。5. 读取列表名称集合与输入区状态。
[预期结果] 1. 输入框出现并获得焦点。2. 输入成功。3. 按钮可点击并被触发。4. 列表刷新完成。5. 集合包含测试名称，且输入区回到未展开状态。
[清理] 删除本次创建的档案；`DELETE /session/<id>`

### [P2] 验证克隆档案的建议名称不与现有 id 冲突

[Case ID] TC-DSK-L3-033
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src/ui/config/profile.tsx:104-118`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-031 通过
[测试数据] 源档案 id `S`；已占用 `S-1`（不存在时由测试先创建）
[测试步骤] 1. 点击源档案行的「克隆」。2. 读取克隆对话框输入框初值。3. 确认克隆并读取列表。
[预期结果] 1. 对话框出现。2. 初值形如 `<S>-<n>`，且该值不在现有档案 id 集合中。3. 确认后列表出现该名称的新档案。
[清理] 删除本次创建的档案；`DELETE /session/<id>`

---

## 3. 输入边界

### [P2] 验证新建输入框回车等同点击「确定」

[Case ID] TC-DSK-L3-034
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/ui/config/profile.tsx:337-340`
[自动化] 待接线（同上）
[前置条件] 输入区已展开且名称合法
[测试数据] 名称 `e2e-profile-enter-<时间戳>`
[测试步骤] 1. 在输入框填入名称。2. 按 Enter。3. 等待列表刷新。4. 读取列表名称集合。
[预期结果] 1. 输入成功。2. 回车被接受。3. 刷新完成。4. 集合包含该名称。
[清理] 删除本次创建的档案；`DELETE /session/<id>`

### [P2] 验证空名称与纯空白时「确定」按钮禁用

[Case ID] TC-DSK-L3-035
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/ui/config/profile.tsx:349`
[自动化] 待接线（同上）
[前置条件] 新建输入区已展开
[测试数据] 输入值：空字符串、仅空格 `"   "`
[测试步骤] 1. 清空输入框，读取「确定」禁用态。2. 填入仅空格，再次读取。3. 按 Enter，读取列表。
[预期结果] 1. 按钮为禁用态。2. 按钮仍为禁用态。3. 列表不变（trim 后为空不提交）。
[清理] 收起输入区；`DELETE /session/<id>`

---

## 4. 切换、克隆与删除

### [P3] 验证切换档案需确认，取消则不切换

[Case ID] TC-DSK-L3-036
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/ui/config/profile.tsx:144-162`
[自动化] 待接线（同上）
[前置条件] 存在至少 2 个档案，且当前激活档案非目标档案
[测试数据] 目标档案：任一非激活档案
[测试步骤] 1. 记录当前激活档案。2. 点击目标档案行。3. 在确认框中取消。4. 读取当前激活档案。
[预期结果] 1. 记录成功。2. 出现切换确认框（警告语义）。3. 确认框关闭。4. 激活档案未变化。
[清理] `DELETE /session/<id>`

### [P3] [反向] 验证创建失败时不出现新项并给出提示

[Case ID] TC-DSK-L3-037
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/ui/config/profile.tsx:204-207`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-031 通过；构造使 `create_profile` 失败的输入（如已存在的同名档案）
[测试数据] 名称：与现有档案完全同名
[测试步骤] 1. 用已存在的名称执行新建。2. 等待请求返回。3. 读取列表名称集合与提示区。
[预期结果] 1. 提交被触发。2. 请求失败返回。3. 集合中该名称仍只出现一次，且出现失败提示文案（不静默）。
[清理] `DELETE /session/<id>`

### [P3] [反向] 验证默认档案的删除入口不可用

[Case ID] TC-DSK-L3-038
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/ui/config/profile.tsx:307-317`
[自动化] 待接线（同上）
[前置条件] TC-DSK-L3-031 通过
[测试数据] 默认档案行内的删除 Chip
[测试步骤] 1. 定位默认档案行。2. 点击该行的删除 Chip。3. 等待稳定后读取档案数量与确认框存在性。
[预期结果] 1. 定位成功。2. 点击不产生删除动作。3. 不出现删除确认框；档案数量不变。
[清理] `DELETE /session/<id>`

---

## 5. 选择器契约（待补）

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-profile-row` | 单个档案行 | 待补 |
| `dsh-profile-row-default-desc` | 默认档案说明文案 | 待补 |
| `dsh-profile-new` | 「新建档案」按钮 | 待补 |
| `dsh-profile-new-input` | 新建名称输入框 | 待补 |
| `dsh-profile-new-confirm` | 新建「确定」按钮 | 待补 |
| `dsh-profile-new-cancel` | 新建「取消」按钮 | 待补 |
| `dsh-profile-clone` | 「克隆」Chip | 待补 |
| `dsh-profile-clone-input` | 克隆名称输入框 | 待补 |
| `dsh-profile-clone-confirm` | 克隆「确定」按钮 | 待补 |
| `dsh-profile-remove` | 「删除」Chip | 待补 |
| `dsh-profile-backup` | 「备份」Chip | 待补 |

---

## 6. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 列表与默认标记 | 031 | 正向 | 档案内容（`$E2E_HOME/home/.dsh.dev/profiles/<id>` 实际文件）未断言 |
| 新建全链路 | 032、034、035 | 正向 / 边界 | — |
| 克隆 | 033 | 正向 | 克隆后的内容一致性归 `15`（备份）与后端职责，本文件只断言命名与列表 |
| 切换确认 | 036 | 异常 | 确认后的切换 + 重启链路未覆盖（需等待服务重启，成本高） |
| 创建失败反馈 | 037 | 异常 | 失败原因由后端决定，本用例只断言「有可见提示且列表不变」 |
| 默认档案保护 | 038 | 异常 | — |

---

## 7. 缺口与假设

- **G-D05-1**：TC-DSK-L3-036 只覆盖「取消不切换」。**确认后切换 + 服务重启**的完整链路未覆盖，因为它会触发一次真实服务重启并改变后续用例的前置状态；如需覆盖，应放在独立批次并显式复位 `active_profile`。
- **G-D05-2**：档案的物理落盘（`$E2E_HOME/home/.dsh.dev/profiles/<id>` 目录与内容）未断言，本文件只验证 UI 与后端返回的一致性。落盘正确性属后端职责，应在 Rust 单测覆盖。
- **G-D05-3**：`busy` 期间所有行内入口禁用（`profile.tsx:91`）未单独建用例，属「单例约束」类边界，归 `09` 的同族用例（TC-DSK-L3-065）统一覆盖。
- **假设**：`get_profiles` 至少返回 1 个档案（默认档案始终存在）；若测试环境为空，TC-DSK-L3-031 需先创建。
