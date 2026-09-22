# dsh-tauri-model-config

本仓库维护的内置扩展，并非 DeepSeek 官方插件：接管 DSH 的「模型」设置页，在官方页面的基础上补齐官方不支持的配置项（上下文、图片输入、思考模式、自定义请求头），并让模型上限可以从提供方端点直接读取。

## 为什么是 fork

官方没有为模型配置页提供任何插槽，页内也没有可扩展点；在复杂表单上打 DOM 补丁会随官方改版直接失效。
因此本插件**完整 fork 官方模型配置页**，注册同一个 `settings.section/models` 声明，并在
`cordis.patch.yml` 里关掉官方入口 `ui-settings-models`——两者声明的槽位互斥，不能同时开启。

- 上游：`@deepseek-ai/dsh-client-ui-settings-models`（`deepseek-ai/deepseek-harness`，`packages/client/ui-settings-models`，tag `dsh-v0.1.5-rc.1`）
- 落点：`src/client/models/`（逐文件对应上游 `src/client/`，行为保持一致）
- 本地改动：`ModelListEditor` / `DeepSeekModelsEditor`（新增能力）、`ProviderEditor`（提供方高级设置入口）、`ModelsSection`（打开配置文件）、`styles.ts`（样式覆盖）、`locales.ts`（新增文案键）
- 新增文件：`RequestHeadersDialog.tsx`（请求头编辑弹窗）、`requestHeaders.ts`（请求头归一化与校验，含单测）——上游没有对应文件，同步时不受覆盖影响
- 上游注释已按仓库规范精简；`styles.ts` 是 `ModelsSection.module.css` 等的哈希化产物，类名前缀与官方一致（`zGbnIq_*` 等）

同步上游时的步骤：以同一 tag 重新取源 → 覆盖 `src/client/models/` 中未被本地改动的文件 → 重放上述改动。

编辑器选择位于独立的 `src/client/components/config-editor.tsx`，模型页面只负责挂载入口；偏好存储和跨平台启动逻辑在本插件宿主端。当前仅服务模型配置文件，无需拆成独立插件或桌面全局能力。若上游提供统一编辑器接口或出现跨插件复用需求，再评估迁移；插件内隔离仍需配合模型页面 fork 的上游同步维护。

## 新增能力

| 位置 | 能力 |
| --- | --- |
| 面板标题右侧（`.zGbnIq_title`） | **文本编辑器**：下拉菜单默认跟随系统，可选择 VS Code、Cursor 或自定义编辑器；预设点选即保存，自定义路径确认后保存。**打开配置文件**：使用所选编辑器打开 `$DSH_HOME/settings.yaml`（`DSH_HOME` 未设置或为空白时为 `~/.dsh/settings.yaml`）；文件尚未创建时改为打开它所在目录 |
| 单个模型行（`.zGbnIq_modelRow`） | **获取配置**：仅在该条目只有 `id`/`name`/`description` 时出现，按 `id` 从提供方端点读取该模型的上下文与输出上限 |
| 模型目录标题（`.zGbnIq_modelCatalogHeading`） | 追加 `flex: 1`（按钮集中到右侧），并在右侧加入 **自动配置所有模型**；pi-ai 提供方与官方 DeepSeek 模型目录都有这个入口 |
| 单个模型高级区（`.zGbnIq_modelAdvanced`） | **图片输入** 开关 → `input` 声明；**思考模式** 开关 → `reasoningEfforts` 声明，打开后可按档位勾选；**关闭 Developer 角色** 开关 → `compat` 声明（仅路由显式声明 `openai-completions` 时出现） |
| 单个提供方卡片标题右侧（`.zGbnIq_editorHeader`） | **高级设置**：打开请求头编辑弹窗，按行增删自定义 Header，写进该提供方 profile 的 `headers`。新建自定义提供方的标题右侧也有这个入口，创建时一并写入。按钮在已有条目时显示条数；只对 pi-ai 路由出现（官方 DeepSeek 的适配器不读 `headers`）。对话请求由 pi-ai 的 `requestHeaders()` 合并这些头并覆盖默认头；模型清单的宿主直连同样带上表单里的头 |

高级区里的开关统一由 `.zGbnIq_modelSwitchRow` 包裹（`display: flex` + `height: 32px` + 垂直居中），与相邻的 32px 文本输入框对齐。

高级区首行横跨整个栅格：左半边是两个容量输入（彼此等宽，整组按内容宽度），右半边是三个开关（开关组吃掉剩余宽度）——开关按内容宽度排布、不做拉伸，容器带 4px 左外边距，行内与开关组内的间距都是 6px；档位勾选仍独占下一行。高级区自身去掉上游那 4px 左右内边距，首行因此与上面的模型行同宽、同起止。

VS Code 和 Cursor 菜单图标随插件内嵌，以 CSS background / mask 显示，无运行时外部请求。图形分别来自 [VS Code 官方品牌资源](https://code.visualstudio.com/brand) 和 [Cursor 官方品牌资源](https://cursor.com/brand)。

## 配置从哪里来

三条通道，先直连再回退（前两条与参考实现 `dsh-llm-capabilities` 的顺序一致）：

1. **宿主直连** `GET /endpoint/models`：宿主按 `settings` 服务里的 profile 解析端点与凭据，请求
   `{baseURL}/models` 并归一化容量。请求先带上表单当前的自定义头（查询参数 `headers`，缺省时用 profile
   里已保存的 `headers`），再强制 `accept: application/json`，有密钥时再强制 `authorization`。
   官方发现通道会把清单收窄，容量字段只有端点原始清单里才有。
2. **官方发现通道** `remote.llm.discoverModels(settingsNs, probe)`：覆盖端点地址不在用户设置里的提供方
   （例如内置 DeepSeek 官方路由，它的地址只有适配器自己知道）。
3. **模型能力表** `GET /presets`：端点清单只说容量，不说模态与档位，图片与思考能力来自 LiteLLM 的
   模型价目/容量表（`model_prices_and_context_window.json`，MIT，与 <https://models.litellm.ai/> 同源）。
   表**不进仓库**：宿主在第一次需要时下载，压成 `模型 id → [支持图片, 支持思考, 最大输入, 最大输出]`
   后缓存在 `$DSH_HOME/dsh-tauri-model-config/model-presets.json`，一天内直接用缓存；上游不可达时先用
   过期缓存，完全没有缓存时退回家族规则（`claude` / `gemini` / `grok-N` / `-vl` / `-vision` / `-omni` /
   `glm-Nv` / `glm-4.5+` / `seed-1.6+` / `-thinking` / `r1` / `qwq` / `minimax-m1|m2` / `qwen3` / `o1-o9`）。

   为什么不走 LiteLLM 代理的公开接口（`GET /public/litellm_model_cost_map`）：那是 demo 代理，
   固定在自己那份 LiteLLM 版本上（实测 1.82.6），表比主干旧一截（1020 vs 1424 条 chat 模型），
   新模型会缺席；该接口也只提供全量，`/models/{model_id}` 之类还需要密钥、且只回答「这个代理自己
   部署了哪些模型」（公开实例上任何厂商 id 都是 404）。

请求事实全部来自表单当前显示的值（`provider` / `baseURL` / `api`，已输入未保存的 `apiKey`，以及自定义 `headers`），
插件不认识任何具体部署；凭据只在宿主侧解析，响应里从不回显，也不进 URL。

并入草稿时的优先级：

- 容量以端点披露为准；端点什么都没说时用能力表的值，已有值永不被能力表覆盖。
- 图片与思考先看能力表，表没给出「能」的结论时由家族规则按命名补一条（只做加法，不做减法：
  把模型误判成只能读文字会让用户发不出图片，代价比多勾一个开关大）。
- 能力表的 `0` 是「数据集没有给出这项事实」，不是「不支持」：没表态的模态与档位不写进条目，
  该字段保持「继承默认」。因此「自动配置所有模型」不会把部署真实具备、或用户已经声明的思考与
  图片能力改写成显式的 `reasoningEfforts: false` / `input: ['text']`——本地端点上的模型常常比
  数据集新，写死的否定声明会直接关掉它。
- **单行「获取配置」**：只补空缺字段，不覆盖已有值。
- **「自动配置所有模型」**：按按钮语义重新配置，端点披露的容量会覆盖行内旧值；端点没披露的字段保持不动。

两条路径都会给出「已写入 N 个 / M 个未被端点披露」的结果行。

## 宿主路由

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/desktop/dsh-tauri-model-config/endpoint/models` | 读取提供方端点的 `/models` 清单并归一化容量 |
| GET | `/api/desktop/dsh-tauri-model-config/presets` | 取模型能力表（`force=true` 忽略缓存有效期） |
| GET / PUT | `/api/desktop/dsh-tauri-model-config/config/editor` | 读取 / 保存文本编辑器偏好 |
| POST | `/api/desktop/dsh-tauri-model-config/config/open` | 用所选编辑器打开模型配置文件，未设置时跟随系统 |

已接入 `genapi.config.ts`，客户端 `apis/` 为生成产物。

## 思考模式

**思考模式** 开关打开时保留该行已有档位，没有则给默认的 `{ off: null, low: 'low', medium: 'medium', high: 'high' }`
（与官方 pi-ai 目录给自建路由的默认档位、参考实现 `dsh-llm-capabilities` 的 `DEFAULT_REASONING_EFFORTS` 一致）；
打开后出现 `off` 到 `max` 的**档位勾选项**（`off, minimal, low, medium, high, xhigh, max`），
勾上即写入该档位、取消即移除；取消到空表时写 `false`（显式「不支持思考」），因为空表会被 schema 判为非法声明。

键是档位，值是分发给端点时使用的线值（只有 `off` 允许为空）。需要为某个模型改线值时，直接在设置文档里改这一项。

开关只表达两种**显式声明**：`false`（不支持）与档位对象（支持）。`reasoningEfforts` 缺席表示「继承默认」，
此时开关读为关，与图片开关同一口径。

### 关闭 Developer 角色

声明了档位不等于档位能到端点。pi-ai 默认把档位放进顶层的 `reasoning_effort`，并在模型有思考能力时
把系统提示的角色从 `system` 换成 `developer`；而 vLLM 这类 OpenAI 兼容端点从 `chat_template_kwargs`
读思考参数、也不认 `developer`，于是出现「档位选了没反应」与「整轮 400 `Unexpected message role.`」。

**关闭 Developer 角色** 开关把这类端点需要的三项事实一次写进该模型的 `compat`：

```yaml
compat:
  supportsDeveloperRole: false
  thinkingFormat: chat-template
  chatTemplateKwargs:
    reasoning_effort:
      $var: thinking.effort
```

前两项分别解决角色与下发格式，第三项用 pi-ai 的请求态占位符把下拉框选中的档位动态填进参数，
不需要重述端点的 chat template。开关读为开的条件是 `thinkingFormat: chat-template` 与
`supportsDeveloperRole: false` 同时成立，因此只写了一半的手写条目在开关上仍读为关，打开时会补齐。
关闭只摘掉这三项，条目里其它 `compat` 键与 chat template 参数原样保留。

`compat` 在 pi-ai 里是逐协议校验的，`thinkingFormat` 与 `chatTemplateKwargs` 只有
`openai-completions` 收，写到 Responses / Anthropic 路由的模型上会让整段配置解析失败，所以这个开关
只在路由显式声明 `openai-completions` 时出现；目录路由（协议由内置目录决定，插件看不到）不提供。

## 已知约束

- 模型配置文件按 `$DSH_HOME`（非空白）→ `~/.dsh` 解析后取 `settings.yaml`，与官方 `resolveDshHome` 及桌面壳一致；如果 profile 的 `cordis.yml` 为 `settings-file` 配了自定义 `path`，这里无法感知。
- 编辑器设置仅作用于本插件模型页面的“打开配置文件”；偏好保存于 `$DSH_HOME/dsh-tauri-model-config/editor.json`，不修改系统文件关联。自定义编辑器在 macOS 上支持应用名称、`.app` 路径或可执行文件路径；Windows 使用 `.exe` 完整路径；Linux 支持可执行程序名称或路径。无需引号，不支持附加参数。编辑器启动失败会显示错误，不自动切换应用。
- 编辑器偏好文件内容无效时跟随系统默认，读取时保留原文件，可重新选择编辑器并保存；权限或其他读取错误仍会报错。
- 文件不存在时打开的是它所在的目录，而不是替用户创建一个空文档。
- 图片能力既不在官方发现通道的返回里，也没有跨厂商的端点字段：它来自模型能力表，表里没有的靠家族规则。两者都是社区口径的近似值，用户随时可以在高级区改；单行「获取配置」也不会覆盖手写值。
- 能力表需要一次网络请求（约 2.6 MB 的原始数据集，压成 72 KB 落盘，一天内不再请求）。离线且从未下载过时，只剩家族规则能补图片/思考，容量仍由端点清单提供。
- 档位只提供官方词表内的勾选，线值固定等于档位名；端点要求特殊线值时改设置文档即可。
- 「关闭 Developer 角色」写的是一组固定的 `compat`：参数名 `reasoning_effort`、下发格式 `chat-template`。端点要求别的参数名（例如 `enable_thinking`）或别的下发格式时，改设置文档即可；开关只表达它写入的这一组。
- 自定义请求头只对 pi-ai 路由开放：官方 DeepSeek（`llm-deepseek`）的适配器不读 `headers`，写进去不会生效，因此那一类提供方不出现入口。`user-agent` 由 Harness 的强制归因头最后写入，自定义值会被丢弃，弹窗内以提示呈现而不阻止保存。头名与头值在写入前按 HTTP 头语法校验（token 名、单行 Latin-1 值）。大小写不同的同名头视为重复并拒绝保存，不会静默覆盖。非法条目会让整段提供方配置解析失败。
