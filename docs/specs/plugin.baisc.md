> 该文档已被固定，禁止修改

# 插件基础规范

## 常量归属规范

适用于 `packages/*` 宿主端与客户端两侧（含 `ctx.effect` 标签、样式 ID、槽位名等）。与任何 `.spec.md` 冲突时，**以本规则为准**。

```
├── 仅 1 个文件消费  ──> 定义在消费文件内部（模块级 const，不导出，放置于 import 之后）
├── 同侧多文件消费  ──> 登记至同侧常量模块
│                        ├── Host 侧: src/host/config/constants.ts
│                        └── Client 侧: src/client/constants/index.ts
├── 跨侧 (Host/Client) ──> 统一收录至共享模块: src/shared/constants.ts
└── 0 个文件消费    ──> 直接删除常量（若文件被清空，同步删文件及悬空 import）
```

> **例外说明**：路由 `path` 不放入常量模块，一律在 `server/index.ts` 的 `app.get/post/put/patch/delete` 注册中直接书写完整字面量。所有常量命名须保证全仓语义唯一。

## 退级策略

需求超出 dsh 原生能力时，按**四级阶梯**降级。客户端统一通过 `defineAdapter(ctx)` 探测（如 `adapter.has('workspaces.create')`），**禁止猜版本或硬编码槽名**。

1. **官方公开 API**
  * 宿主：`tools` / `on` / `systemPrompt` / `effect` / `sessions` / ...
  * 客户端：`slots` / `sessions` / `workspaces`
  * 严格按数据源 `.d.ts` 校验，绝不臆断。
2. **桌面壳补丁**
  * 启动前对核心目录执行幂等补丁（`src-tauri/src/service/patch/*.rs`）。
  * 纯函数 + 锚点校验，失败仅告警，仅补充窄面能力（如 `SlotOutlet`）。
3. **DOM 补丁**
  * UI 改写须经 `controller.observe()` / `listen()` 托管生命周期。
  * 仅用稳定 `aria-label` / `role` / 前缀 class，禁用动态 CSS 哈希。
4. **功能禁用**
  * 均不满足时禁用并日志告警，严禁静默半工作。
