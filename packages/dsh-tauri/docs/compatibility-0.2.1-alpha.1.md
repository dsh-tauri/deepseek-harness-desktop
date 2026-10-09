# Harness 0.2.1-alpha.1 兼容核对

本轮只推进必须兼容的 Harness 源码与开发依赖基线，不同步其他 `source/` 仓库或桌宠资产；默认推荐内核仍为 rc.2，避免普通用户收到 alpha 更新提示。

## 版本与来源

- 桌面仓库起点：`1697467a5c5762c7d53a021a37aca09d1ef56796`。
- 原依赖及声明基线：`dsh-v0.2.0-rc.2`，`639ed015397290b3745d163aafe02ffee4aa3f84`。
- 原实际 gitlink：`aa8262ec091698bae9a6b04773a6b5b06ad4aef2`，并非声明中的 rc.2；本轮一并纠正。
- 目标：`dsh-v0.2.1-alpha.1`，`5badb15009ae1756c3afe0ae0cef1faafc290ccc`。
- 版本区间：rc.2 → alpha.1 共 266 commits；以目标 tag 的净差异核对本地消费者。
- 配套 Cordis：`4.0.5-alpha.1`，Group `1.0.5-alpha.1`，Include `1.0.10-alpha.1`，Loader `1.0.6-alpha.1`。显式钉住后三者，避免 pnpm 自动选择旧 peer，造成两个不一致的 `Context` 类型增广面。
- 兼容目标产物：`dsh-tauri-desk/deepseek-harness-pkg` 的 `dsh-0.2.1-alpha.1-37117505103`，已核实 Windows、Linux、macOS arm64/x64 四份 zip；不从核心 tag 推测打包 build ID。桌面与 SSH 的默认推荐仍是 rc.2，SSH 回退 tag 保持 `dsh-0.2.0-rc.2-36556493178`；显式 alpha pin 的解析由回归验证。

## 声明索引逐项核对

| 包 | 目标上游契约 | 本地处理 |
| --- | --- | --- |
| `dsh-tauri` | connection 闸门、webserver 注入行、账号 watch、preload carrier 与 host protocol | 10 份载体契约文件与 rc.2 blob 相同；保留现有鉴权、`protocolVersion: 1` 与 host protocol 4 |
| `dsh-tauri-model` | `packages/client/ui-settings-models/src/` | 派生源码树未变；保留模型编辑器、账号/凭据隔离与 LiteLLM 目录 |
| `dsh-tauri-extension` | `packages/skill/skill-filesystem/src/`、`packages/mcp/mcp-client/src/` | 源码未变；provider 配置、policy 与 MCP 子集不变 |
| `dsh-tauri-pet` | official skill provider、account menu、workspace list、StateDot | 继续消费官方服务；动画重启修复随 re-export 生效，资产 pin 不变 |
| `dsh-tauri-rightclick` | sessions / workspaces 与 primitives Menu | `startSession` 的新参数可选，不影响现有 open/archive/fork/pin 路径 |
| `dsh-tauri-experimental` | reference insertion、input state、input dock | 无 `stats` 整行覆盖；保留独立 running-changes 注册与排序 |
| `dsh-tauri-archive` | sidebar 菜单/行与 sessions / workspaces | sidebar 源码未变；保留适配层 open 路径与自有 archive 功能 |
| `dsh-tauri-ui` | primitives、ui-layout、hero/settings slots | StateDot 修复由官方实现承接；新增 InlineEditor 与 `shell.bottom` 不要求本地新增 UI |
| `dsh-tauri-ui-playground` | `dsh-tauri-ui/client` registry | 继续消费共享组件，无独立官方源码副本 |
| `dsh-tauri-worktree` | semantic draft 与 session input | 迁移及回滚完整 `{ text, references }`，保留引用身份、顺序、标点与换行；语义输入存在但暂取不到 snapshot 时，在建目标/清源前失败；旧内核保留文本动作 |
| `dsh-tauri-scheduler` | agent / approval / session / llm 与 Web Schedule 默认值 | 更新官方 Schedule 默认启用的声明；两套 service、工具名与任务存储保持独立，不覆写上游默认值 |

根 `THIRD_PARTY_NOTICES.md` 仅更新表格中的 Harness 版本与 hash。各包保留旧同步历史、许可证和其他上游 pin，并追加本轮兼容结论。`docs/specs/upstram.sync.md` 标为固定文档，本轮不改；当前基线以子模块、依赖、声明索引及本包日志为准。

## 七类接缝

| 接缝 | 核对结论 |
| --- | --- |
| 源码/实例补丁 | embedded 鉴权仍保留 Host/Origin fence；不改上游源码以隐藏兼容问题 |
| 事件与持久化 | session 事件顺序及消费者不变；草稿由官方 input shell 与挂载 persistence action 保存 |
| service / Remote | 账号、技能、MCP、审批及现有导航入口仍可用；检查配套 peer 与 Context 增广归属 |
| 宿主文件系统 | 不迁移真实用户目录、session log 或第三方资产 |
| UI / 命令 / 工具 | `stats` → `activity` / `usage` 无本地整行替换；未使用移除的 `./invariant` 导出；根插件入口不依赖子路径独立 package.json |
| HTTP / DOM / CSS | 载体闸门与 index 注入不变；保留自有菜单、输入 dock 与窗口接缝 |
| 子进程与输出 | 默认继续推荐 rc.2；核对显式 alpha pin 的真实打包 tag，沿用现有启动、探针与清理路径 |

## 验证边界

- 原始类型检查与 lint 通过；最终类型检查通过。新增回归覆盖引用草稿恢复、缺能力拒绝、恢复失败、真实组件的切换与回滚，以及显式 SSH alpha pin 的解析。
- 最终 lint 无 error/warning；65 个聚焦用例连续 5 次 shuffle seed（501–505）全部通过，新增保护默认仍推荐 rc.2 与语义捕获失败前不得清源。把语义草稿恢复变异为只写文本后，4 个回归用例失败，恢复实现后草稿/组件用例全部通过。
- 新克隆无插件产物，当前会话还继承 `NODE_ENV=production`。本地验证使用独立 `DSH_HOME`、`NODE_ENV=test` 与临时源码 alias；该配置不提交，不替代产物验证。
- 同配置源码单测：迁移前 3191 passed / 31 failed，首轮迁移后 3195 passed / 同一 31 failed。4 份既有失败文件为 AppImage shell、macOS toolchain、store persistence 与 SSH POSIX/权限测试；不把它们计为迁移回归，也不删除断言。
- CI 保留 `0.1.5-rc.2` 旧内核车道，将 current core 钉到 `0.2.1-alpha.1`，新增宿主、模型、工作树、Scheduler 与 experimental 的真实产物回归；既有官方插件、appearance 和移动设置仍按 5 个 shuffle seed 验证。
- 本地遵守仓库不执行插件 build 的约束。构建、真实浏览器挂载及三平台原生产物由 PR CI 取证；模型凭据调用不包含在本地通过结论中。

## 回滚

本轮未改变已安装桌面应用、默认推荐版本或真实 DSH Profile。若需撤销贡献，回退本 PR 的提交即可同时恢复原 gitlink、catalog/lockfile 及草稿适配；原始子模块状态为 `aa8262e`，原声明/依赖基线为 rc.2，二者的历史不一致也会随回退恢复。

## 上游依据

- [目标 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.1)
- [rc.2 → alpha.1 完整变更区间](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.0-rc.2...dsh-v0.2.1-alpha.1)
- [目标 input shell](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-conversation/src/client/input/facade.ts)
- [目标 semantic draft 与引用坐标](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-conversation/src/client/contract/draft-editor.ts)
- [目标 Web 组合及 Schedule 默认值](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/bundle/web-app/cordis.patch.yml)
- [已发布的打包产物](https://github.com/dsh-tauri-desk/deepseek-harness-pkg/releases/tag/dsh-0.2.1-alpha.1-37117505103)
