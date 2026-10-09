<p align="center">
  <a href="https://github.com/dsh-tauri/deepseek-harness-desktop">
    <img src="public/deepseek-harness-desktop-tauri.svg" width="96" alt="DeepSeek Harness Tauri Desktop" />
  </a>
</p>

<h1 align="center">DeepSeek Harness Tauri 桌面版</h1>

<p align="center">
  在桌面上运行 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> ——<br />
  无需手动安装 Node.js、pnpm 或 Docker；普通安装首次启动可能需要联网初始化。
</p>

<p align="center">
  <img alt="Windows" src="https://img.shields.io/badge/-Windows-blue?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB0PSIxNzI2MzA1OTcxMDA2IiBjbGFzcz0iaWNvbiIgdmlld0JveD0iMCAwIDEwMjQgMTAyNCIgdmVyc2lvbj0iMS4xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHAtaWQ9IjE1NDgiIHdpZHRoPSIxMjgiIGhlaWdodD0iMTI4Ij48cGF0aCBkPSJNNTI3LjI3NTU1MTYxIDk2Ljk3MTAzMDEzdjM3My45OTIxMDY2N2g0OTQuNTEzNjE5NzVWMTUuMDI2NzU3NTN6TTUyNy4yNzU1NTE2MSA5MjguMzIzNTA4MTVsNDk0LjUxMzYxOTc1IDgwLjUyMDI4MDQ5di00NTUuNjc3NDcxNjFoLTQ5NC41MTM2MTk3NXpNNC42NzA0NTEzNiA0NzAuODMzNjgyOTdINDIyLjY3Njg1OTI1VjExMC41NjM2ODE5N2wtNDE4LjAwNjQwNzg5IDY5LjI1Nzc5NzUzek00LjY3MDQ1MTM2IDg0Ni43Njc1OTcwM0w0MjIuNjc2ODU5MjUgOTE0Ljg2MDMxMDEzVjU1My4xNjYzMTcwM0g0LjY3MDQ1MTM2eiIgcC1pZD0iMTU0OSIgZmlsbD0iI2ZmZmZmZiI+PC9wYXRoPjwvc3ZnPg==" />
  <img alt="MacOS" src="https://img.shields.io/badge/-MacOS-black?style=flat-square&logo=apple&logoColor=white" />
  <img alt="Linux" src="https://img.shields.io/badge/-Linux-yellow?style=flat-square&logo=linux&logoColor=white" />
</p>

<p align="center">
  <a href="https://github.com/dsh-tauri/deepseek-harness-desktop/releases">
    <img src="https://img.shields.io/github/v/release/dsh-tauri/deepseek-harness-desktop?&label=Release&color=4D6BFE" alt="Release" />
  </a>
  <img src="https://img.shields.io/badge/DSH-0.2.0--rc.2%2B-4d6bfe" alt="DSH 0.2.0-rc.2" />
  <img src="https://img.shields.io/github/license/dsh-tauri/deepseek-harness-desktop" alt="MIT License" />
  <br>
  <img src="https://img.shields.io/github/downloads/dsh-tauri/deepseek-harness-desktop/total?&label=downloads&color=4D6BFE" alt="Downloads" />
  <img src="https://img.shields.io/github/stars/dsh-tauri/deepseek-harness-desktop?&label=stars&color=4D6BFE" alt="Stars" />
  <img src="https://img.shields.io/github/contributors/dsh-tauri/deepseek-harness-desktop?&label=contributors&color=4D6BFE" alt="Contributors" />
  <img src="https://img.shields.io/github/commit-activity/m/dsh-tauri/deepseek-harness-desktop?&label=commits&color=4D6BFE" alt="Commit activity" />
</p>

<p align="center">
  <samp><a href="https://dshtauri.mintlify.site/zh-CN/installation">Download</a> · <a href="./README.en.md">English</a> · <a href="./README.es.md">Español</a> · <a href="https://dshtauri.mintlify.site">文档</a> · <strong>中文</strong></samp>
</p>

<p align="center">
  <a href="https://trendshift.io/developers/13307?utm_source=developer-badge&amp;utm_medium=badge&amp;utm_campaign=badge-developer-13307" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/developers/13307" alt="hairyf | Trendshift" width="250" height="55"/></a>
  <a href="https://trendshift.io/repositories/151676?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-151676" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/151676/weekly?language=Rust" alt="dsh-tauri%2Fdeepseek-harness-desktop | Trendshift" width="250" height="55"/></a>
  <a href="https://trendshift.io/repositories/151676?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-151676" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/151676/daily?language=Rust" alt="dsh-tauri%2Fdeepseek-harness-desktop | Trendshift" width="250" height="55"/></a>
</p>

<img width="2280" height="1398" alt="image" src="https://github.com/user-attachments/assets/8e5d703b-8741-48ca-951b-a3ccaedcc531" />

## 功能

- 🪶 **原生桌面** — Tauri 2 + React 19 + Hero 3，内嵌本地 Harness 界面。
- 🔄 **运行时管理** — 安装依赖、选择内核版本，并提供桌面端与内核更新入口。
- 🧩 **插件管理** — 12 个内置插件；支持本地路径安装、内置插件停用、社区插件安装、升级、卸载与错误查看。
- 🗂️ **档案配置** — 分别管理插件与设置，支持一键迁移档案数据、备份、克隆；
- 💽 **数据目录** — 安装时（Windows）可选择数据存放位置；能在设置里整体迁移与回滚。
- ⌨️ **命令行集成** — 通过托管 shim 提供 `dsh` / `pnpm` 命令行工具，不是全局 npm 内核安装。
- 🐾 **桌宠** — Pets / Codex 资源管理、资源包导入与会话状态展示；预设素材来自远端。
- 🎨 **个性化** — 8 种配色、本机界面缩放、终端模式，以及可调不透明度与可选磨砂模糊。

## 内置插件

随桌面资源分发的一方插件：

- [DSH Tauri](https://dshtauri.mintlify.site/zh-CN/built-in-plugins/dsh-tauri) — 核心插件，桌面端与 Harness 通信、版本适配器、插件依赖管理
- [DSH Tauri UI](https://dshtauri.mintlify.site/zh-CN/built-in-plugins/dsh-tauri-ui) — 桌面设置界面、原生核心组件、主题与配色
- [DSH Tauri Mobile UI](https://dshtauri.mintlify.site/zh-CN/built-in-plugins/dsh-tauri-mobile-ui) — 触屏布局与移动端偏好设置
- [DSH Tauri Worktree](https://dshtauri.mintlify.site/zh-CN/built-in-plugins/dsh-tauri-worktree) — 会话级 Git 工作树与检出
- [DSH Tauri Extension](https://dshtauri.mintlify.site/zh-CN/built-in-plugins/dsh-tauri-extension) — 官方插件管理、插件市场、Skills 与 MCP
- [DSH Tauri Scheduler](https://dshtauri.mintlify.site/zh-CN/built-in-plugins/dsh-tauri-scheduler) — 定时任务与执行记录
- [DSH Tauri Archive](https://dshtauri.mintlify.site/zh-CN/built-in-plugins/dsh-tauri-archive) — 聊天归档与恢复
- [DSH Tauri Pet](https://dshtauri.mintlify.site/zh-CN/built-in-plugins/dsh-tauri-pet) — 桌宠与活动状态设置
- [DSH Tauri Rightclick Menu](https://dshtauri.mintlify.site/zh-CN/built-in-plugins/dsh-tauri-rightclick) — 会话、工作区与正文右键菜单
- [DSH Tauri Model](https://dshtauri.mintlify.site/zh-CN/built-in-plugins/dsh-tauri-model) — 模型选择与参数、自动配置模型
- [DSH Tauri SSH](https://dshtauri.mintlify.site/zh-CN/built-in-plugins/dsh-tauri-ssh) — SSH 远端 Harness 连接与同步
- [DSH Tauri Notification](https://dshtauri.mintlify.site/zh-CN/built-in-plugins/dsh-tauri-notification) — 原生级会话通知与交互操作

## 可选预设

启动引导提供以下社区插件，可按需安装；

- [DSH Market](https://github.com/dsh-market/dsh-market) — 社区插件市场
- [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) — 按会话隔离的右编辑器侧栏
- [Billion Context](https://github.com/ranxianglei/billion-context) — 上下文压缩与历史恢复
- [DSH Rewind](https://github.com/SiriLee/dsh-rewind) — 对话回退与工作区备份
- [DSH Bridge](https://github.com/wenbin-wb/dsh-bridge) — 远程访问、隧道接入
- [DSH IM](https://github.com/xmanrui/dsh-im) — IM 渠道与机器人管理

新增或更新预设请提交 [Issue](https://github.com/dsh-tauri/deepseek-harness-desktop/issues)；可用版本由清单中的内核兼容规则决定。

## 快速开始

从 [Releases](https://github.com/dsh-tauri/deepseek-harness-desktop/releases) 下载对应平台与架构的安装包：

| 平台 | 要求 | 安装包 |
| --- | --- | --- |
| Windows | Windows 10+、WebView2 | x64 `.exe` / `.msi` |
| macOS | macOS 12+；Web 界面需 Safari 17.4+ 能力 | Intel / Apple Silicon `.dmg` |
| Linux | WebKit2GTK 4.1 运行库 | x64 `.AppImage` / `.deb` |

macOS 也可通过 Homebrew 安装：

```bash
brew install dsh-tauri/desktop/deepseek-harness
```

- 普通安装包首次启动需联网下载缺失的运行时与内核；Git 功能需要可用的 Git。
- 包含 `Bundle` 后缀为离线安装包（`_Bundle_*.exe`、`_Bundle_*.deb`、两种 `_Bundle_*.dmg`）。
- 本地运行不等于完全离线：模型服务、插件安装、更新与桌宠预设素材仍可能联网。
- Linux 显示、Wayland、AppImage 与权限问题的处理见[安装与故障排查文档](https://dshtauri.mintlify.site/zh-CN/help/troubleshooting)。

### 桌面代理

- 在**配置 → 应用 → 代理地址**设置 HTTP、HTTPS、SOCKS5 或 SOCKS5H 代理。
- 仅用于桌面端依赖/内核下载、更新检查及插件元数据，不修改模型请求或插件子进程的网络配置。
- 留空沿用系统/环境代理；保存后对新请求生效，可重试失败的下载。
- SOCKS5H 通过代理解析目标域名；本机回环连接始终直连。

## 运行方式

Windows 启动失败时会通过原生对话框显示具体错误。若出现 `STARTUP_LOW_INTEGRITY`：

- 进程低于 Medium 完整性级别，无法写入正常用户数据；更新后的程序可能继承安装目录的 Low 标签。
- 用 `icacls` 检查目录与程序；将可信安装恢复为 Medium，或重新安装到正常目录。
- 以管理员身份运行不会移除 Low 标签限制；无需删除会话或修改 `DSH_HOME`。

| 当前基线 | 版本 |
| --- | --- |
| 推荐 Harness 内核 | `0.2.0-rc.2` |
| 声明的内核最低版本 | `0.1.5-rc.1`，不保证所有兼容 |

- 内核与预设选择遵循[资源清单](<./src-tauri/resources/manifest.jsonc>)及插件声明的版本范围；不保证任意最新上游版本都兼容。
- 正式版默认启用 CLI 集成：Windows / macOS / Linux 自动更新 PATH。需重新打开终端，其他 shell 仍需要手动配置。

## 交流

<table>
  <tr>
    <td align="center"><img src="./docs/images/community/qq.png" width="180" height="180" alt="QQ 群二维码" /><br /><strong>QQ 群</strong></td>
    <td align="center"><img src="./docs/images/community/wechat.png" width="180" height="180" alt="微信群二维码" /><br /><strong>微信群(已满,请先加微信) →</strong></td>
    <td align="center"><img src="./docs/images/community/wechat-hairy.png" width="180" height="180" alt="微信群二维码" /><br /><strong>微信</strong></td>
  </tr>
</table>

## 开发

参见[中文开发指南](<./docs/DEVELOPMENT.zh.md>)或[英文开发指南](<./docs/DEVELOPMENT.md>)。功能详情见[在线文档](https://dshtauri.mintlify.site)。

## 说明

> [!WARNING]
> **开发预览** — 上游 `dsh` 仍在快速迭代，可能存在破坏性变更；升级前请确认兼容性。

> [!NOTE]
> **安全声明** — `dsh` 具备本地代码执行能力。仅供学习 / 研究 / 测试，请在可信、隔离的环境中使用。

## 相关项目

- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — 上游 `dsh` agent 平台
- [deepseek-harness-pkg](https://github.com/dsh-tauri/deepseek-harness-pkg) — 预打包 Harness 发行版与下载源
- [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) · [dsh-pet-mov](https://github.com/dsh-tauri/dsh-pet-mov) · [dsh-pet-component](https://github.com/dsh-tauri/dsh-pet-component) — 桌宠素材与渲染组件
- [dsh-plugin-codex-pets](https://github.com/Skylarking/dsh-plugin-codex-pets) · [BongoCat](https://github.com/ayangweb/BongoCat) · [dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) · [codex-to-dsh-pet](https://github.com/Signalight/codex-to-dsh-pet) — 桌宠参考项目

## Contributors

![Contributors](https://contrib.rocks/image?repo=dsh-tauri/deepseek-harness-desktop)

## License

[MIT](<./LICENSE>)，附加[非商用条款](<./LICENSE.details>) © deepseek-harness-desktop contributors
