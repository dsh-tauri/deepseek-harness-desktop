# Harness 0.2.1-rc.4 兼容记录

## 支持范围与来源

- 推荐与开发依赖基线：`dsh-v0.2.1-rc.4`，`687f282e8625c6b8d11ff58211a90524be2e4317`；[对照源码](<../../../source/deepseek-harness>)固定至该提交，未改用户运行核心。
- 最低支持仍为 `0.1.7-rc.1`，15 个运行插件的 `engines.dsh` 不变；低于下限的版本不受支持，不保证任意第三方插件兼容。
- 已核实打包 tag `dsh-0.2.1-rc.4-39022695148`，build ID `39022695148`，Windows、Linux x64/arm64、macOS x64/arm64 五个 zip 均已发布；推荐与离线回退分别登记，不推算 build ID。
- 对照区间为 `1600d8a1e140dcde43a1a0941940a0480712c011..687f282e8625c6b8d11ff58211a90524be2e4317`：9 次提交、456 个文件，+4921 / -845；GitHub compare 的 300 文件上限不作为完整差异。先前 [rc.1 记录](<./compatibility-0.2.1-rc.1.md>)仅保留历史结果。

## 真实上游变化与本地影响

- 新增 DeepSeek Search / Fetch API 提供方与官方设置开关，默认仍为 Messages 搜索和 HTTP 抓取；`web.searchProvider` / `fetchProvider` 改为 `Volatile`，设置对下一次调用生效。[默认接线](<../../../source/deepseek-harness/packages/bundle/base/cordis.patch.yml#L465-L482>)和[提供方](<../../../source/deepseek-harness/packages/web/web-deepseek-api/src/index.ts#L33-L83>)由发行版内核承载，本仓无 `WebRuntime` 构造或配置对象消费者，不复制另一套搜索设置。未验证付费接口、真实账号或公网搜索结果。
- Messages 辅助搜索显式发送 `thinking: { type: 'disabled' }`，记录事件新增可选字段并调整失败指引；本仓无该事件的自定义解析器，仍交官方内核持久化和展示。
- 新增显示专用的 `1017` 模型标签，限定官方 DeepSeek Flash 路由，不修改模型 id 或目录。它占用既有 `conversation.input.model.label`，不更换本仓模型配置页或选择器实现。
- 载体 host protocol `4`、产品协议 `1`、index 注入、Host/Origin 鉴权、会话 DOM 锚点及语义草稿接缝所在源码目录相对 rc.1 无代码差异。鉴权仅对嵌入环境放行未登录，不能放宽 `403` 或正常 Cookie 通道。
- 保留 PR #1117 的 active-local 原位更新隔离、设置快照保护和“更多”页返回修复；不改 PR #1118 的编码处理与 #1122 的 shim 业务。

## 声明与验证边界

根[声明索引](<../../../THIRD_PARTY_NOTICES.md>)和各包当前核对引用随子模块推进到 rc.4；既有 alpha.1 派生归属及 Scheduler 的原始 SHA 保留，不声称重新复制或重新验证每份派生文件。固定规范不修改；当前推荐、最低支持和解析依赖以[资源清单](<../../../src-tauri/resources/manifest.jsonc>)、[workspace 配置](<../../../pnpm-workspace.yaml>)和[锁文件](<../../../pnpm-lock.yaml>)为准。

本轮独立依赖 `pnpm install --frozen-lockfile --no-trust-lockfile --ignore-scripts` 通过；源码 typecheck 通过。基线、版本、最低声明、远端回退与滚动回归共 7 文件 / 276 项，seed `21201`–`21205` 连续通过；真实 Temp CLI `0.1.7-rc.1` 与 `0.2.1-rc.4` 的鉴权回归各 5 轮通过。真实 rc.4 发行 `ScrollFollow` 提取后应用生产 Rust 替换体，38 项共享契约通过；首次临时提取脚本边界错误导致 SyntaxError，修正提取边界后再验证，不归因于产品代码。1117 导航与更新前端定向回归 3 文件 / 27 项通过。

本地 L2 已实跑，但缺少 `dsh-tauri/dist/index.js`，在 globalSetup 明确失败；未执行插件 Build、未借用其他工作树产物、未触碰旧产物时间戳。Windows 远端 bootstrap 全文件实跑为 52 通过 / 11 失败，失败为 POSIX tar 的 Windows 盘符、执行位、文件权限与 `/bin/sh` 限制，不算全量通过；Linux CI 验证这部分。完整浏览器与原生桌面验证交 PR CI 从当前源码重建，最终结果以检查状态为准。
