# 渐进式测试推进规则

> 本文件定义「桌面端 / 插件测试逐条补齐」的协作流程与进度台账。
> 测试方案本身见 [e2e/spec.md](./e2e/spec.md)（桌面端）与 [e2e/plugin.spec.md](./e2e/plugin.spec.md)（插件）。

---

## 1. 核心规则

1. **一次一批**：每批只交付**一个可观察结果**（一条用例，或一条用例所必需的最小基础设施）。不做「顺手把后面几条也写了」。
2. **文档先行，代码同批**：批内先写用例文档，再写对应的测试代码；两者在同一个批次里交付，不跨批漂移。
3. **每批必须可独立运行**：给出确切的运行命令。跑不起来的批次不算完成。
4. **审核后放行**：每批交付后**停下来**，由人审查并实际运行；通过后才描述下一批。
5. **下一批需明确同意**：下一批的内容先描述（做什么、改哪些文件、代价多大），得到「ok」才动手。
6. **失败即阻塞**：本批失败就修本批，不带病推进。修不了就如实说明并停在原地。
7. **实时记账**：每批的状态变化立刻写进第 4 节的台账，不攒到最后补。

---

## 2. 单批流程

```
① 我描述下一批            → 做什么 / 改哪些文件 / 代价与风险 / 运行命令
② 你回「ok」（或调整）    → 未同意不动手
③ 我实现                  → 用例文档 + 测试代码 + 台账更新为「待你验证」
④ 你审查 + 运行           → 把结果（通过 / 报错原文）回给我
⑤ 我按结果收尾            → 通过 → 台账「已验证」，回到 ①
                            失败 → 修本批，回到 ④
```

「代价与风险」必须如实说，尤其是：是否需要构建、需要装依赖、会动到哪些现有文件、大概多久。

---

## 3. 状态图例

| 状态 | 含义 |
| --- | --- |
| `提案中` | 已描述，等你的 ok |
| `已同意` | 你 ok 了，我尚未动手 |
| `已实现` | 代码与文档已落地，**等你审查 + 运行** |
| `已验证` | 你运行通过，本批关闭 |
| `已阻塞` | 有明确阻塞条件（附原因），停在原地 |

---

## 4. 进度台账

> 状态变化即时更新本节。

### 4.1 桌面端（`docs/testing/desktop/`）

| 批次 | 用例 | 文档 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| D0 | 桌面端 E2E 基础设施：内嵌 WebDriver server 可被 HTTP 驱动 | [desktop/basic.md](./desktop/basic.md) | `已同意` | 正在实现；验证命令见下方 D0 详情 |
| D1 | 应用启动后主窗口存在且标题正确 | [desktop/basic.md](./desktop/basic.md) | `未开始` | 依赖 D0 验证通过；再加 WDIO/vitest 接线 |
| D2+ | 壳层根节点渲染 / 导航栏 / 配置对话框 … | 待定 | `未开始` | 逐条确认 |

#### D0 详情（本批交付物）

| 文件 | 改动 |
| --- | --- |
| `src-tauri/Cargo.toml` | 加 `tauri-plugin-wdio-webdriver = "1"`（普通依赖；crate 要求 tauri ≥ 2.10，本仓 2.11.5 满足） |
| `src-tauri/src/desktop/builder.rs` | `builder()` 链上注册 `.plugin(tauri_plugin_wdio_webdriver::init())` |
| `test/e2e/support/wdio-probe.mjs` | 临时探针：以 `TAURI_WEBDRIVER_PORT` 起应用 → 轮询 `http://127.0.0.1:<port>/status` → 建会话读窗口 → 收尾杀进程 |

**验证命令**（由你运行；探针自身会拉起/结束应用）：

```powershell
cd src-tauri; cargo build
cd ..; node test/e2e/support/wdio-probe.mjs
```

**通过判据**：探针打印 `[probe] status: ok` 与 `[probe] windows: ["main"]`（或等价 JSON）。

**代价**：冷编译（`src-tauri/target` 当前为空）分钟级、数 GB 磁盘；不动 `src/` 业务代码；不改发布行为（该 server 仅在设置 `TAURI_WEBDRIVER_PORT` 时监听）。

**本批刻意不做**：不装 npm 依赖、不建 `desktop` project、不写正式用例——先把「内嵌 WebDriver 能否被 HTTP 驱动」这个最大不确定性验掉，避免带着错误假设做 D1 接线。

### 4.2 插件（`docs/testing/plugins/`）

| 批次 | 用例 | 文档 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| PP0 | 插件 L2 编排骨架 | [e2e/plugin.spec.md](./e2e/plugin.spec.md) | `已实现` | 探针已验证 `dsh web` 启动与就绪行解析 |
| PP1 | pet 会话流路由连上并收到就绪帧 | [plugins/dsh-tauri-pet.md](./plugins/dsh-tauri-pet.md) | `已实现` | 等你跑 `pnpm build:plugins` + `pnpm test:e2e:plugin` |
| PP2 | pet 客户端在真实 dsh 页面里渲染槽位产物 | [plugins/dsh-tauri-pet.md](./plugins/dsh-tauri-pet.md) | `未开始` | 需要 Playwright 库 API（届时才加依赖） |

---

## 5. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-09 | 建立本规则；登记桌面端 D0/D1 提案与插件 PP0/PP1 状态 |
