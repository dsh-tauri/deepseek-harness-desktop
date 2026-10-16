---
name: handle
description: Used to handle something or issue
metadata:
  author: Hairyf
  version: "2026.04.16"
---

完成后提交 PR，并等待 CI 完成，reviewbot 的意见不重要，但提出的严重问题要处理。

假如用户要求截图，请先查看仓库根目录下的 [docs/specs/screenshot.md](../../docs/specs/screenshot.md)，按规范生成、上传并在 PR 中引用截图。

可能相关的上下文：

## DSH 核心位置

开发版本（`pnpm tauri dev`）

- Window：%APPDATA%/dsh-tauri/dev/dependencies
- macOS：~/Library/Application Support/dsh-tauri/dev/dependencies
- Linux：~/.local/share/dsh-tauri/dev/dependencies

安装版本（release）

- Window：%APPDATA%/dsh-tauri/dependencies
- macOS：~/Library/Application Support/dsh-tauri/dependencies
- Linux：~/.local/share/dsh-tauri/dependencies

> `io.github.hairyf.deepseek-harness-desktop` 是 identifier 缩短为 `dsh-tauri` 之前的历史目录名，
> 现在只用于迁移来源识别；机器上可能仍有旧安装在继续使用它。

## 日志信息

三类日志都落在应用数据目录的 `<base>/logs/` 下（`<base>` 与「DSH 核心位置」同口径，故 dev 在 `dev/` 下）。
唯一的名字差异是核心服务日志：debug 构建写 `dsh-web.dev.log`。各日志按 5 MiB 轮转，保留 `.1 ~ .3`。

> 修正前 logger 未按 `dev/` 隔离，dev 与 release 会抢同一个 `desktop.log`；
> 因此 `%APPDATA%/dsh-tauri/logs/` 下可能还留有迁移前写入的历史日志。

开发版本（`pnpm tauri dev`）

- 主进程：%APPDATA%/dsh-tauri/dev/logs/desktop.log
- 渲染进程：%APPDATA%/dsh-tauri/dev/logs/desktop.frontdesk.log
- 核心进程：%APPDATA%/dsh-tauri/dev/logs/dsh-web.dev.log

安装版本（release）

- 主进程：%APPDATA%/dsh-tauri/logs/desktop.log
- 渲染进程：%APPDATA%/dsh-tauri/logs/desktop.frontdesk.log
- 核心进程：%APPDATA%/dsh-tauri/logs/dsh-web.log

macOS 把 `%APPDATA%` 换成 `~/Library/Application Support`，Linux 换成 `~/.local/share`。
