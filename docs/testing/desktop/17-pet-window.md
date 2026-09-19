# 桌宠窗口

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/desktop/17-pet-window.e2e.ts`（待建立）
> 前置：`13-application-settings.md` 通过；已安装 `dsh-tauri-pet` 插件
> 运行：`vitest --project desktop -- test/e2e/desktop/17-pet-window.e2e.ts`（待配置，见 G2）

桌宠是一个**独立的透明置顶窗口**（`pet.html`），由插件侧状态驱动显示与尺寸，几何持久化到独立 store 键 `pet_window_state`。窗口内可交互面只有命中箱，其余区域按矩形整体穿透。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| 桌宠窗口特性：透明 + 置顶 + 无装饰 | `src-tauri/src/desktop/pet.rs:308-309` |
| 窗口按需创建/销毁，入口 `set_pet_window_visible` | `src-tauri/src/desktop/pet.rs:419-447` |
| 几何持久化到 `pet_window_state` | `src-tauri/src/desktop/pet.rs:87-109`、`:334` |
| 窗口尺寸由百分比与宽高比推导 | `src-tauri/src/desktop/pet.rs:146-160` |
| 桌宠入口页面 `pet.html` | `src-tauri/src/desktop/pet.rs:293-310` |
| 状态来源 `usePetStatus`（`enabled`/`visible`/`active_pet`/`pet_size`） | `src/pet/app.tsx:32`、`:41-42` |
| 资源解析 `usePetSource`（失败返回 `error`） | `src/pet/app.tsx:37` |
| 资源失败提示 `Hint` | `src/pet/app.tsx:76-78`；`src/ui/pet/hint.tsx` |
| 命中箱外穿透 `useOmitIgnoreCursorEvents` | `src/pet/app.tsx:46`；`src/hooks/use-omit-ignore-cursor-events.ts` |
| 右键菜单被阻止 | `src/pet/app.tsx:47` |
| 拖动期间按方向播走路动画 | `src/pet/app.tsx:52-54` |
| 唤醒锁立即释放（issue #469） | `src/pet/app.tsx:48`；`src/hooks/use-wakelock-release.ts` |
| 桌宠窗口几何在退出时保存 | `src-tauri/src/desktop/builder.rs:1071`、`:1084` |
| 预设宠物不下载不安装，由远端 URL 直连播放 | `docs/specs/agents.desktop.md` §2 |
| macOS 自动使用 `.mov`（HEVC-alpha） | `docs/specs/agents.desktop.md` §2 |

---

## 2. 窗口生命周期

### [P1] 验证启用桌宠后出现独立置顶窗口

[Case ID] TC-DSK-L3-128
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/desktop/pet.rs:293-310`、`:441-447`；`src/pet/app.tsx:29`
[自动化] 待接线（`test/e2e/desktop/17-pet-window.e2e.ts`）
[前置条件] 桌宠当前为禁用；应用处于 `ready`；已安装 `dsh-tauri-pet`
[测试数据] 桌宠入口 `pet.html`
[测试步骤] 1. 记录当前窗口数量与窗口 URL 集合。2. 启用桌宠。3. 等待新窗口出现。4. 读取窗口数量与 URL 集合。
[预期结果] 1. 记录成功。2. 启用被接受。3. 新窗口在超时内出现。4. 数量比记录值多 1；新增窗口 URL 指向 `pet.html`。
[清理] 禁用桌宠；`DELETE /session/<id>`

### [P2] 验证禁用桌宠后窗口不再可见

[Case ID] TC-DSK-L3-129
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/desktop/pet.rs:419-447`；`src/pet/app.tsx:41`
[自动化] 待接线（同上）
[前置条件] 桌宠已启用且可见
[测试数据] 无
[测试步骤] 1. 禁用桌宠。2. 等待收敛。3. 读取桌宠窗口存在性与可见性。4. 读取主窗口可见性。
[预期结果] 1. 禁用被接受。2. 收敛完成。3. 桌宠窗口不可见（或已销毁）。4. 主窗口不受影响，仍可见。
[清理] `DELETE /session/<id>`

### [P2] 验证桌宠窗口几何持久化

[Case ID] TC-DSK-L3-130
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/desktop/pet.rs:87-109`、`:334`
[自动化] 待接线（同上）
[前置条件] 桌宠已启用；无历史几何记录
[测试数据] 目标位置由测试在合法屏幕范围内选取
[测试步骤] 1. 把桌宠窗口移动到目标位置。2. 完整退出应用。3. 重新拉起应用并启用桌宠。4. 读取桌宠窗口位置。
[预期结果] 1. 移动成功。2. 退出完成。3. 窗口重新出现。4. 位置与目标值一致（允许 ±2px 误差），说明 `pet_window_state` 已恢复。
[清理] 清除几何记录；禁用桌宠；`DELETE /session/<id>`

---

## 3. 尺寸与资源

### [P2] 验证桌宠尺寸随设置百分比变化

[Case ID] TC-DSK-L3-131
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/desktop/pet.rs:146-160`；`src/pet/app.tsx:42-45`
[自动化] 待接线（同上）
[前置条件] 桌宠已启用且资源解析成功
[测试数据] 两个百分比档位（如 `50` 与 `100`）
[测试步骤] 1. 在 50% 下读取桌宠窗口宽高。2. 切换到 100%。3. 再次读取宽高。
[预期结果] 1. 读取成功。2. 切换被接受。3. 宽高按比例放大，比值约等于 2（允许 ±2px 误差）；宽高比保持为当前宠物资源的宽高比。
[清理] 百分比改回原值；禁用桌宠；`DELETE /session/<id>`

### [P3] 验证资源解析失败时显示可见提示

[Case ID] TC-DSK-L3-132
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/pet/app.tsx:76-78`；`src/ui/pet/hint.tsx`
[自动化] 待接线（同上）
[前置条件] 当前选中的宠物资源不可解析（如导入的宠物被删除，或清单中无该 id）
[测试数据] 选择器 `dsh-pet-hint`
[测试步骤] 1. 启用桌宠并等待资源解析失败。2. 读取提示节点。
[预期结果] 1. 解析失败返回。2. 提示节点存在且可见（透明窗口内不出现「空」与「加载中」不可区分的情况）。
[清理] 恢复可解析的宠物；禁用桌宠；`DELETE /session/<id>`

---

## 4. 边界与低频

### [P4] 验证桌宠窗口右键不弹出上下文菜单

[Case ID] TC-DSK-L3-133
[层级] L3（真实 Tauri 窗口）
[类型] 边界
[追踪] `src/pet/app.tsx:47`
[自动化] 待接线（同上）
[前置条件] 桌宠已启用
[测试数据] 观察点：在桌宠窗口内派发 `contextmenu` 后的 `defaultPrevented`
[测试步骤] 1. 切到桌宠窗口。2. 派发 `contextmenu` 事件。3. 读取事件对象的 `defaultPrevented`。
[预期结果] 1. 切换成功。2. 事件派发成功。3. `defaultPrevented` 为真（透明窗口不出现系统菜单）。
[清理] 禁用桌宠；`DELETE /session/<id>`

### [P5] 验证命中箱外区域鼠标穿透

[Case ID] TC-DSK-L3-134
[层级] L3（真实 Tauri 窗口）
[类型] 低频
[追踪] `src/pet/app.tsx:46`；`src/hooks/use-omit-ignore-cursor-events.ts`
[自动化] 否（手工；需操作系统级鼠标注入）
[前置条件] 桌宠已启用；桌宠窗口覆盖在另一可点击窗口之上
[测试数据] 无
[测试步骤] 1. 把鼠标移到桌宠窗口内但宠物命中箱之外的区域。2. 点击该处。3. 把鼠标移到宠物命中箱内并点击。
[预期结果] 1. 鼠标移动到该区域。2. 点击穿透到下层窗口并生效。3. 命中箱内的点击被桌宠窗口接收，不穿透。
[清理] 禁用桌宠

---

## 5. 选择器契约（待补）

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-pet-hint` | 资源失败提示 | 待补 |
| `dsh-pet-hitbox` | 宠物命中箱 | 待补 |

---

## 6. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| 窗口创建 / 销毁 | 128、129 | 正向 | 窗口「已销毁」与「仅隐藏」两种实现都满足断言，未区分 |
| 几何持久化 | 130 | 正向 | 多显示器下的越界裁剪**未覆盖** |
| 尺寸缩放 | 131 | 正向 | 极值百分比（0 / 极大）**未覆盖**，需确认后端是否夹取 |
| 资源解析失败 | 132 | 异常 | 依赖构造不可解析的宠物资源，见 G-D17-1 |
| 右键与穿透 | 133、134 | 边界 / 低频 | 穿透需系统级鼠标注入，标为手工 |
| 唤醒锁释放（issue #469） | — | — | **未覆盖**：无法在页面内断言系统息屏行为 |
| macOS `.mov` 格式分支 | — | — | **未覆盖**，需 macOS 环境与真实资源 |

---

## 7. 缺口与假设

- **G-D17-1**：TC-DSK-L3-132 需要「不可解析的宠物资源」。当前宠物资源来自远端 URL 与 IndexedDB 缓存（`agents.desktop.md` §2），测试环境无稳定资源。接线时需注入可控的本地宠物资源与一份「指向已删除宠物」的状态，属关键夹具缺口。
- **G-D17-2**：桌宠状态（是否启用、可见、当前宠物、尺寸）由插件侧提供，本套未确认其读写通路（设置项位置）。接线时必须先定位该入口，否则本文件全部用例不可达。
- **G-D17-3**：`always_on_top` 的实际置顶效果无法通过 WebDriver 断言（属窗口管理器表面）。TC-DSK-L3-128 只断言「存在指向 `pet.html` 的独立窗口」，**置顶未被证明**。
- **G-D17-4**：唤醒锁释放（issue #469）**未覆盖**——它断言的是系统能否息屏，超出 L3 可观察范围。
- **假设**：桌宠窗口与主窗口共享同一应用进程与数据目录；因此 TC-DSK-L3-130 的「完整退出再启动」会同时恢复主窗口与桌宠窗口的几何。
