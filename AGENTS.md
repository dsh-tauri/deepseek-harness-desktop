## Workspace Routing & Context Guidelines

在执行代码分析、优化、重构或单测编写前，必须根据修改对象的**路径、业务域与环境**，主动读取并叠加遵循对应的规范文档：

### 1. 规范矩阵与路由表 (Specification Routing Matrix)

| 修改范围 / 触发条件 | 业务场景 / 对应模块 | 必须参照的规范文档 |
| :--- | :--- | :--- |
| **基础通用** | 所有代码修改 | `docs/specs/devlopment.md` |
| **测试标准** | 通用 Unit Test、E2E 集成测试断言与结构 | `docs/specs/testing.md` |
| **桌面端 - 基础架构** | 桌面端主进程、Shell 基础、GUI 渲染核心 | `docs/specs/desktop.baisc.md` |
| **桌面端 - UI 组件** | 设置面板 / 对话框等前端组件的内部分区、派生数据与提交动作组织 | `docs/specs/desktop.ui.md` |
| **桌面端 - 测试验证** | 桌面端 E2E 测试、UI 单元测试、桌面功能测试 | `docs/specs/desktop.test.md` |
| **插件 - 基础架构** | 插件常量归属、跨侧共享约定与退级策略 | `docs/specs/plugin.baisc.md` |
| **插件 - 客户端核心** | 插件 Client 通信、状态管理与客户端逻辑 | `docs/specs/plugin.client.md` |
| **插件 - 客户端面板** | 插件 Panel 视图组件、交互面板 UI | `docs/specs/plugin.client.panel.md` |
| **插件 - 宿主核心** | 宿主进程管理、插件加载器、沙箱隔离 | `docs/specs/plugin.host.md` |
| **插件 - 宿主服务** | 宿主系统级 Service、底座 API 实现 | `docs/specs/plugin.host.service.md` |
| **插件 - 测试套件** | 插件 Mock 测试、沙箱运行测试、集成测试 | `docs/specs/plugin.test.md` |
| **上游同步/依赖管理** | Upstream 仓库同步、依赖重构、版本兼容 | `docs/specs/upstram.sync.md` |

### 2. 规范叠加与优先级 (Specification Stacking Rules)
- **通用基础**：`docs/specs/devlopment.md` 为全局必须叠加的基础规范。
- **多模块协同**：若同时跨越桌面端与插件（例如：优化插件面板及其与桌面宿主的通信），**必须同时读取并整合**涉及的所有子规范。
- **冲突裁决**：当规则冲突时，优先级为 `专项/业务规范 > 运行环境规范 > devlopment.md`。

---

## 最高优先级 (Strict Guidelines)

1. **隐私与目录隔离**：
   - 严禁查看 `archive/` 目录下的任何内容，除非用户明确提及并给予特殊许可。
2. **极致代码精简与注释策略**：
   - **0 注释原则**：编写/重构代码时必须保持 **0 注释**，仅允许在极难通过代码自解释的**关键节点/复杂算法**添加微量注释。
   - **清理冗余**：优化时若发现代码中存在大面积文档描述、历史残余注释或冗余代码，应主动清理/精简，提升干净度。
3. **临时草稿区**：
   - 若需要临时记录、存放中间分析过程或草稿，可随意在 `.temp` 文件中编写（该文件下拥有绝对自由度）。
4. **插件开发保护**：
   - 在处理或重构插件相关代码时，**切勿执行构建（Build）命令**（用户可能正处于 Dev 开发热重载状态）。

---

## 沟通与评论规范 (Reply & Comment Rules)

回复用户、以及在 issue / PR 下留言时，一律适用：

1. **短。先给结论**：
   - 默认三五句说完。不写小标题、不写表格、不写清单堆砌；只有用户明确要「详细/完整报告」时才展开。
   - 不复述刚跑过的命令、文件清单或工具输出，用户不关心过程。
2. **说人话，不要 AI 腔**：
   - 禁止「综上所述」「值得注意的是」「希望能帮到你」这类套话，禁止 emoji 装饰与 ✅🎉 式排版。
   - 正文用中文；仅代码、命令、标识符与官方术语保留英文，不要中英夹杂堆术语。
3. **不刷屏**：
   - 同一话题只留一条评论/一条回复。写长了或写错了，原地编辑（`gh api --method PATCH`），不要补发第二条。
   - 链接与代码块只留必要的那一两条，堆参考链接视为噪音。
4. **结论要能落地**：
   - 推荐方案必须给一条可直接复制的命令，并诚实标注限制：不支持、已失效、只是缓解，都要写清楚。

---

## Command Performance Constraints (Strictly Enforced)

执行文件查找或代码检索时，必须遵守极速命令约束，避免触发低效遍历：

1. **FORBIDDEN POWERSHELL COMMANDS:**
   - **NEVER** use `Get-ChildItem -Recurse` or `dir -s` to search files/directories.
   - **NEVER** use `Select-String -Path` for recursive text searches.

2. **FAST ALTERNATIVES (MANDATORY):**
   - **Searching text in files:** Use `rg "pattern"` (ripgrep).
   - **Finding files by name/path:** Use `fd <pattern>` or `git ls-files | Select-String "pattern"`.
   - **Listing top-level directory items:** Use simple `Get-ChildItem` (NO `-Recurse`).

3. **GIT PROJECT EXEMPTION:**
   - Always leverage Git index if available: `git ls-files` is exponentially faster than PowerShell directory traversal.