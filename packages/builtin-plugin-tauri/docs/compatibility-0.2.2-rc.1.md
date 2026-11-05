# Harness 0.2.2-rc.1 兼容记录

推荐核心和开发依赖为 `0.2.2-rc.1`，最低支持为 `0.2.1-rc.1`。源码对照固定到 `dsh-v0.2.2-rc.1`（`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`），历史派生来源保留。已核实打包发行 `dsh-0.2.2-rc.1-41838008646`。

## 本轮契约变化

`SessionController.inspect` 被上游删除（`0c23ad233da`，refactor(session-controller): remove unused inspection facade）。定时任务的会话校验与投递去重改走 `ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })`：读取 `header` 与 `events` 前不激活 Agent，观察租约用完即释放。`observeSession` 在最低支持内核 `0.2.1-rc.1` 起就存在，因此不需要双路径。`session/not-found` 与 `SESSION_QUERY_SESSION_NOT_FOUND` 都按「会话不存在」处理。

右键菜单按官方同版实现对齐：`Menu` 新增 `contextual` 模式（光标定位、同组图标列对齐、进出场淡入淡出），`MenuItem` 自带 `icon` 与 `shortcut`（`ShortcutKeys` 键帽）。插件因此删除自写的标签 span，图标与键帽全部交给官方原语；「在资源管理器中打开」按官方文案改为「在文件夹显示」，会话与工作区菜单不再出现「刷新」。

官方插件页在 rc.1 把页头包进 `.pageBody > .pageBar`，并新增 `--plugin-page-top-inset`（28px）与移动端 `--plugin-page-inset: 20px`。嵌入该页的「插件扩展」面板原先依赖「header 是 `[data-plugin-panel]` 直接子元素」的选择器清零顶部内边距，新 DOM 下失效；改为后代选择器并显式清零，移动端 tab 与其它 tab 重新对齐。

## 默认启停

两个已被官方取代的自研适配插件在核心 `0.2.2-rc.1` 起默认停用：定时任务（官方 schedule 已在同版支持新建会话形式）与移动端界面（官方客户端自带移动端适配）。

判定只在宿主做一次：`service::core::retires_bundled_adapters` 比较活动核心版本，达标即在核心进程环境里下发 `DSH_TAURI_OFFICIAL_ADAPTERS=1`；两个插件自带的 bundle patch 都只读这一个开关，版本知识不再散落在各插件的 `!!js` 表达式里。定时任务停用时，官方 `schedule`/`ui-schedule` 两行随之放开。

用户显式写下的 `disabled: false` 补丁层仍然优先；宿主未下发版本或版本无法解析时保持原默认（启用）。

## 验证范围

本地执行：`pnpm typecheck`、`pnpm lint`、`pnpm exec tsc --noEmit`、`vitest --project unit tests/scheduler-bundle.test.ts tests/mobile-ui-bundle.test.ts`（开关命中与未命中两侧）、`packages/builtin-plugin-extension/src/client/styles/plugins.cssr.test.ts`，以及 `cargo test --lib`（`service::workflow::` 129 项、`service::core::source::` 8 项，含停用基线的版本分界）。`cargo check --lib` 通过。

未执行插件 Build；未验证真实模型请求、发布包压缩锚点与完整桌面浏览器交互，不能把源码对照等同于这些运行验证。
