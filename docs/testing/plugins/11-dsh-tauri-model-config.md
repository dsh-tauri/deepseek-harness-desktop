# dsh-tauri-model-config：模型设置页与端点探测

> 层级：L2 插件宿主 E2E → L3 桌面端宿主 E2E
> 自动化：`packages/dsh-tauri-model-config/test/model-config-routes.e2e.ts`（待建立）；客户端与 L3 见各用例标注
> 前置：`pnpm build:plugins`；预设端点需要联网（未联网时按 `stale` 分支断言）
> 运行：L2 `pnpm test:e2e:plugin`；L3 见 `00-overview.md` §5.2

本插件**顶替了官方模型设置页**（通过 cordis patch 关闭 `ui-settings-models`），因此它的失败会直接表现为「用户看不到模型配置」。渐进顺序：**只读预设** → **端点探测失败** → **打开配置文件** → **设置页接管**。

---

## 1. 事实基线

| 事实 | 位置 |
| --- | --- |
| `PLUGIN_ID = 'dsh-tauri-model-config'`；设置文件名 `settings.yaml` | `packages/dsh-tauri-model-config/src/shared/constants.ts:1`、`packages/dsh-tauri-model-config/src/shared/constants.ts:4` |
| 3 条路由：`GET /endpoint/models`、`GET /presets`、`POST /config/open` | `packages/dsh-tauri-model-config/src/host/routes/index.ts:6` |
| 端点/预设失败 → 502 `{ok:false,error}` | `packages/dsh-tauri-model-config/src/host/routes/endpoint/models/get.ts:14`、`packages/dsh-tauri-model-config/src/host/routes/presets/get.ts:9` |
| 打开配置失败 → 500 `{ok:false,path,error}` | `packages/dsh-tauri-model-config/src/host/routes/config/open/post.ts:8` |
| 设置文件不存在时退化为打开目录（`opened:'directory'`） | `packages/dsh-tauri-model-config/src/host/service/config-file.ts:35` |
| 预设磁盘缓存路径与 24h TTL，失败回退过期缓存并标 `stale` | `packages/dsh-tauri-model-config/src/host/utils/paths.ts:30`、`packages/dsh-tauri-model-config/src/shared/model-presets.ts:22`、`packages/dsh-tauri-model-config/src/host/service/model-presets.ts:118` |
| 端点探测超时 15s；预设上游超时 20s | `packages/dsh-tauri-model-config/src/host/service/endpoint-models.ts:28`、`packages/dsh-tauri-model-config/src/host/service/model-presets.ts:18` |
| 客户端槽位：`settings.section`（id `models`，order 10）+ `settings.onboarding` ×2 | `packages/dsh-tauri-model-config/src/client/register/models.ts:64`、`packages/dsh-tauri-model-config/src/client/register/models.ts:75` |
| patch 关闭官方 `ui-settings-models` | `packages/dsh-tauri-model-config/cordis.patch.yml:4` |
| 无 `data-dsh-*` 标记；可用 `aria-label` / `role` / slot id | 全包 `src/client` 检索无命中 |

---

## 2. L2：宿主路由

### [P1] 验证预设端点返回固定结构

[Case ID] TC-MC-L2-001
[层级] L2（真实 dsh 进程）
[类型] 正向
[追踪] `packages/dsh-tauri-model-config/src/host/routes/presets/get.ts:13`
[自动化] 是（`packages/dsh-tauri-model-config/test/model-config-routes.e2e.ts`）
[前置条件] 插件已构建并挂载；网络可用（或磁盘已有缓存）
[测试数据] `GET /api/desktop/dsh-tauri-model-config/presets`
[测试步骤] 1. 发起请求。2. 读状态码与响应体字段。
[预期结果] 1. 状态码 200。2. 响应体含 `ok: true`、`source`、`fetchedAt`、`stale`、`count`、`presets` 六个字段。3. `count` 与 `presets` 长度一致。
[清理] 无

### [P3] [反向] 验证断网且无缓存时预设返回 502

[Case ID] TC-MC-L2-002
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-model-config/src/host/service/model-presets.ts:120`
[自动化] 是（需构造断网或清空缓存）
[前置条件] scratch `DSH_HOME` 下不存在 `dsh-tauri-model-config/model-presets.json`，且外部网络不可达
[测试数据] `GET /presets?force=true`
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 502。2. 响应体 `ok` 为 false 且 `error` 为非空字符串。3. 未写入新的缓存文件。
[清理] 恢复网络

### [P3] [反向] 验证端点探测缺少可用 endpoint 时返回 502

[Case ID] TC-MC-L2-003
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri-model-config/src/host/service/endpoint-models.ts:77`
[自动化] 是
[前置条件] scratch `DSH_HOME/settings.yaml` 中无模型端点配置
[测试数据] `GET /endpoint/models?ns=`
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 502。2. 响应体 `ok` 为 false，`error` 非空。3. 响应体内**不含**任何形如密钥的字段（不回显凭据）。
[清理] 无

### [P2] 验证打开配置文件端点返回路径与打开方式

[Case ID] TC-MC-L2-004
[层级] L2（真实 dsh 进程）
[类型] 正向
[追踪] `packages/dsh-tauri-model-config/src/host/routes/config/open/post.ts:12`
[自动化] 是（会拉起系统文件管理器，仅限受控环境执行）
[前置条件] 同 TC-MC-L2-003
[测试数据] `POST /config/open`（无 body）
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 200。2. 响应体含 `ok: true`、`path`（绝对路径，指向 scratch `DSH_HOME` 下）、`opened` 且取值为 `file` 或 `directory` 之一。
[清理] 关闭被拉起的文件管理器（人工）

### [P4] 验证设置文件缺失时退回打开目录

[Case ID] TC-MC-L2-005
[层级] L2（真实 dsh 进程）
[类型] 边界
[追踪] `packages/dsh-tauri-model-config/src/host/service/config-file.ts:35`
[自动化] 是
[前置条件] scratch `DSH_HOME/settings.yaml` **不存在**
[测试数据] 同 TC-MC-L2-004
[测试步骤] 1. 确认文件不存在。2. 发起请求。3. 读 `opened` 字段。
[预期结果] 1. 状态码 200。2. `opened` 恰为 `directory`。
[清理] 关闭被拉起的文件管理器

---

## 3. L2：客户端（真实浏览器页面，未接线）

### [P1] 验证模型设置分区由本插件接管

[Case ID] TC-MC-C-001
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-model-config/src/client/register/models.ts:64`
[自动化] 未接线（`00-overview.md` G2）
[前置条件] iframe 内 dsh 界面已加载；cordis patch 已应用
[测试数据] 无
[测试步骤] 1. 打开设置。2. 查询 id 为 `models` 的分区。3. 统计「模型」相关分区数量。4. 收集 `pageerror`。
[预期结果] 1. 存在 id `models` 的分区，且 order 为 10（排在设置列表首位）。2. 「模型」分区恰好 1 个（官方 `ui-settings-models` 已被 patch 关闭）。3. `pageerror` 为空。
[清理] 关闭设置

### [P2] 验证引导槽位出现两条 onboarding 行

[Case ID] TC-MC-C-002
[层级] L2（真实浏览器页面，未接线）
[类型] 正向
[追踪] `packages/dsh-tauri-model-config/src/client/register/models.ts:75`
[自动化] 未接线（G2）
[前置条件] `ui-onboarding` 命名空间下 `welcomeNoticeVersion` 未标记为已读
[测试数据] 无
[测试步骤] 1. 打开设置引导区。2. 查询 id `welcome-notice` 与 `deepseek-official` 两行。
[预期结果] 1. 两行均存在。2. `welcome-notice` 排在 `deepseek-official` 之前（order −100 vs 0）。
[清理] 关闭设置

### [P3] [反向] 验证预设获取失败时展示错误且不崩溃

[Case ID] TC-MC-C-003
[层级] L2（真实浏览器页面，未接线）
[类型] 异常
[追踪] `packages/dsh-tauri-model-config/src/client/models/ModelsSection.tsx:302`
[自动化] 未接线（G2）
[前置条件] 令 `/presets` 返回 502（桩或断网）
[测试数据] 无
[测试步骤] 1. 打开模型设置页。2. 查询 `[role="alert"]`。3. 收集 `pageerror`。
[预期结果] 1. 出现 `role="alert"` 错误条，文案非空。2. 页面其余部分仍可交互（提供商卡片仍在）。3. `pageerror` 为空。
[清理] 关闭设置

---

## 4. L3：桌面端宿主（真实 Tauri 窗口）

### [P1] 验证桌面端可打开模型设置页并看到提供商卡片

[Case ID] TC-MC-L3-001
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `packages/dsh-tauri-model-config/src/client/register/models.ts:64`
[自动化] 待接线（`desktop` project 未配置，`00-overview.md` G4）
[前置条件] 应用就绪；`<DSH_E2E_HOME>/home/.dsh.dev/settings.yaml` 存在（或允许首次生成）
[测试数据] 无
[测试步骤] 1. 建 WebDriver 会话并切到 iframe。2. 打开设置并进入模型分区。3. 查询模型卡片与页脚区域。
[预期结果] 1. 模型分区可见。2. `settings.models.provider-card` 槽位至少渲染 1 张卡片（或明确的空态）。3. `settings.models.footer` 槽位渲染页脚操作区。4. 应用日志无 `dsh://plugin-error`。
[清理] `DELETE /session/<id>`

---

## 5. 追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `/presets` 成功结构 | TC-MC-L2-001 | 正向 | 联网依赖需在用例中标注 |
| 无缓存 + 断网 → 502 | TC-MC-L2-002 | 异常 | 断网构造方式待定 |
| `/endpoint/models` 无 endpoint → 502 | TC-MC-L2-003 | 异常 | — |
| `/config/open` 成功 | TC-MC-L2-004 | 正向 | 有真实系统副作用 |
| 文件缺失 → directory | TC-MC-L2-005 | 边界 | — |
| 分区接管 | TC-MC-C-001、TC-MC-L3-001 | 正向 | 依赖浏览器驱动 / `desktop` project |
| 引导槽位 | TC-MC-C-002 | 正向 | 依赖 onboarding 状态 |
| 失败可见性 | TC-MC-C-003 | 异常 | 需要桩化 `/presets` |
| 端点探测成功（真实 provider） | — | — | **未覆盖**：需要真实 API Key 与外部服务 |
| `stale: true` 回退 | — | — | **未覆盖**：需要「先有缓存、后断网」的两段式构造 |

---

## 6. 缺口与假设

- **G-MC-1**：服务端**从不回显密钥**（`packages/dsh-tauri-model-config/src/host/service/endpoint-models.ts:38`）。TC-MC-L2-003 因此显式断言响应体不含密钥字段——这是一条安全回归断言，不是业务断言。
- **G-MC-2**：客户端无可用的 `data-*` 标记（全包无命中），L3 断言只能依赖 slot id、`aria-label` 与 `role`。若后续按 `desktop.test.md` §5 补 `data-testid`，本文件选择器同步更新。
- **G-MC-3**：slot 互斥依赖 patch 生效（`packages/dsh-tauri-model-config/cordis.patch.yml:4`）。若 E2E 环境未应用 patch，会出现同 id 分区重复——TC-MC-C-001 的「恰好 1 个」断言即为该风险的守卫。
- **G-MC-4**：TC-MC-L2-002 需要「无缓存 + 外部网络不可达」的环境，构造方式必须在用例的 `[前置条件]` 中显式声明（`desktop.test.md` §6 要求断网用例单独标注）。
- **假设**：`$DSH_HOME` 在 scratch 宿主内指向临时目录（`packages/dsh-tauri/src/host/config/constants.ts:5`），因此配置文件断言天然隔离。
