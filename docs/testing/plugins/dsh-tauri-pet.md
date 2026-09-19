# dsh-tauri-pet

> 层级：L2 插件宿主 E2E（真实 `dsh web` 进程；无浏览器）
> 自动化：`packages/dsh-tauri-pet/test/session-stream.e2e.ts`
> 前置：`pnpm build:plugins` 已产出 `packages/dsh-tauri-pet/dist`
> 编排：`test/e2e/support/dsh-host.ts`（scratch `DSH_HOME` + 目录链接挂载 + `dsh web --port 0 --skip-auth`）
> 运行：`pnpm test:e2e:plugin`

## [P1] 验证会话流路由连上后立刻下发就绪帧

[层级] L2（真实 dsh 进程）
[自动化] 是
[前置条件] 插件已构建并挂载进 scratch profile；`dsh web` 已在随机端口就绪
[测试步骤] 1. 对 `GET /api/desktop/dsh-tauri-pet/session/stream` 发起带 `accept: text/event-stream` 的请求。2. 读响应体首段字节。
[预期结果] 1. 状态码 200，`content-type` 含 `text/event-stream`。2. 首段以 `: keepalive` 注释帧开头（`get.ts` 接入即 pushComment，证明路由已注册且 handler 跑起来）。

## [P2] 验证会话流路由拒绝未声明的方法

[层级] L2（真实 dsh 进程）
[自动化] 是
[前置条件] 同上
[测试步骤] 1. 对同一路径发起 `POST`。2. 读状态码与 `allow` 响应头。
[预期结果] 1. 状态码 405（该路径只声明了 GET）。2. `allow` 响应头含 `GET`。

---

## 待补用例（下一批）

| 用例 | 层 | 说明 |
| --- | --- | --- |
| 客户端在真实 dsh 页面里注册桌宠设置分区与侧栏入口，且无崩溃标记 | L2（浏览器） | 用 Playwright 库 API（`chromium.launch()`）在 vitest 用例内驱动真实页面；插件只注册槽位、不自建根节点，断言宿主槽位产物 |
| 桌宠窗口在桌面端壳层里被创建 | L3（桌面端宿主） | 复用 `test/e2e` 的 WebdriverIO 通道；见 [../e2e/spec.md](../e2e/spec.md) |
