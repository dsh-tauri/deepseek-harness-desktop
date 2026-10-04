# 开发

[English](<./DEVELOPMENT.md>) · [中文](<./DEVELOPMENT.zh.md>) · [README](<../README.md>)

Tauri 2 + React 19：前端位于 [`src/`](<../src/>)，Rust 后端位于 [`src-tauri/`](<../src-tauri/>)，插件位于 [`packages/`](<../packages/>)。当前桌面端：`0.20.0-beta.1`；推荐 Harness 内核：`0.2.0-rc.2`。

修改前先读 [AGENTS.md](<../AGENTS.md>) 与[路由规范](<./specs/devlopment.md>)。禁止查看受限归档目录，插件改动期间禁止执行构建。

## 环境要求

| 工具 | 要求 / 来源 |
| --- | --- |
| Node.js | 托管运行时要求 `22.22.0+`，CI 使用 Node 22.x（[清单](<../src-tauri/resources/manifest.jsonc>)、[CI 配置](<../.github/actions/setup-node-pnpm/action.yml>)） |
| pnpm | `11.7.0`，由 [package.json](<../package.json>) 固定 |
| Rust | `1.93+`，推荐当前 stable；本地修补的[通知 crate](<../src-tauri/vendor/tauri-plugin-notifications/Cargo.toml#L14>) 声明了该最低版本。 |

| 平台 | 编译工具链 |
| --- | --- |
| Windows | MSVC C++ 构建工具与 WebView2 |
| macOS | Xcode 16+、Swift 6；通知后端不能仅靠 Command Line Tools 编译（[Cargo.toml](<../src-tauri/Cargo.toml#L46-L48>)） |
| Linux | WebKit2GTK 4.1 开发库；CI 安装 `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`（[CI](<../.github/workflows/ci.yml>)） |

macOS 运行时最低版本为 12+，Web 界面需要 Safari 17.4+ 能力。Linux 运行问题的处理见[在线文档](https://dshtauri.mintlify.site)。

## 开发命令

在仓库根目录执行：

| 命令 | 用途 |
| --- | --- |
| `pnpm install` | 安装工作区依赖 |
| `pnpm dev` | 仅启动 Vite 前端 |
| `pnpm dev:plugins` | 监听插件；修改时复用已有 watcher |
| `pnpm tauri dev` | 调试桌面端；通过 `beforeDevCommand` 启动 Vite |
| `pnpm dev:desktop` | 插件监听与桌面组合命令；`&` 行为取决于 shell |
| `pnpm typecheck` | 前端 TypeScript 检查 |
| `pnpm lint` | ESLint |

跨平台开发建议分别在两个终端运行插件 watcher 与 `pnpm tauri dev`。

`pnpm typecheck` 通过 `tsconfig.typecheck.json` 检查工作区包源码，因此全新检出后只需 `pnpm install`，不依赖生成的声明文件或插件 watcher。构建和运行时仍通过包 exports 解析；CI 会单独构建共享包并验证其产物入口。

**构建保护：** [AGENTS.md](<../AGENTS.md>) 禁止在插件改动期间执行构建。`pnpm build:plugins`、`pnpm build`、`pnpm build:debug`、`pnpm tauri build` 仅用于明确的产物准备 / 发布；`pnpm build` 还会触发插件 prebuild。

## 验证

[package.json](<../package.json>) 中的测试脚本对应以下显式非 watch 命令（[测试规范](<./specs/testing.md>)）：

| 脚本 | 直接执行命令 |
| --- | --- |
| `test` | `node node_modules/vitest/vitest.mjs run` |
| `test:unit` | `node node_modules/vitest/vitest.mjs run --project unit` |
| `test:e2e:plugin` | `node node_modules/vitest/vitest.mjs run --project plugin` |
| `test:e2e:desktop` | `node node_modules/vitest/vitest.mjs run --project desktop` |

E2E 需要已准备好的夹具与运行时，桌面测试还需要 Debug 二进制。请遵循[插件测试指南](<./specs/plugin.test.md>)与[桌面测试指南](<./specs/desktop.test.md>)；不要仅为验证文档或插件修改触发构建。

Rust 检查（仓库根目录）：

```bash
cargo check --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --all-features --locked
```

文档修改使用 `git diff --check`。测试数据必须隔离，不能使用真实用户档案。

## 运行时隔离

| 模式 | Harness 数据 | Store | 默认回环端口 |
| --- | --- | --- | --- |
| Debug | `~/.dsh.dev` | `.store.dev.dat` | `3081` |
| Release | `~/.dsh` | `.store.dat` | `3080` |

- Debug 的运行时、内核与依赖位于 `<AppData>/dev/`；日志为 `<AppData>/dev/logs/dsh-web.dev.log`。
- Debug 忽略继承的 `DSH_HOME`，固定使用 `~/.dsh.dev`，不迁移正式版数据或修改生产 CLI PATH。
- 正式版数据目录由**用户级 `DSH_HOME`** 决定（未设置时是 `~/.dsh`）。Windows 安装器可直接设置该变量；三个平台的「设置 → 数据目录」都能复制数据、校验副本、把旧目录改名保底并改写变量；回滚会用该改名目录还原到原位置。
- 该变量的持久化方式按平台不同：Windows 写 `HKCU\Environment`；macOS 写 `~/Library/LaunchAgents/dsh-tauri.env.plist`，由 LaunchAgent 在登录时重放 `launchctl setenv`（plist 自带的 `EnvironmentVariables` 键到不了 Finder/Dock 启动的应用）；Linux 写 `~/.config/environment.d/dsh-tauri.conf` 与 `~/.profile` 里的标记块。由 launchd 或显示管理器启动的 GUI 应用不继承登录 shell 的环境，因此应用启动时还会自己从磁盘回读一次该变量。
- 端口可配置，占用时可能回退；不保证并行启动时始终使用上述值。
- 档案隔离的是配置，不是操作系统权限。

## 发布参考

- [内置插件与资源指南](<../src-tauri/resources/README.md#built-in-internal-plugins>) — 注册与随包资源
- [macOS 工作流](<../.github/workflows/build-macos.yml>)与[发布工作流](<../.github/workflows/release.yml>) — Developer ID 签名、公证与 CI Secrets
- [资源清单](<../src-tauri/resources/manifest.jsonc>) — 运行时版本、插件清单与预设兼容规则
