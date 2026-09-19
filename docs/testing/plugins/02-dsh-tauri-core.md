# dsh-tauri 核心桥：宿主路由的共享契约

> 层级：L2 插件宿主 E2E（真实 `dsh web` 进程；无浏览器、无 Tauri）
> 自动化：`test/e2e/plugins/routes-contract.e2e.ts`（待建立）
> 前置：`pnpm build:plugins` 已产出 `packages/dsh-tauri/dist` 与至少一个带路由的插件产物
> 编排：`test/e2e/support/dsh-host.ts`（`DSH_E2E_PLUGIN=dsh-tauri`，需要代表路由时用 `DSH_E2E_ALSO` 另挂一个插件）
> 运行：`pnpm test:e2e:plugin`

`dsh-tauri` 是所有插件路由的**唯一收敛点**：插件只声明 `(kind, path, handler)`，方法限制、预检、来源校验与请求体上限全部由它统一承担。这一层的语义一旦跑偏，所有插件的负向断言都会失真，因此先于任何插件单独覆盖。

本批内复杂度梯度：**OPTIONS 预检** → **HEAD 隐含** → **405 + allow** → **跨源 403** → **请求体 413** → **未挂载 404**。

> 分工：本文件只断言**共享契约**。插件的业务语义（入参校验、领域错误码）一律落在对应插件文件，不在此重复。

---

## 1. 被测契约（事实来源）

| 行为 | 代码位置 |
| --- | --- |
| 连接门拒绝：401 `unauthorized` / 403 `forbidden` | `packages/dsh-tauri/src/host/routes/index.ts:263` |
| `OPTIONS` 未声明时返回 204 且带 `allow` | `packages/dsh-tauri/src/host/routes/index.ts:270` |
| 方法不在允许集 → 405，body `{ error: '仅支持 <allow> 请求' }` + `allow` 头 | `packages/dsh-tauri/src/host/routes/index.ts:275` |
| 声明 `GET` 即隐含允许 `HEAD` | `packages/dsh-tauri/src/host/routes/index.ts:255` |
| 变更方法必须来自回环地址，否则 403 | `packages/dsh-tauri/src/host/routes/index.ts:279` |
| 变更方法带异源 `Origin` → 403 `cross-origin-request` | `packages/dsh-tauri/src/host/routes/index.ts:286` |
| 请求体上限 1 MiB → 413 | `packages/dsh-tauri/src/host/routes/index.ts:128`、`packages/dsh-tauri/src/host/config/constants.ts:13` |
| 每个 `(kind, path)` 只注册一次，支持 GET 即允许 HEAD | `packages/dsh-tauri/src/host/routes/index.ts:248`、`packages/dsh-tauri/src/host/routes/index.ts:254` |

**代表路由**（用例中固定使用，避免依赖具体插件文件）：

- 只声明 GET 的路径：`/api/desktop/dsh-tauri-pet/session/stream`（`packages/dsh-tauri-pet/src/host/routes/index.ts:6`）
- 只声明 POST 的路径：`/api/desktop/dsh-tauri-rightclick/open/url`（`packages/dsh-tauri-rightclick/src/host/routes/index.ts:6`）

---

## 2. 用例

### [P1] 验证 OPTIONS 预检在只声明 GET 的路径上返回 204 并公布 allow

[Case ID] TC-CORE-L2-001
[层级] L2（真实 dsh 进程）
[类型] 正向
[追踪] `packages/dsh-tauri/src/host/routes/index.ts:270`
[自动化] 是（`test/e2e/plugins/routes-contract.e2e.ts`）
[前置条件] 宿主已挂载 `dsh-tauri-pet`（提供代表路由）；`DSH_E2E_MOUNT=link`
[测试数据] `DSH_E2E_PLUGIN=dsh-tauri`；`DSH_E2E_ALSO=dsh-tauri-pet`
[测试步骤] 1. 对代表路由发起 `OPTIONS`（不带 body）。2. 读状态码与 `allow` 头。
[预期结果] 1. 状态码 204，响应体长度为 0。2. `allow` 头存在，且同时包含 `GET` 与 `OPTIONS`；因为 GET 隐含允许 HEAD，`allow` 中还应包含 `HEAD`。
[清理] 无

### [P2] 验证只声明 GET 的路径接受 HEAD 而不被判 405

[Case ID] TC-CORE-L2-002
[层级] L2（真实 dsh 进程）
[类型] 正向
[追踪] `packages/dsh-tauri/src/host/routes/index.ts:255`
[自动化] 是（同上文件）
[前置条件] 同 TC-CORE-L2-001
[测试数据] 同一代表路由
[测试步骤] 1. 对代表路由发起 `HEAD`。2. 读状态码。
[预期结果] 1. 状态码**不是** 405（GET 隐含 HEAD 的规则生效）。2. 若因 SSE 长连接导致 200 后挂起，用例在读取响应头后立即中止连接，不等待 body。
[清理] 中止连接

### [P3] [反向] 验证未声明的方法返回 405 且给出可用的 allow

[Case ID] TC-CORE-L2-003
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri/src/host/routes/index.ts:275`
[自动化] 是（同上文件）
[前置条件] 同 TC-CORE-L2-001
[测试数据] 对只声明 GET 的代表路由发 `POST`（body `{}`，`content-type: application/json`）
[测试步骤] 1. 发起请求。2. 读状态码、`allow` 头、响应体 JSON。
[预期结果] 1. 状态码 405。2. `allow` 头包含 `GET`。3. 响应体 `error` 字段以 `仅支持 ` 开头且包含 `GET`。
[清理] 无

### [P3] [反向] 验证异源 Origin 的变更请求被 403 拒绝

[Case ID] TC-CORE-L2-004
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `packages/dsh-tauri/src/host/routes/index.ts:286`
[自动化] 是（同上文件）
[前置条件] 同 TC-CORE-L2-001；代表路由改为只声明 POST 的 `/api/desktop/dsh-tauri-rightclick/open/url`
[测试数据] 请求头 `Origin: http://evil.example`；`content-type: application/json`；body `{}`
[测试步骤] 1. 发起请求。2. 读状态码与响应体。
[预期结果] 1. 状态码 403。2. 响应体 `error` 恰为 `cross-origin-request`。3. 宿主日志中不出现该插件 handler 的执行痕迹（拒绝发生在路由层）。
[清理] 无

### [P4] [反向] 验证超过 1 MiB 的请求体被 413 终止

[Case ID] TC-CORE-L2-005
[层级] L2（真实 dsh 进程）
[类型] 边界
[追踪] `packages/dsh-tauri/src/host/routes/index.ts:128`、`packages/dsh-tauri/src/host/config/constants.ts:13`
[自动化] 是（同上文件）
[前置条件] 同 TC-CORE-L2-001；使用只声明 POST 的代表路由
[测试数据] body 为 `1 MiB + 1 字节` 的 JSON（`{"pad":"<填充>"}`）
[测试步骤] 1. 发起 `POST`，`content-type: application/json`。2. 读状态码。
[预期结果] 1. 状态码 413。2. 用例不因连接被中断而抛未处理异常（读取响应前先容错）。
[清理] 无

### [P2] [反向] 验证未挂载插件的路径返回 404，用于区分「没挂载」与「没鉴权」

[Case ID] TC-CORE-L2-006
[层级] L2（真实 dsh 进程）
[类型] 异常
[追踪] `docs/specs/plugin.test.md` §5 参数说明（`--skip-auth` 的用意）
[自动化] 是（同上文件）
[前置条件] 宿主**未**挂载 `dsh-tauri-turnrewind`
[测试数据] `GET /api/desktop/dsh-tauri-turnrewind/summary?sessionId=x`
[测试步骤] 1. 发起请求。2. 读状态码。
[预期结果] 1. 状态码 404（既不是 401 也不是 200）。2. 该结果与「挂载后同路径返回 200/4xx 业务码」形成对照，证明失败来自路由缺失而非鉴权围栏。
[清理] 无

---

## 3. 本批追踪矩阵

| 来源 | 覆盖 Case ID | 覆盖类型 | 缺口备注 |
| --- | --- | --- | --- |
| `dsh-tauri` 路由契约：OPTIONS 204 | TC-CORE-L2-001 | 正向 | — |
| 路由契约：GET 隐含 HEAD | TC-CORE-L2-002 | 正向 | SSE 路由会挂起连接，需在读完头后中止 |
| 路由契约：405 + allow | TC-CORE-L2-003 | 异常 | 与各插件文件中的 405 断言**不重复**：此处只验共享层 |
| 路由契约：跨源 403 | TC-CORE-L2-004 | 异常 | — |
| 路由契约：413 bodyLimit | TC-CORE-L2-005 | 边界 | — |
| `plugin.test.md` §5 `--skip-auth` 的判定语义 | TC-CORE-L2-006 | 异常 | — |

---

## 4. 缺口与假设

- **不可覆盖**：非回环地址发起的变更请求 403（`routes/index.ts:279`）需要非本机来源，本套用例不做，仅登记为已知未覆盖分支。
- **假设**：`--skip-auth` 下连接门不再拦截本机无 Origin 请求；若实际仍返回 401，TC-CORE-L2-001 需改为显式携带会话 Cookie。
- **假设**：`allow` 头的成员顺序稳定（`SUPPORTED_METHODS` 过滤后 join，见 `routes/index.ts:255`）。若顺序不稳定，断言改为集合包含而非字符串相等。
