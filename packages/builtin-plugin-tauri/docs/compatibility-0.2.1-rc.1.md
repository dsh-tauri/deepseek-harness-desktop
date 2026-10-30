# Harness 0.2.1-rc.1 兼容记录

> 历史记录：下文的当前基线与验证结果仅描述 rc.1 当时状态；当前推荐 `0.2.1-rc.2`，最低支持仍为 `0.1.7-rc.1`，见[当前兼容记录](<./compatibility-0.2.1-rc.2.md>)。原核对区间、来源 SHA 与历史结果保留不改。

## 当前支持范围与来源

- 当前推荐与开发核对基线：`dsh-v0.2.1-rc.1`，`1600d8a1e140dcde43a1a0941940a0480712c011`；本地[对照源码](<../../../source/deepseek-harness>)已切至该提交。
- 最低支持内核仍为 `dsh-v0.1.7-rc.1`，`46a7f68b0922371ce7144b668b90e377d8e799f4`。更早内核不再支持；历史日志和派生来源不构成支持承诺。
- 已核实的推荐打包 tag：`dsh-0.2.1-rc.1-39009013600`，build ID `39009013600`。源码 tag 与打包 tag 独立登记，不从版本号推算 build ID。
- 上一声明/开发基线为 `dsh-v0.2.1-alpha.1`（`5badb15009ae1756c3afe0ae0cef1faafc290ccc`），不复用其通过数量。更早的 [alpha.1 记录](<./compatibility-0.2.1-alpha.1.md>)只对其原核对区间成立。

## 定点静态核对

下表 10 个文件只证明接口或 DOM 锚点存在，不证明整个派生源码树相同，也不替代运行验证。

| 接缝 | 本次回读文件与约束 |
| --- | --- |
| 桌面载体 | [host protocol](<../../../source/deepseek-harness/apps/desktop/src/host-protocol.ts#L4>) 与 [preload](<../../../source/deepseek-harness/apps/desktop/src/preload-app.ts#L13-L58>)：host protocol `4`、产品 `protocolVersion: 1`；不伪造未实现的 Electron 能力。 |
| index 注入 | [injections](<../../../source/deepseek-harness/packages/host/webserver/src/injections.ts#L15-L104>)：保留六类注入行及末尾 `__DSH_BOOT_READY__` 就绪流程。 |
| 鉴权 | [Connection](<../../../source/deepseek-harness/packages/client/connection/src/rpc.ts#L227-L266>)、[宿主实现](<../../../source/deepseek-harness/packages/client/connection/src/rpc-host.ts#L123-L136>)、[静态入口](<../../../source/deepseek-harness/packages/host/frontend-static/src/index.ts#L85-L90>)、[open-in-app](<../../../source/deepseek-harness/packages/host/open-in-app/src/index.ts#L184-L190>)：保留 `requestRejection` / `authorizeIndex`、Host/Origin 与存活 Peer 检查；嵌入免登录不放宽 `403` 或正常 Cookie 车道。 |
| 会话 DOM | [ChatNodeSeat](<../../../source/deepseek-harness/packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx#L145-L160>) 与 [ChatGroupSeat](<../../../source/deepseek-harness/packages/client/ui-chat/src/client/chat/ChatGroupSeat.tsx#L185-L199>)：沿用语义 flow/node/group/anchor 锚点，不把私有 class 当稳定接口。 |
| 语义草稿 | [输入 facade](<../../../source/deepseek-harness/packages/client/ui-conversation/src/client/input/facade.ts#L272-L283>)：保留 `draftSnapshot` 与 `persistCurrentDraft()`，失败时不先清除来源草稿。 |

## 声明与派生来源

根[声明索引](<../../../THIRD_PARTY_NOTICES.md>)中 Harness source 行及各包当前参考版本为 rc.1，保留 alpha.1 等历史派生来源与 [Scheduler 声明](<../../dsh-tauri-scheduler/THIRD_PARTY_NOTICES.md#L45-L65>)的 `ec48669f48ac81bac353fc646e7cf9c57241242f`，未宣称重新复制所有文件。

推荐版本不代替最低版本：15 个具 `dsh` 元数据的运行插件仍以根级 `engines.dsh: ">=0.1.7-rc.1"` 声明支持下限；[最低版本回归](<../../../test/plugin-version-baseline.test.ts>)读取真实清单、检查精确范围与 `includePrerelease` 准入，允许 floor / rc.1、排除 `0.1.6` 和低于 floor 的同代预发布；不证明最低内核完整运行通过。私有聚合包 `dsh-tauri-bundle` 与纯构建包 `dsh-tauri-tsdown` 不在这 15 个运行插件内。固定规范不改；依赖实际解析以 [workspace 配置](<../../../pnpm-workspace.yaml>)与 [lockfile](<../../../pnpm-lock.yaml>)为准。

## 验证与限制

- 最低版本声明、打包元数据、导航和配置契约共 5 个文件 / 158 项，shuffle seed `73411`、`73412`、`73413`、`73414`、`73415` 连续通过，其中最低声明回归为 121 项。
- 客户端适配与内置插件定向回归 47 个文件 / 1023 项，shuffle seed `1701`、`1707`、`1717`、`1723`、`1733` 连续通过；后续 scheduler 收尾回归 34 个文件 / 809 项，seed `1801`、`1807`、`1817`、`1823`、`1831` 连续通过。两组有重叠，不合并为全量计数。
- 发布版 CLI `0.1.7-rc.1` 与 `0.2.1-rc.1` 的真实宿主鉴权定向回归均通过，覆盖拒绝、嵌入连接、解绑恢复以及 Host/Origin 限制；这不等于两端完整浏览器套件通过。
- “更多”页回退定向回归 2 个文件 / 15 项，shuffle seed `4301`–`4305` 连续通过。布局、会话当前项和 scheduler setup 的临时变异均被相应回归拦截，恢复后重新通过。
- 版本、档案及核心更新前端回归 14 个文件 / 236 项，shuffle seed `17091`–`17095` 连续通过，含原生完整错误前缀的字符串与 `Error` 两种返回；五类临时变异均被拦截。
- 原生本地更新及设置回写焦点回归 4 组 / 每轮 44 项，轮换顺序连续五轮通过，共 220 项执行，含 55 次隔离子进程场景。旧快照覆盖选核与活动本地核心原位更新均先取得真实红测；成功、失败、转换锁等待/持有以及受管核心缺失或版本不支持均使用独占临时目录与假包管理器验证，不执行真实 npm。临时撤除更新前的 App 固定后，成功更新场景按预期变红；恢复后旧快照用例和 11 个隔离场景重新通过。
- Native 前端 16 个文件 / 586 项，shuffle seed `73501`–`73505` 连续通过；测试隔离、构建新鲜度及升级保护 5 个文件 / 82 项，seed `601`–`605` 连续通过，人工集成的非法配置及 CI 禁入另有真实配置加载失败验证。

本地未执行插件 Build。源码已变更后的旧插件和桌面产物会被 freshness gate 拒绝；完整浏览器套件、真实桌面几何/启动隔离及三平台原生结果待 PR CI 重建后确认。Windows 全量单测记录为 5902 通过、13 失败、6 pending（5921 总项）；13 项失败均在 remote 测试，涉及 POSIX `tar`、`438` / `384` 文件模式、symlink `EPERM`、Git Bash Windows 路径及 shim 执行位限制。相关 bootstrap 安装布局失败亦已独立复现，不将这些失败、定点源码回读或上述定向通过记为全量通过，也不据此宣称派生文件相同。
