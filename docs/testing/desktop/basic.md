# 桌面端基础用例（basic）

> 层级：桌面端 E2E（真实 Tauri 窗口）
> 方案：[../e2e/spec.md](../e2e/spec.md)（WebdriverIO 驱动真实 WebView）
> 流程：[../progressive.md](../progressive.md)（一次一批，审核后放行）
> 运行形态：**debug 构建**（端口 `3081`、数据目录 `~/.dsh.dev`）

---

## 0. 前置条件

| 项 | 要求 |
| --- | --- |
| 前端产物 | `dist/`（`pnpm build`；tauri 从 `../dist` 嵌入前端，缺失则 cargo 构建失败） |
| 应用二进制 | `src-tauri/target/debug/deepseek-harness-desktop.exe`（`cargo build --manifest-path src-tauri/Cargo.toml`） |
| 端口 | `3081` 未被监听（debug 默认端口）；**dev 实例在跑时必须先停** |
| 残留进程 | 无同名应用进程、无 `.dsh.dev/.harness.pid` 指向的存活 harness |
| 网络 | 首个用例不依赖网络；harness 首次装配需要网络（见下方「已知慢点」） |
| 平台 | Windows 为主；标题与可见性断言在 macOS 上同为原生标题栏语义 |

**不满足前置时用例直接失败，不自动杀进程、不自动清数据**——测试不得干扰正在 dev 的实例。

### 已知慢点

应用挂载后会调用 `store.harness.startup()` 自动拉起 harness。若 `~/.dsh.dev` 下三件套（runtime / dsh / pnpm）已就绪则秒级；否则会触发下载装配（分钟级且依赖网络）。因此：

- 用例只断言**窗口层**事实，不等待 harness 进入 Running；
- 超时按「窗口出现」设定，不把装配耗时算进断言预算。

---

## 1. 用例

### [P1] 验证应用启动后主窗口存在且标题正确

[层级] 桌面端 E2E（真实 Tauri 窗口）
[自动化] 是（`test/e2e/specs/desktop/basic.e2e.ts`）
[前置条件] D0 基础设施就绪；二进制存在；`3081` 空闲；无残留应用进程
[测试步骤] 1. 启动应用并建立 WebDriver 会话。2. 读取当前会话可见的窗口集合。3. 读取窗口标题与可见性。
[预期结果] 1. 会话建立成功，未超时。2. 窗口集合恰好包含主窗口（label `main`），数量为 1。3. 标题为 `Deepseek Harness Desktop`；窗口可见（Windows 上几何恢复完成后才 `show`，可见即代表启动流程已越过建窗阶段）。

### [P2] 验证应用启动后壳层根节点已渲染

[层级] 桌面端 E2E（真实 Tauri 窗口）
[自动化] 是（同文件，D2 批次）
[前置条件] 同 P1
[测试步骤] 1. 等待 `#root` 下出现元素。2. 检查页面是否有未捕获错误。
[预期结果] 1. `#root` 下至少一个子节点（React 已挂载）。2. 无未捕获的页面错误。

---

## 2. 本批（D0）需要改动的文件

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| `src-tauri/Cargo.toml` | 加 `tauri-plugin-wdio-webdriver = "1"` | 应用内嵌 WebDriver server（`embedded` provider 的前提）；crate 要求 tauri ≥ 2.10，本仓 2.11.5 满足 |
| `src-tauri/src/desktop/builder.rs` | `builder()` 链上 `.plugin(tauri_plugin_wdio_webdriver::init())` | 仅在 `TAURI_WEBDRIVER_PORT` 存在时监听 |
| `test/e2e/support/wdio-probe.mjs` | 新增临时探针 | 起应用 → 轮询 `/status` → 建会话读窗口 → 收尾杀进程；验证后删除 |

**本批刻意不做**：不装 npm 依赖、不建 `desktop` project、不写正式用例。先把「内嵌 WebDriver 能否被纯 HTTP 驱动」这个最大不确定性验掉，避免带着错误假设做 D1 接线。

**代价**：

- `pnpm build`（产出 `dist/`，tauri 要嵌入前端）+ `cargo build`（`src-tauri/target` 当前为空，**冷编译分钟级、数 GB 磁盘**）。
- **需要先停掉正在跑的 dev 实例**：debug 构建固定用 `3081`，探针检测到占用会直接失败（不自动杀进程）。验证完可随时重启 dev。

---

## 3. 运行命令

```powershell
# 前置 1：前端产物（tauri 从 ../dist 嵌入前端）
pnpm build

# 前置 2：debug 二进制
cargo build --manifest-path src-tauri/Cargo.toml

# 前置 3：确认 3081 空闲（停掉 dev 实例）

# 验证 D0：探针自身会拉起/结束应用
node test/e2e/support/wdio-probe.mjs
```

**通过判据**：探针打印 `/status -> 200`、`POST /session` 返回 `sessionId`、`windows: {"value":["main"]}`。

**失败排查**：应用日志在 `.temp-wdio-probe-app.log`（仓库根）。

---

## 4. 待定

- 发布构建是否注册 WDIO 插件（官方建议条件编译剥离；当前为普通依赖，但因只在设置 `TAURI_WEBDRIVER_PORT` 时监听，正常发布不开放端口）。
- 后续批次需要的 `data-testid` 在写对应用例时一并补（本批不需要，只断言窗口层事实）。
- D1 的驱动接线方式（`@wdio/tauri-service` 能否在 vitest 内以库 API 使用）待 D0 通过后定。
