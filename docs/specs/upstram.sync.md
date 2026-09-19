# 上游同步规范与管理索引

> **目的**：定期核对本项目从上游参考实现移植或派生的能力，及时采纳有价值的修复与新特性。
> **铁律**：**先汇报、后实施**。未经用户逐条明确同意，严禁修改代码、推进子模块基线或落成功能。

本文档为「对应关系 + 基线 + 待评估项」的**唯一全局索引**。具体实现细节、提交范围、验证记录及未采纳原因，详见各包内的 `sync-log.md`（参见 §1 表格）。

---

## 1. 范围定义

### 1.1 纳入范围（上游对应关系）

| 本项目实现模块 | 上游仓库 / 对应逻辑 | 本地路径 | 已采纳基线 | 包内同步日志 |
| --- | --- | --- | --- | --- |
| `dsh-tauri-pet` | [`PC2005-cloud/dsh-pet`](https://github.com/PC2005-cloud/dsh-pet) | `source/dsh-pet` | `v0.2.6` (`e1ff8c1`) | [`sync-log.md`](https://www.google.com/search?q=../packages/dsh-tauri-pet/docs/sync-log.md) |
| └─ 气泡文案 / 状态优先级 | [`QCYTSN/dsh-dafeiyu`](https://github.com/QCYTSN/dsh-dafeiyu) | `source/dsh-dafeiyu` | `v0.1.9` (`f4f4482`) | 同上 |
| └─ Codex 图集 / 会话状态 | [`Skylarking/dsh-plugin-codex-pets`](https://github.com/Skylarking/dsh-plugin-codex-pets) | `source/dsh-plugin-codex-pets` | `22e93f4` | 同上 |
| └─ 原生拖动 / DPI / 穿透 | [`ayangweb/BongoCat`](https://github.com/ayangweb/BongoCat) | `source/BongoCat` | `v1.1.0-5` (`44f44bc`) | 同上 |
| `dsh-tauri-panel-extension` | [`qinyre/dsh-plugin-capabilities`](https://github.com/qinyre/dsh-plugin-capabilities) | `source/dsh-plugin-capabilities` | `v0.3.10` (`e5e3596`) | [`upstream-sync-log.md`](https://www.google.com/search?q=../packages/dsh-tauri-panel-extension/docs/upstream-sync-log.md) |
| `dsh-tauri-panel-scheduler` | [`MichengAI/dsh-automation`](https://github.com/MichengAI/dsh-automation) | `source/dsh-automation` | `f1bc91a` (跟进 `c426c3d`) | [`sync-log.md`](https://www.google.com/search?q=../packages/dsh-tauri-panel-scheduler/docs/sync-log.md) |

**连带跟随依赖（非独立上游，须同步提升基线）**

* `preset-pets.json` 预设 `ref`（含 `platforms.macos` 镜像产物 commit）：必须与 `source/dsh-pet` 的 HEAD 保持同步，否则 macOS 端将停留在旧动画集。
* `hairyf/dsh-pet-component`（npm 渲染层）：走常规依赖升级流程。
* `Signalight/codex-to-dsh-pet`：Codex v2 图集与状态映射的**文字参考**，按需拉取核对。

### 1.2 排除范围

* **DSH 内核** ([`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness))：属于“必须兼容”的运行时依赖，非择优采纳。若需巡检另设章节，不得与本流程混用。
* 上游纯文档改动（README / 注释 / 翻译 / License / Release Notes）。
* 上游 CI / CD、发布流水线与脚手架配置。
* **第三方适配**：上游针对其自身宿主或第三方生态（如 Electron Helper、特定插件）的专属逻辑。
* 已在包内日志中登记并以其他方式实现的逻辑（防重复评估）。

---

## 2. 判定标准

### 2.1 需汇报（有价值）

* **缺陷修复**：崩溃、失败、状态异常、兼容性修复，且本项目存在相同或相似缺陷。
* **特性扩展**：补齐本插件功能短板，且与包内“有意保留的差异”不冲突。
* **协议/宿主对齐**：上游针对 DSH 内核升级所作的宿主 API 适配。
* **资产/素材更新**：新预设、新动画或字段扩展（需连带更新预设与 macOS 镜像 ref）。

### 2.2 直接归档（无价值）

* 纯文档、注释、翻译、License 或脚手架/CI 修改。
* 针对 Electron Helper 等特定宿主的专属适配。
* 依赖本项目未提供之宿主能力的功能（如 Session Folder、市场模块等）。
* 包内日志已明确结论且前提条件未变更的提交。

### 2.3 判定原则

1. 核心标准：**“本项目是否存在同类问题 / 能否直接受益”**，不视版本号大小或 Issue 热度而定。
2. 存疑提交统一标记为 `待定` 提请裁决，**严禁**直接剔除修复类提交。
3. 评估前须核对包内日志中的历史归档项，避免重复评估。

---

## 3. 标准同步流程

### 3.1 步骤 1：只读取证

按需执行以下命令更新远端引用（仅抓取 Commit History，严禁使用 `pull` / `checkout` 改动工作区）：

```bash
# 批量拉取并查看待评估 Commit Log
git -C source/dsh-pet fetch --all --tags && git -C source/dsh-pet log --oneline e1ff8c1..origin/main
git -C source/dsh-dafeiyu fetch --all --tags && git -C source/dsh-dafeiyu log --oneline f4f4482..origin/main
git -C source/dsh-plugin-codex-pets fetch --all && git -C source/dsh-plugin-codex-pets log --oneline 22e93f4..origin/main
git -C source/BongoCat fetch --all --tags && git -C source/BongoCat log --oneline 44f44bc..origin/main
git -C source/dsh-automation fetch --all --tags && git -C source/dsh-automation log --oneline f1bc91a..origin/main
git -C source/dsh-plugin-capabilities fetch --all --tags && git -C source/dsh-plugin-capabilities log --oneline e5e3596..origin/main

```

### 3.2 步骤 2：分类与优先级划分

* **打标分类**：`修复` | `Feature` | `协议对齐` | `资产`
* **确定结论**：`建议采纳` | `不采纳` | `待定`
* **设置优先级**：
* **P0**：破坏性变更、崩溃修复或内核兼容性更新
* **P1**：明确的功能补齐
* **P2**：可选的体验优化



### 3.3 步骤 3：汇报待批 (唯一交付点)

严格按 §4 模板生成报告并提交裁决，**不得修改任何代码**。

### 3.4 步骤 4：用户裁决

* 采纳与否按条目独立生效，**概括性或批量同意一律视为无效**。
* 未获明确同意的条目标记为“拒绝/暂缓”，回填至包内日志并附带日期与原因。

### 3.5 步骤 5：实施与日志回填

1. **代码变更**：遵循“一事一 Commit/PR”原则，PR 必须关联上游 SHA 与汇报条目。
2. **基线隔离**：严格保护各包“有意保留的差异”，防止被合并覆盖。
3. **校验机制**：按顺序执行代码格式、类型、单元测试及构建校验：

```bash
pnpm run lint && pnpm typecheck && pnpm test -- --run
pnpm --filter <TargetPackage> build
cargo check --manifest-path src-tauri/Cargo.toml --lib
cargo test  --manifest-path src-tauri/Cargo.toml --lib
git diff --check

```

4. **数据回填**：同时更新对应包内 `sync-log.md` 与本文档 §5 登记表。

### 3.6 安全红线

* **严禁越权**：未经同意不得合并代码、升级子模块基线或变更待定状态。
* **阻断机制**：实施过程中若发现与已有“有意差异”冲突或超出汇报影响面，必须**立即停止**并重新汇报。

---

## 4. 汇报模板

```text
上游仓库：<owner/repo> (<本地路径>)
基线状态：<当前基线/SHA> → 拟推进至：<目标版本/SHA>
评估结论：建议采纳 N 项 / 不采纳 M 项 / 待定 K 项

【逐项明细】
- [<P0|P1|P2>] <SHA> <上游提交标题>
  - 类别：修复 | Feature | 协议对齐 | 资产
  - 改动说明：<变更原因及内容>
  - 本地影响：<逐一列出影响的文件路径>
  - 处理建议：采纳 (<具体动作>) | 不采纳 (<说明原因>)
  - 风险提示：<冲突风险或无>

【不采纳汇总】
- <SHA> <一句话原因>

【需裁决项】
- <列出需用户决策的争议点，若无填“无”>

```

---

## 5. 基线与状态登记表

### 5.1 当前基线与同步状态

| 实现模块 | 上游仓库 | 本地路径 | 已采纳基线 | 本地最新 Tag/Commit | 待评估项 / 备注 | 包内日志 |
| --- | --- | --- | --- | --- | --- | --- |
| `dsh-tauri-pet` | `PC2005-cloud/dsh-pet` | `source/dsh-pet` | `v0.2.6` (`e1ff8c1`) | `v0.2.9` (`b400159`) | `v0.2.7`–`v0.2.9` 待评估 | [日志](https://www.google.com/search?q=../packages/dsh-tauri-pet/docs/sync-log.md) |
| `dsh-tauri-pet` | `QCYTSN/dsh-dafeiyu` | `source/dsh-dafeiyu` | `v0.1.9` (`f4f4482`) | `v0.1.14` (`9c0588c`) | `v0.1.10`–`v0.1.14` 待评估 | [日志](https://www.google.com/search?q=../packages/dsh-tauri-pet/docs/sync-log.md) |
| `dsh-tauri-pet` | `Skylarking/dsh-plugin-codex-pets` | `source/dsh-plugin-codex-pets` | `22e93f4` | - | 未评估 main 分支更新 | [日志](https://www.google.com/search?q=../packages/dsh-tauri-pet/docs/sync-log.md) |
| 桌宠窗口 | `ayangweb/BongoCat` | `source/BongoCat` | `44f44bc` | `v1.1.0` | HEAD 已超前 Tag 5 个 Commit | [日志](https://www.google.com/search?q=../packages/dsh-tauri-pet/docs/sync-log.md) |
| `dsh-tauri-panel-extension` | `qinyre/dsh-plugin-capabilities` | `source/dsh-plugin-capabilities` | `v0.3.10` (`e5e3596`) | `v0.3.10` | 暂无待评估项（该上游的 Market 模块确定不移植；扩展面板的市场页改为直接消费 `dshmarket` 的 `market` 服务） | [日志](https://www.google.com/search?q=../packages/dsh-tauri-panel-extension/docs/upstream-sync-log.md) |
| `dsh-tauri-panel-extension`（市场标签页） | `dsh-market/dsh-market` | `source/dsh-market` | `v1.47.0-6` (`53f793e`) | `v1.47.0-6` (`53f793e`) | 非代码移植：消费其 `ctx.provide('market')` 服务。`render()` 尚未发版，故先以 `source` 子模块承载；待上游发版后改为常规 npm 依赖并移除子模块 | - |
| `dsh-tauri-panel-scheduler` | `MichengAI/dsh-automation` | `source/dsh-automation` | `f1bc91a` (+`c426c3d`) | `v0.1.42` (`e75499e`) | `v0.1.33`–`v0.1.42` 已评估：全部不采纳（2026-09-16）；无待评估项 | [日志](https://www.google.com/search?q=../packages/dsh-tauri-panel-scheduler/docs/sync-log.md) |

### 5.2 已知配置与异常记录

* **子模块绑定**：`source/*` 下 7 个参考仓库均已引入 `.gitmodules`。其中 `source/dsh-market` 是 2026-09 新增的**临时**参考仓库：上游 `render()` API 只存在于 main 分支，尚未发版，故先以源码子模块承载供 GitHub 源安装测试；上游发版后应改为 npm 依赖并移除该子模块。当前 gitlink 配置已暂存，待提交。
* **路径纠偏记录**：
* `source/dsh-automation` 已纠正 gitlink 配置，子模块 HEAD 指向 `f1bc91a`。
* `source/dsh-automation` gitlink 为 `f1bc91a`，但工作区 checkout 停在 `e75499e`（`git submodule status` 前缀 `+`，
  父仓库表现为未暂存的 `source/dsh-automation` 变更）。2026-09-16 裁决不采纳 `v0.1.33`–`v0.1.42` 任何代码，
  基线不推进、工作区不回落。
* `dsh-tauri-panel-extension` 文档中引用的上游路径已更正为 `source/dsh-plugin-capabilities`。
* 修复了 `dsh-tauri-panel-extension/README.md` 中 `soruce` 的拼写错误。



---

## 6. 维护约定

* **职责分离**：本文档负责维护全局对应关系、基线与待评估索引；包内日志记录具体的移植细节与未采纳项。
* **状态词汇集中**：仅使用以下标准词：`待评估` | `已汇报待批` | `已同意` | `已实施` | `不采纳` | `暂缓`。
* **双向更新**：每次同步完成后，必须同时刷新**包内日志**与**本文档 §5 登记表**。