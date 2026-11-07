# Harness 0.2.2-rc.1 兼容记录

推荐核心和开发依赖为 `0.2.2-rc.1`，最低支持为 `0.2.1-rc.1`。源码对照固定到 `dsh-v0.2.2-rc.1`（`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`），历史派生来源保留。已核实打包发行 `dsh-0.2.2-rc.1-41838008646`。

## 本轮契约变化

右键菜单按官方同版实现对齐：`Menu` 新增 `contextual` 模式（光标定位、同组图标列对齐、进出场淡入淡出），`MenuItem` 自带 `icon` 与 `shortcut`（`ShortcutKeys` 键帽）。插件因此删除自写的标签 span，图标与键帽全部交给官方原语；「在资源管理器中打开」按官方文案改为「在文件夹显示」，会话与工作区菜单不再出现「刷新」。

官方插件页在 rc.1 把页头包进 `.pageBody > .pageBar`，并新增 `--plugin-page-top-inset`（28px）与移动端 `--plugin-page-inset: 20px`。嵌入该页的「插件扩展」面板原先依赖「header 是 `[data-plugin-panel]` 直接子元素」的选择器清零顶部内边距，新 DOM 下失效；改为后代选择器并显式清零，移动端 tab 与其它 tab 重新对齐。

## 验证范围

本地执行：`pnpm typecheck`、`pnpm lint`、`pnpm exec tsc --noEmit`、`vitest --project unit packages/builtin-plugin-extension/src/client/styles/plugins.cssr.test.ts`，以及 `cargo test --lib`（`service::workflow::` 129 项）。`cargo check --lib` 通过。

未执行插件 Build；未验证真实模型请求、发布包压缩锚点与完整桌面浏览器交互，不能把源码对照等同于这些运行验证。
