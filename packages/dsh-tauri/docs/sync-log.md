# 上游同步日志

记录 `dsh-tauri` 与内核 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)（`source/deepseek-harness`）的宿主契约对照进度。

按 `docs/specs/upstram.sync.md` §1.2，内核属「必须兼容的运行时依赖」，本日志只登记**载体契约**（`dshDesktop` 标记、index 注入行、鉴权闸门、`__DSH_BOOT__`），不参与择优移植。

## 当前状态

- 已采纳基线：`dsh-v0.2.1-alpha.1`（`5badb15009a`）
- 上一声明/依赖基线：`dsh-v0.2.0-rc.2`（`639ed015397`）；原实际 gitlink 为 `aa8262e`，本轮纠正。
- 当前依赖：DSH `0.2.1-alpha.1` 与配套 Cordis `4.0.5-alpha.1`，Group / Include / Loader peers 显式一致。
- 本轮逐包契约、七类接缝、验证范围与回滚依据：[兼容核对](./compatibility-0.2.1-alpha.1.md)。
- 默认推荐与回退仍为 rc.2：`dsh-0.2.0-rc.2-36556493178`；兼容目标产物已核实为 `dsh-0.2.1-alpha.1-37117505103`，供显式选择。

## 0.2.0-rc.1 → 0.2.0-rc.2 历史记录

- 已采纳基线：`dsh-v0.2.0-rc.2`（`639ed015397`）
- 上一基线：`dsh-v0.2.0-rc.1`（`4878cdabd87`）
- 本地路径：`source/deepseek-harness`（git submodule，HEAD 与基线一致）
- 同步范围：187 commits（140 非 merge），1022 文件（+33253 / −6141）
- 登记 `pnpm-workspace.yaml` `catalogs.dsh` 全部钉 `0.2.0-rc.2`

## 已核对的载体契约（逐字节未变）

- 鉴权闸门：`packages/client/connection/src/{rpc,rpc-host,browser-auth}.ts`、`packages/host/frontend-static/src/index.ts`、`packages/host/open-in-app/src/index.ts` 与 0.2.0-rc.1 逐字节相同 → `src/host/service/gate.ts` 覆写的 `requestRejection` / `authorizeIndex` 无需改动。
- index 注入行：`packages/host/webserver/src/{index,injections}.ts` 逐字节相同（上游导出名为 `IndexInjection`，本地自定名 `IndexInjectRow`，`kind: 'global' | 'script'` 语义不变）→ `src/host/types/harness.ts` 契约不变。
- 载体标记：`apps/desktop/src/preload-app.ts` 仍为 `protocolVersion: 1`；`apps/desktop/src/host-protocol.ts` 仍为 `DESKTOP_HOST_PROTOCOL_VERSION = 4`。
- 账号流：`packages/api/account-controller/src/index.ts:119` 的 `watch(signal)` 与 `ui-settings-account` 的 `$stream({ name: 'account' })` 均未变 → `src/client/register/account.ts` 无需改动。
- 启动清单：`__DSH_BOOT__` 线上格式不变，`dsh-tauri-ssh` 的 `BOOT_MARKER` 正则仍可匹配。

上述 10 个契约源文件在 0.2.0-rc.1 → 0.2.0-rc.2 区间内 blob SHA 完全相等（不是「空 diff」，是同一份对象）；变化的只有各包 `package.json` 的 `version` 串。区间内也没有新增 `engines` / peer 要求，没有新增 workspace 包（`git diff --diff-filter=A -- '**/package.json'` 为空）。

## 本次采纳

- **载体契约基线推进**至 `0.2.0-rc.2`：187 commits 全部落在内核侧，宿主契约零改动，本地只跟随版本基线 —— 子模块指针、`pnpm-workspace.yaml` 的 `catalogs.dsh`（25 条）与 `minimumReleaseAgeExclude`、`pnpm-lock.yaml`、12 份 `THIRD_PARTY_NOTICES.md`、3 份 README 徽章、`src/{host,client}/types/harness.ts` 的【基准】注释、`src-tauri/resources/manifest.jsonc` 的 `engines.dsh.recommend`（`minimum` 仍为 `0.1.5-rc.1`；插件矩阵的 `"dsh": "^0.2.0-rc.1"` 无需改，同一 0.2.0 代际已被 `^` 覆盖）。
- **推荐版本与回退 tag 分离**：`RECOMMENDED_DSH_VERSION` 随基线推进到 `0.2.0-rc.2`；回退 tag 命名的是**打包仓库的 release**，在打包仓库尚未产出 rc.2 之前不能杜撰 buildId。打包仓库已于 2026-09-29T11:36:07Z 发布 `Release-0.2.0-rc.2`（tag `dsh-0.2.0-rc.2-36556493178`，四个平台 zip 资产齐备），故本次把 `FALLBACK_DSH_TAG` 一并推进到 `dsh-0.2.0-rc.2-36556493178`。解析不到推荐版本时 `pickReleaseTag` 会带 note 回退到最新稳定 release，安装链路不受影响。两个常量此前同值、掩盖了这一区别，分离后有两处测试需要显式化：`version.test.ts` 的「pin 不可解析」用例改为显式传 `recommended`（不再隐式依赖常量当前值），`bootstrap.test.ts` 的「release 列表获取失败」用例改为断言 `FALLBACK_DSH_TAG`（该路径确实取回退 tag，而不是推荐 tag）。
- **模型选择器搜索姿态移植**（rc.2 release note 的另一条）：上游把搜索做在核心自有的 `ui-model-selection` 上（共享 popup 契约新增 `searchMode: 'fuzzy-label'` 与 `searchLabels`，算法复用既有的 `rankByName`），本地没有该选择器的实现 —— 桌面壳对核心那份只打 `src-tauri/src/service/patch/model_selection.rs` 的失焦补丁 —— 故择优落到本仓自有的候选模型选择器 `packages/dsh-tauri-model/src/client/models/ModelListEditor.tsx`：过滤由 `includes` 换成复用已装 primitives 的 `rankByName`，搜索框支持 ArrowUp / ArrowDown（环绕）、Home / End、Enter 切换当前行、Escape 关闭，当前行高亮并滚入视图。该包的派生源 `packages/client/ui-settings-models/` 在本区间零代码变更（只有 `package.json` 版本串），逐条登记见其 `THIRD_PARTY_NOTICES.md`。

## 本轮归档（不实施）

- **Windows 标题栏 / 全屏 DOM 契约**：0.2.0 起 `ui-layout` / `ui-dockkit` / `ui-sidebar-right` 依赖 `html[data-windows-titlebar][data-fullscreen]` 与 `--dsh-windows-titlebar-height`；官方由 Electron preload 提供（`apps/desktop/src/preload-windows.ts:12-13`、`preload-platform.ts:30-31`）。本地壳不设这些属性，仅在 Windows 全屏时浮动层/遮罩保留顶栏内边距（视觉偏移，不影响功能）。
- **`dshDesktop.deviceInfo` 的设备指纹**：官方 `readDeviceInfo()` 输出 `platform; os; app_arch; cpu; memory_gib`；本地按要求只用 `navigator.userAgent`。
- **新可选包**：`@deepseek-ai/dsh-client-product-analytics`、`@deepseek-ai/dsh-client-ui-settings-session-log`、`@deepseek-ai/dsh-otel` 均为桌面宿主 bundle 的传递依赖，本地工作区无任何 `package.json` 引用；`catalogs.dsh` 因此不加条目（pnpm 的 `yaml-no-unused-catalog-item` 规则会拒绝）。本次区间新接线到上游 bundle 的 `@deepseek-ai/dsh-client-ui-sidebar-files` 同理 —— 包本身不是新增，本地也无引用。
- **Electron 专属适配**：`macos-entitlements.plist`（本地由 `src-tauri/Entitlements.plist` + `Info.plist` 覆盖）、koffi 版本 pin（本地运行时从已装内核动态读取；本次区间上游 `apps/desktop-host/package.json` 才把 `koffi: ^3.1.0` 提为直接依赖，本地仍不 pin）、`scripts/verify-npm-install-layout.ts`、`scripts/install-lefthook.mjs`（本地无 lefthook）、`scripts/smoke-python-runtime.py`（本地无 Python SDK）。
- **上游专属依赖升级**：区间内上游根 `pnpm-workspace.yaml` 把 `@earendil-works/pi-ai` / `pi-telemetry` 0.85.1 → 0.87.1 并同步 `patchedDependencies`（`6ed596f71b chore(deps): upgrade pi-ai to 0.87.1`）。上游根无 `catalog:` 块，与本地 `catalogs.dsh` 无关，不跟随。该升级即 rc.2 release note 的「第三方模型目录与兼容适配」，对本地无待办：没有任何本地包枚举 pi-ai 的 compat 字段（`deferredToolsMode` / `supportsToolReferences` / `supportsMidConvo*` / `sessionAffinityFormat` / `mistral-conversations` 全仓 0 命中），`dsh-tauri-model` 的 `model-compat.ts` 写的仍是 0.87.1 未变的 `thinkingFormat` / `chatTemplateKwargs` / `supportsDeveloperRole`，第三方模型目录取自 LiteLLM 实时索引而非 pi-ai 内置 id。

## 有意保留的差异

- `src/host/service/gate.ts` 覆写两道鉴权闸门以适配本地嵌入式 WebView，上游只定义 `connection` 闸门语义；该差异在本次区间内零冲突。
- 只发布 `{ protocolVersion: 1, deviceInfo }`，不伪造 Electron 的 `updates` / `browser` 产品 API。
