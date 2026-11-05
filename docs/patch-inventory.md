# 核心文件补丁清单与 asar 可行性（issue #1376）

评估日期 2026-11-04，处置落地 2026-11-05。支持范围以
`apps/desktop/src-tauri/resources/manifest.jsonc` 为准：最低 `0.2.2-rc.1`
（`engines.dsh` 与 `dependencies.dsh.engine` 两处同口径），没有单独的推荐版本，
随包内核与下载目标都跟随 pkg 仓库的最新稳定发行版。

结论：**桌面端不再做任何运行期 Rust patch**。核心 `node_modules/*/lib/*.js` 的改写
移交给 pkg 仓库在打包期用 pnpm patch 固化；不再需要的十项直接删除，能力要么交还
官方，要么下放到插件。

## 支持范围与 asar 资产可用性

| 核心版本 | 在支持范围内 | pkg 是否发布 asar | 44.7.0 直跑 |
| --- | --- | --- | --- |
| `0.2.1-rc.1` | 否（低于基线） | 否，只有 zip | 通过 |
| `0.2.1-rc.4` | 否（低于基线） | 是 | 未验证 |
| `0.2.2-alpha.3` | 否（低于基线） | 是 | 未验证 |
| `0.2.2-rc.1`（最低） | 是 | 是 | 通过 |

asar 资产是 rc.4 才引入的：`dsh-0.2.1-rc.1-39009013600`、`-rc.2-39022695148`、
`-rc.3-39940661749` 三个 release 的资产清单只有六个 zip，没有 `.asar.zip`。把最低
基线提到 `0.2.2-rc.1` 后，asar 直跑不再需要补发历史资产。

Electron 侧不是瓶颈：`node-addon-require-builtin` 的原生包内嵌白名单在 rc.1–rc.5 上
同为 `43.0.0 / 44.0.0 / 44.7.0 / 45.0.0-alpha.6`，与桌面端 `electron-rs` 的
`DEFAULT_VERSION = 44.7.0` 相容。asar 直跑必须钉住 44.7.0，升到 45.x 会在核心 boot
阶段直接 fatal。

## 13 项补丁的最终去向

| # | 补丁 | 目标包 | 处置 |
| --- | --- | --- | --- |
| 1 | `renderer` 导出 `SlotOutlet` | `dsh-client-ui-renderer` | 迁到 pkg 仓库 |
| 2 | `composer` 未分组会话可输入 | `dsh-client-ui-conversation` | 删除，交还官方 |
| 3 | `scroll_follow` 跟随 `data-reduce-motion` | `dsh-client-ui-chat` | 删除，交还官方 |
| 4 | `mobile_composer` 触屏输入 | `dsh-client-ui-conversation` | 删除，官方移动端已优化 |
| 5 | `mobile_sidebar` 移动侧栏宽度 | `dsh-client-ui-layout` | 删除，官方移动端已优化 |
| 6 | `session` 暴露 `SessionStore.remove` | `dsh-session` | 删除，删除逻辑下放到 `dsh-tauri-archive` |
| 7 | `llm_session` OpenCode 会话头 | `dsh-llm-pi-ai` | 迁到 pkg 仓库 |
| 8 | `pi_ai_thinking` `<thinking>` 改道 | `@earendil-works/pi-ai` | 删除，只服务 gpt 优化，优先级低 |
| 9 | `workspace` 工作树会话关联 | `dsh-workspace` | 迁到 pkg 仓库 |
| 10 | `workspace_view` 旧视图状态容错 | `dsh-client-ui-workspace` | 删除，不再做兼容层 |
| 11 | `plugin_visibility` 隐藏 `dsh-tauri-*` | `dsh-client-ui-plugin-manager` | 官方插件页那半迁到 pkg 仓库 |
| 12 | `permission_settings` 保存错误 | `dsh-client-ui-permission-presets` | 删除 |
| 13 | `mcp_startup` 非严格 MCP + OAuth | `dsh-mcp-client` | 删除，上游已提供 `failOnStartupError`，OAuth 不再支持 |

### 删除项的具体理由

- **composer**：`0.2.2-rc.1` 的 `inert` 已经是
  `sessionId === void 0 || hero && chipTitle === void 0 && cwd === void 0`，上游自己
  放宽了未分组会话。桌面端 `dsh-tauri-ui` 的「未分组」入口因此不再需要能力标记，
  判定现在直接读官方语句形态。
- **scroll_follow / mobile_composer / mobile_sidebar**：官方在 `0.2.2-rc.1` 已自带
  移动端与减少动画适配；这三项的必要前提（`dsh-tauri-mobile-ui` 写入的
  `data-dsh-mobile-ui`、`data-dsh-mobile-sidebar`）随该插件一起消失。
- **session**：`dsh-session` 的公开面只有 `enter()` 返回的 detach 闭包，`detachEntered`
  是 private，没有任何按 id 移除的原语；上游也没有计划暴露。改为由
  `dsh-tauri-archive` 自己停止会话活动（`agents.cancel({ kind: 'disposed' })` +
  `whenIdle()`）后删除落盘数据，能力从此不依赖宿主补丁。
- **workspace_view**：桌面端不再为「更新核心写下的视图状态」做容错层。
- **permission_settings**：上游保存失败只 `fail()` 不写 `saveError`；这项属于官方
  设置页的提示缺陷，桌面端不再代偿。
- **mcp_startup**：`0.2.2-rc.1` 的 `dsh-mcp-client` 已内置 `failOnStartupError`
  （默认 `false`，即非严格启动），补丁的前半段因此失效；后半段的 OAuth
  `authProvider` 注入不再提供——如果必须靠 patch 才能支持 OAuth，那就不支持。

### 迁移项

`renderer` / `llm_session` / `workspace` / `plugin_visibility`（官方插件页部分）四项
在 pkg 仓库（`dsh-tauri/deepseek-harness-pkg`）以 pnpm patch 形式固化，随 asar 分发。
`llm_session` 在 `0.2.2-rc.1` 上换过实现：适配器的 `requestHeaders` 已重构成
`(configured, options, baseURL, prepare)` 形态，并额外暴露
`llm-pi-ai/request-headers` waterfall，补丁改为锚定新接口。

`plugin_visibility` 的插件市场那一半（`dshmarket` 的 `INBOX_BUNDLES`）在打包期没有
等效落点：`dshmarket` 只存在于用户 profile，不在 pkg 的依赖树里。该能力从此不再提供。

## 与本次改动配套的调整

- **内核最低基线** `0.2.1-rc.1` → `0.2.2-rc.1`。上面多项删除都以上游在
  `0.2.2-rc.1` 的行为为前提，基线不抬就谈不上「交还官方」。
- **删除 `dsh-tauri-mobile-ui`**：官方客户端自带移动端适配，这个插件不再有存在
  理由。它被加进 `manifest.jsonc` 的 `plugins.depercated`，启动时自动退役。
- **目录型内核**：除本地（npm 全局安装）外不再识别目录型内核；用户若仍有旧的目录
  槽位，按「本地已废弃的 pkg」标记为 orphaned，由用户自行清理。

## Cargo 与依赖补丁

| 补丁 | 内容 | 处置 |
| --- | --- | --- |
| `[patch.crates-io] tauri-runtime` → `vendor/tauri-runtime` | `webkit2gtk` 改可选（`feature = "webkit2gtk"`），Linux 不强制拉系统库 | 上游无此开关，暂时保留 |
| `[patch."https://github.com/hairyf/electron-rs.git"]` → `crates/electron-rs` | `shell.openExternal/openPath` 等主进程能力；`client.node` 也来自这里 | `da080cc` 已在 `hairyf/electron-rs` 的 `origin/main` 上，可改直连 git rev 并删除 path 补丁 |
| `[patch.crates-io] tauri-plugin-notifications` → `crates/tauri-plugin-notifications` | 跨窗口通知去重 + macOS Swift 符号导出 | 未发版；上游合并或发版后删除，当前必须保留（否则 macOS 整模块构建失败） |
| `source/deepseek-harness/patches/*`（8 个 npm 补丁） | 内核参考仓库的 pnpm patch | 不属于本 issue 范围 |

Cargo 层的 `[patch]` 与运行期 JS 补丁是两件事：它们改的是桌面端自己编译进来的
crate，不触碰核心安装目录，asar 迁移不受影响。

## 后续动作

1. 保留项逐条开上游 issue，附锚点原文与期望 API；上游落地后从 pkg 仓库删除对应
   patch，并删掉 `scripts/check-core-patches.mjs` 里的标记。
2. 桌面端 Electron 钉住 44.7.0；升 45.x 前必须先让核心的指纹白名单放开。
3. pkg 仓库打包期与桌面端不能各写一套补丁实现：桌面端已删除全部运行期补丁，
   pkg 是唯一实现处。
