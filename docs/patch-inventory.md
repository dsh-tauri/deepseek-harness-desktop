# 核心文件补丁清单与 asar 可行性（issue #1376）

评估日期 2026-11-04。支持范围以 `apps/desktop/src-tauri/resources/manifest.jsonc` 为准：
推荐 `0.2.1-rc.5`，最低 `0.2.1-rc.1`（`engines.dsh` 与 `dependencies.dsh.engine` 两处同口径）。
锚点核对的结论在**最低支持版本 rc.1 与推荐版本 rc.5 上各做一遍**，两端一致。

asar 样本：rc.5 取自 `deepseek-harness-pkg` release `dsh-0.2.1-rc.5-41234040595` 的
`deepseek-harness-pkg-windows.asar.zip`；rc.1 的 release **没有 asar 资产**（见版本矩阵），
用本机 `dependencies/dsh-0.2.1-rc.1-39009013600` 目录核心经 `@electron/asar@4.3.1 pack` 自行打包。

## 支持范围与 asar 资产可用性

| 核心版本 | 在支持范围内 | pkg 是否发布 asar | 44.7.0 直跑 | 13 项锚点 |
| --- | --- | --- | --- | --- |
| `0.2.1-rc.1`（最低） | 是 | **否**，只有 zip | 通过 | 全部命中 |
| `0.2.1-rc.2` | 是 | **否**，只有 zip | 未验证 | 未验证 |
| `0.2.1-rc.3` | 是 | **否**，只有 zip | 未验证 | 未验证 |
| `0.2.1-rc.4` | 是 | 是 | 未验证 | 未验证 |
| `0.2.1-rc.5`（推荐） | 是 | 是 | 通过 | 全部命中 |

asar 资产是 rc.4 才引入的：`dsh-0.2.1-rc.1-39009013600`、`-rc.2-39022695148`、
`-rc.3-39940661749` 三个 release 的资产清单只有六个 zip，没有 `.asar.zip`。
所以「asar 直跑」在最低支持版本上**需要先补发 asar 资产**才对用户成立，这是 issue #1377
分发的硬前置，不能只在 rc.5 上验证就算完成。

Electron 侧不是瓶颈：rc.1 到 rc.5 的 `node-addon-require-builtin` 都锁 `^0.1.9`，其原生包
内嵌白名单同为 `43.0.0 / 44.0.0 / 44.7.0 / 45.0.0-alpha.6`，与桌面端 `electron-rs` 的
`DEFAULT_VERSION = 44.7.0` 相容。

## 结论

asar 核心**不能承载运行期文件补丁**：asar 是只读归档，对归档内文件写回直接 `EACCES`。
`src-tauri/src/service/patch/` 的 13 项补丁全部依赖「启动前改写 `node_modules/*/lib/*.js`」，
因此在 asar 核心上要么在打包期烘进归档（改 pkg 仓库），要么下放成插件能力，没有第三条路。

在**干净 asar**（未被任何补丁改写过）上逐条核对锚点，13 项全部命中，说明这些补丁当前
都在生效，没有一项因上游已实现而可退役。

## asar 直跑实测

| 项目 | rc.5 | rc.1（自行打包） |
| --- | --- | --- |
| `ELECTRON_RUN_AS_NODE=1 electron.exe <asar>/.../dsh/lib/bin.js --version` | 通过，`0.2.1-rc.5` | 通过，`0.2.1-rc.1` |
| 从 asar 启动 `dsh web --no-open --port` | 通过，未认证返回 401 | 通过，未认证返回 401 |
| 普通 Node 读 asar | 失败（`Cannot find module`） | 同样失败（机制相同，未重复跑） |
| 写归档内文件 | 失败（`EACCES`） | 失败（`ENOENT`，同为只读拒绝） |
| `node-pty` / `koffi` 从归档内加载 | 通过 | 通过 |
| `node-pty` spawn 真终端 | 通过，中文与转义序列正常 | 通过 |
| Electron 44.7.0 | 通过 | 通过 |
| Electron 45.0.0 | 失败，白名单只到 `45.0.0-alpha.6` | 失败，同一白名单同一错误 |

写回被拒的错误码在两个版本上不同（rc.5 报 `EACCES`，rc.1 自打包样本报 `ENOENT`），
但都来自同一条机制：归档内条目没有可写 inode。结论不受影响。

推论：asar 直跑必须钉住 Electron 44.7.0；升到 45.x 会在核心 boot 阶段直接 fatal。

## 13 项核心文件补丁

「rc.1 / rc.5 锚点」列针对未被任何补丁改写过的干净核心（rc.1 用本机目录核心，
rc.5 用官方 asar）。两列都是 `命中` 说明这些补丁在整个支持区间上都能生效，
不依赖某个具体小版本。

| # | 补丁 | 目标文件 | rc.1 / rc.5 锚点 | 去向 |
| --- | --- | --- | --- | --- |
| 1 | `renderer` 导出 `SlotOutlet` | `dsh-client-ui-renderer/lib/client.js` | 命中 / 命中 | 保留 |
| 2 | `composer` 未分组会话可输入 | `dsh-client-ui-conversation/lib/client.js` | 命中 / 命中 | 保留 |
| 3 | `scroll_follow` 跟随 `data-reduce-motion` | `dsh-client-ui-chat/lib/client.js` | 命中 / 命中 | 保留 |
| 4 | `mobile_composer` 触屏输入 | `dsh-client-ui-conversation/lib/client.js` | 命中 / 命中 | 保留 |
| 5 | `mobile_sidebar` 移动侧栏宽度 | `dsh-client-ui-layout/lib/client.js` | 命中 / 命中 | 保留 |
| 6 | `session` 暴露 `SessionStore.remove` | `dsh-session/lib/index.js` | 命中 / 命中 | 可下放（需宿主门面） |
| 7 | `llm_session` OpenCode 会话头 | `dsh-llm-pi-ai/lib/index.js` | 命中 / 命中 | 保留 |
| 8 | `pi_ai_thinking` `<thinking>` 改道 | `@earendil-works/pi-ai/dist/api/openai-completions.js` | 命中 / 命中 | 保留 |
| 9 | `workspace` 工作树会话关联 | `dsh-workspace/lib/index.js` | 命中 / 命中 | 保留 |
| 10 | `workspace_view` 旧视图状态容错 | `dsh-client-ui-workspace/lib/client.js` | 命中 / 命中 | 保留 |
| 11 | `plugin_visibility` 隐藏 `dsh-tauri-*` | `dsh-client-ui-plugin-manager/lib/client.js` | 命中 / 命中 | 保留 |
| 12 | `permission_settings` 保存错误 | `dsh-client-ui-permission-presets/lib/client.js` | 命中 / 命中 | 保留 |
| 13 | `mcp_startup` 非严格 MCP + OAuth | `dsh-mcp-client/lib/index.js` | 命中 / 命中 | 保留 |

### 唯一的可下放项：`session`

`dsh-session` 的公开面只有 `enter()` 返回 detach 闭包，`detachEntered` 是 private，插件拿不到
按 id 的移除原语。`builtin-plugin-archive` 已按 `sessions.remove?.` 做可选调用，缺这个能力时
删除会话会抛「宿主未提供 SessionStore.remove」。下放路径是宿主提供等价门面，而不是继续改
`lib/index.js`；在门面落地前必须保留补丁。

### 保留项的阻碍与替代方案

| 补丁 | 阻碍 | 替代方案 |
| --- | --- | --- |
| `renderer` | `renderer/lib/client.js` 只导出 `SlotRegistry/apply/inject`；`dsh-client-ui-slots` 只导出 `SlotCore` 等纯核心，两处都没有 `SlotOutlet` | 上游补一行导出；或插件自建 outlet（需 `ui-slots` 暴露渲染面） |
| `composer` | 上游 `inert` 仍只看 `chipTitle` | 插件自建 chip 与 composer 座位 |
| `scroll_follow` | 上游 `toBottom` 只认 `prefers-reduced-motion` | 壳侧改 `nativeTheme` 或上游接受 DOM 标记 |
| `mobile_composer` / `mobile_sidebar` | 上游没有 `data-dsh-mobile-ui` 语义 | 插件注册独立移动布局，代价是重复实现侧栏 |
| `llm_session` | 干净 rc.5 的 `requestHeaders` 仍是单参形态 | 上游落该头，或插件在 `ctx.llm` 流上补头 |
| `pi_ai_thinking` | `@earendil-works/pi-ai` 是第三方包 | 依赖升级后重评，或插件在流上做同样扫描 |
| `workspace` | rc.5 把 `sessionPath` 换成 `candidateMatches`，补丁靠双布局匹配维持；`attachSession` 的 cwd 校验仍需放宽 | 上游提供「允许跨目录关联」开关；`builtin-plugin-worktree` 已依赖 `attachSession` |
| `workspace_view` | rc.5 上游仍是 `Object.entries(d.groupExpansion)`，没有 `?? {}` 容错 | 上游加默认值；或插件在读取处自行兜底 |
| `plugin_visibility` | `BUILTIN_PROFILE_BUNDLES` / `INBOX_BUNDLES` 均硬编码，无开关 | 上游提供隐藏开关 |
| `permission_settings` | 上游只 `fail()` 不写 `saveError` | 上游修，或插件另做提示 |
| `mcp_startup` | 上游 `await connection.ready` 与 transport 构造均无钩子 | 上游加 `failOnStartupError` 与 `authProvider` |

## Cargo 与依赖补丁

| 补丁 | 内容 | 处置 |
| --- | --- | --- |
| `[patch.crates-io] tauri-runtime` → `vendor/tauri-runtime` | `webkit2gtk` 改可选（`feature = "webkit2gtk"`），Linux 不强制拉系统库 | 上游无此开关，暂时保留 |
| `[patch."https://github.com/hairyf/electron-rs.git"]` → `crates/electron-rs` | `shell.openExternal/openPath` 等主进程能力；`client.node` 也来自这里 | `da080cc` 已在 `hairyf/electron-rs` 的 `origin/main` 上，可改直连 git rev 并删除 path 补丁 |
| `[patch.crates-io] tauri-plugin-notifications` → `crates/tauri-plugin-notifications` | 跨窗口通知去重 + macOS Swift 符号导出 | 未发版；上游合并或发版后删除，当前必须保留（否则 macOS 整模块构建失败） |
| `source/deepseek-harness/patches/*`（8 个 npm 补丁） | 内核参考仓库的 pnpm patch | 不属于本 issue 范围 |

## 后续动作

1. **先补发 rc.1–rc.3 的 asar 资产**：用户可能停留在最低支持版本，而这几个 release 根本没有
   `.asar.zip`。不补发的话 #1377 的 asar 分发只能是「升级到 rc.4+ 才可用」，这个限制必须写进
   产品文案，不能默认用户已经在 rc.5。
2. 保留项逐条开上游 issue，附锚点原文与期望 API；替代方案落地后删除对应补丁。
3. `session` 的宿主门面先做，才能摘掉第 6 项。
4. 桌面端 Electron 钉住 44.7.0；升 45.x 前必须先让核心的指纹白名单放开。
5. 若 pkg 仓库在打包期烘补丁，必须复用同一份补丁源码，避免打包期与运行期两套实现分叉。
