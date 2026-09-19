# 上游同步日志

用于记录 `dsh-tauri-panel-extension` 与上游能力管理插件
[`qinyre/dsh-plugin-capabilities`](https://github.com/qinyre/dsh-plugin-capabilities) 的同步进度，方便后续继续对照和移植。

## 当前状态

- 最后对照上游版本：`0.3.10`
- 上游仓库路径：`source/dsh-plugin-capabilities`（`git submodule`，HEAD 与基线一致）
- 上游 HEAD：`e5e3596`（`mcp: card actions align right and wrap as a block; compact labels (0.3.10)`）
- 当前扩展版本：`0.6.7`
- 本次同步 PR：[#413](https://github.com/dsh-tauri-desk/deepseek-harness-desktop/pull/413)
- 本次同步提交：`60267cd`；CI lint 修复提交：`7f4fc95`
- 同步范围：MCP 管理能力；**未同步 Market 模块**

## 已同步能力

### MCP 宿主侧

- [x] profile / global 两层 patch 合并展示
- [x] scope-aware 的列表、保存、启用/禁用、删除
- [x] global/profile scope 标记及 profile `shadowed` 状态
- [x] 跨层复制 MCP 行
- [x] stdio 命令 PATH 检查
- [x] streamable-http 可达性检查
- [x] profile 与 global patch YAML 语法错误诊断
- [x] Claude Code / Codex 导入
- [x] Cursor 导入：`~/.cursor/mcp.json`
- [x] Gemini CLI 导入：`~/.gemini/settings.json`
- [x] 导入目标作用域选择

对应文件：

- `src/host/service/mcp.ts`
- `src/host/service/agents.ts`
- `src/host/routes/mcp.ts`
- `src/host/routes/index.ts`

### MCP 客户端侧

- [x] scope 标签、覆盖提示和 global error 提示
- [x] 连通性检查按钮及检查中状态
- [x] Cursor / Gemini 导入分组
- [x] MCP API、类型、locale 和导入工具同步
- [x] 卡片操作区域适配窄面板布局

对应文件：

- `src/client/components/mcp-tab.tsx`
- `src/client/apis/index.ts`
- `src/client/apis/index.type.ts`
- `src/client/types/mcp.ts`
- `src/client/utils/mcp.ts`
- `src/client/locales/index.ts`

## 有意保留的差异

- 侧栏扩展的路由前缀随桌面统一为 `/api/desktop/dsh-tauri-panel-extension/*`，不改为上游的 `/dsh-plugin-capabilities/*`。
- MCP 管理继续写入当前扩展约定的 profile / DSH home 路径。
- 不移植上游设置页的“技能与 MCP”一级标题。
- 不移植上游 Market（技能市场 / MCP 市场）模块；扩展面板新增的「市场」标签页（`src/client/components/market-tab.tsx`）不来自该上游，而是直接消费 `dshmarket` 经 `ctx.provide('market')` 发布的 `render()` 面板，详见 `docs/specs/upstram.sync.md` §5。
- 技能仓库仍沿用侧栏扩展的精简“导入仓库”流程。
- 侧栏扩展既有的 JSON / 表单双模式 MCP 编辑器保留。

## 后续同步流程

1. 更新 `source/dsh-plugin-capabilities`：

   ```sh
   git -C source/dsh-plugin-capabilities fetch --all --tags
   ```

   （工作区 HEAD 停在已采纳基线 `e5e3596`，不要 `pull` / `checkout` 推进它。）

2. 查看上次同步之后的提交：

   ```sh
   git -C source/dsh-plugin-capabilities log --oneline e5e3596..origin/main
   ```

3. 重点对照：
   - 上游 `src/mcp.ts` 与本地 `src/host/service/mcp.ts`
   - 上游 `src/agents.ts` 与本地 `src/host/service/agents.ts`
   - 上游 `src/routes.ts` 与本地 `src/host/routes/mcp.ts`
   - 上游 `src/client/*` 与本地 `src/client/*`
   - 上游 README 的版本功能说明

4. 移植时保持本文件的“有意保留的差异”不被误合并；尤其不要直接覆盖 API 前缀、侧栏协议和 Market 取舍。

5. 完成后更新本文件的“当前状态”、勾选清单、上游 HEAD 和提交范围，并运行：

   ```sh
   pnpm install --frozen-lockfile
   pnpm run lint --fix
   pnpm --filter dsh-tauri-panel-extension build
   pnpm --filter dsh-tauri-panel-extension typecheck
   pnpm test
   ```

## 验证记录

| 日期 | 结果 | 说明 |
| --- | --- | --- |
| 2026-09-07 | 通过 | `pnpm install --frozen-lockfile` |
| 2026-09-07 | 通过 | `pnpm --filter dsh-tauri-panel-extension build` |
| 2026-09-07 | 通过 | 插件新增文件的 ESLint 检查；随后修复 PR CI 报出的格式问题 |
| 2026-09-07 | 受阻 | 包级 typecheck 仍受 workspace 中 `dsh-tauri` / `dsh-tauri-ui` 类型产物缺失及既有类型问题影响 |

后续每次同步请追加一行验证记录，并保留失败命令的准确错误信息，避免重复排查。
