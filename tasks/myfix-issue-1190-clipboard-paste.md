# Fix Issue #1190: 右键「粘贴」提示无法读取剪贴板

## Issue 概述

- **Issue 编号**: #1190
- **Issue 类型**: bug
- **仓库**: dsh-tauri/deepseek-harness-desktop
- **状态**: In Progress

## 问题描述

Windows 桌面端在对话输入框内右键选择「粘贴」时，顶部提示「无法读取剪贴板，请使用 Ctrl+V」。复现内容包含纯文本、文件与图片，其中复制文件后右键粘贴必然失败；同样的内容用 Ctrl+V 正常。

## 相关链接

- Issue URL: https://github.com/dsh-tauri/deepseek-harness-desktop/issues/1190

## 实现计划

- [x] 理解需求（brainstorming）
- [x] 定位根因：右键粘贴只读纯文本，文件/图片剪贴板无 CF_UNICODETEXT，原生读取返回空
- [x] 编写测试（test-driven-development）：先红 5 个用例，再实现转绿
- [x] 复用宿主 paste 垫片完成文件/图片回退
- [x] 验证：相关 5 个文件 33 passed；全量 unit 5349 passed / 6 skipped；typecheck、ESLint、垫片 JS 语法均通过
- [x] 代码审查（requesting-code-review）：两轮复审通过，无 Critical / Important
- [ ] Windows 真机验证：纯文本、文件、截图三条右键粘贴路径（待有 Windows 环境时确认）

## 进度记录

- 2026-10-21: 开始处理，定位到 `readClipboard()` 仅调用 `read_clipboard_text`；复制文件时 arboard 返回 `ContentNotAvailable`，菜单据此抛出误导性提示。Ctrl+V 正常是因为宿主注入的 `PASTE_SHIM_JS` 会向原生补读文件/图片。
- 2026-10-21: 垫片抽出 `pasteFromNative` 并暴露 `__dsh_paste_clipboard__`；右键粘贴在无文本时调用它，原生读取失败写入 `console.warn`。
- 2026-10-21: 当前账号对 upstream 仓库只有 pull 权限且无 fork，分支未推送。
- 2026-10-21: 两轮代码审查通过。新增 vm 执行型契约测试，并做变异验证（移除垫片全局后 6 个用例变红）。Windows 真机三条路径仍待确认。
