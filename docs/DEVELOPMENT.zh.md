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
- 端口可配置，占用时可能回退；不保证并行启动时始终使用上述值。
- 档案隔离的是配置，不是操作系统权限。

## 按需采集慢启动

仅诊断偶发慢启动时启用 `DSH_STARTUP_TRACE=1`，默认关闭。先通过应用菜单完全退出桌面端，再从设置了该变量的终端启动；已运行的实例不会继承新变量。Windows PowerShell 示例：

```powershell
$env:DSH_STARTUP_TRACE = '1'
Start-Process 'D:\software\Deepseek Harness Desktop\deepseek-harness-desktop.exe'
Remove-Item Env:DSH_STARTUP_TRACE
```

请按实际安装位置替换可执行文件路径。macOS / Linux 同样需要把变量传给桌面可执行文件，不要只打开已运行的实例。

报告目录由后端日志 `STARTUP_TRACE_ENABLED` 给出：正式版为 `<AppData>/logs/dsh-web.startup/`，Debug 为 `<AppData>/dev/logs/dsh-web.dev.startup/`。每次启动写入一个 `startup-<时间戳>-<PID>.json`；`STARTUP_TRACE` 记录完成原因和文件名。采样在主服务端口开始监听、进程退出或 120 秒超时时停止，不等于页面完全就绪；不对派生子进程和 Worker 继续采样。超时依赖事件循环，JavaScript 阻塞时可能延后；强制终止进程无法写出报告。

报告包含进程 CPU 时间、墙钟时间、事件循环空闲时间、最长定时器间隔，以及脱敏 CPU 调用树（包内相对模块路径、行列号；函数名匿名化）。不记录环境变量、启动参数、请求、令牌、会话内容或完整本地路径，也不改变插件配置。CPU 时间包含多线程，可能超过墙钟时间；`nonCpuWallMs` 是两者之差截断到零，**不能单独用作 I/O 等待时长**。Linux 的采样信号会中断 libuv 的轮询，事件循环空闲时间可能偏低，同样不能当作总等待时长。采样本身有开销，需与一次正常启动报告对照。

复现后仅提供该 JSON 和对应时段的启动日志；常规日志仍可能包含认证令牌，请先脱敏。下次从普通入口启动即关闭采样，报告不会自动上传或删除，可按需手动删除。若出现 `STARTUP_TRACE_PREPARE_FAILED` / `STARTUP_TRACE_FAILED`，本次没有完整报告，但仍继续正常启动。

## 发布参考

- [内置插件与资源指南](<../src-tauri/resources/README.md#built-in-internal-plugins>) — 注册与随包资源
- [macOS 工作流](<../.github/workflows/build-macos.yml>)与[发布工作流](<../.github/workflows/release.yml>) — Developer ID 签名、公证与 CI Secrets
- [资源清单](<../src-tauri/resources/manifest.jsonc>) — 运行时版本、插件清单与预设兼容规则
