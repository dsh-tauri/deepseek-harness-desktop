# dsh-remote 插件安装补丁（cordis.patch.yml 示例）

> 本文档自 dsh-tauri-plugins 仓库随插件源码迁入，描述把 `dsh-tauri-ssh`(+`-ui`)
> 手工装进**独立 DSH 检出 / 运行中的 DSH 实例**的补丁写法。在桌面仓库内这两包
> 已是内置插件（`packages/dsh-tauri-ssh`、`packages/dsh-tauri-ssh-ui`），随
> `build:plugins` 打包、由 internal 机制自动装载，无需按下文手工接线；下文仅
> 在脱离桌面仓库单独分发插件时需要。

把下面的 `- insert:` 块追加到 DSH 检出的
`packages/bundle/web-app/cordis.patch.yml`（文件末尾即可，追加多个
`- insert:` 块是合法的）。`ssh-remote` 是宿主内核（设置命名空间 +
同源 `/api-ssh` 连接面，连接与机器发现都读本机 `~/.ssh`），`ui-ssh` 是
设置页（`dsh.client` 行，浏览器半边由 `client-modules` 节点半边扫描进
`window.__DSH_BOOT__` 并按 `/plugins/ui-ssh/client.js` 提供）。

```yaml
# ── dsh-remote：SSH 远程机器 ──────────────────────────────────────────────

- insert:
    # 连接内核：settings 命名空间 + 同源 /api-ssh 路由（依赖 base 层的
    # settings 与 webServer 服务）。config 全部可省略，省略时使用 schema 默认值。
    - id: ssh-remote
      name: dsh-tauri-ssh
      config:
        connectTimeoutMs: 15000
        healthCheckTimeoutMs: 3000
        healthPollIntervalMs: 1000
        healthPollAttempts: 30
        # sshDir: '~/.ssh'  # 可选：凭据目录覆盖（config 与身份文件所在）
        # remotePort: 3080  # 可选：未覆盖机器的默认远端 dsh web 端口
        # startCommand: '$HOME/.local/bin/dsh web --host 127.0.0.1 --port {port}'
        #   # 可选：默认启动命令模板（{port} 替换）；远端 PATH 无 dsh 时填绝对路径
        # installRepo: 'dsh-tauri-desk/deepseek-harness-pkg'
        #   # 可选：一键安装的发行仓（owner/name 或 GitHub URL）：远端安装走
        #   # 二进制分发——从该仓 releases 下载打包运行时（Node + DSH，
        #   # SHA-256 校验）；默认即官方发行仓，自有镜像/镜像仓填这里
        # installRef: '0.1.5-rc.2'
        #   # 可选：版本钉（semver 或完整 release tag，如
        #   # 'dsh-0.1.5-rc.2-34495473237'；默认取推荐版本，解析失败回退
        #   # 最新稳定 release）
        # installTimeoutMs: 1800000  # 可选：一次远端安装的截止时间（毫秒）

    # 设置页：浏览器插件注册表行（dsh.client 声明在包内 package.json）。
    - id: ui-ssh
      name: dsh-tauri-ssh-ui
```

注意：`ssh-remote` 行依赖 `settings`/`webServer`，它们由 base 补丁的行提供；
`ui-ssh` 行依赖 `slots`/`locale`，由 web-app 补丁的行提供 ——
两个插件都放在 web-app 补丁里即可（web-app 覆盖 base）。

> **关键**：新插件的行**必须**写在 `- insert:` 块里。只写 `- id: x` 的裸行
> 只对**已存在**的 id 生效（覆盖配置）；id 不存在时 loader 会静默丢弃该行
> （实测确认）。

### 方式 B：运行中的 DSH 安装（零源码改动，推荐个人环境）

不需要动 DSH 检出 —— 和已有的 `dsh-better-sidebar` 一样，通过 profile 安装：

1. 把两个包放到任意目录（例如本仓库 `packages/` 下）；
2. `~/.dsh/profiles/web/package.json` 的 `dependencies` 增加两条 `link:` 依赖：
```json
{
  "dsh-tauri-ssh": "link:<desktop-repo>/packages/dsh-tauri-ssh",
  "dsh-tauri-ssh-ui": "link:<desktop-repo>/packages/dsh-tauri-ssh-ui"
}
```
3. `~/.dsh/profiles/web/cordis.patch.yml` 追加：
```yaml
- insert:
    - id: ssh-remote
      name: dsh-tauri-ssh
    - id: ui-ssh
      name: dsh-tauri-ssh-ui
```
4. `cd ~/.dsh/profiles/web && pnpm install`；
5. 构建插件产物（`dist/`）：在本仓库运行
   `pnpm --filter dsh-tauri-ssh --filter dsh-tauri-ssh-ui run build`；
6. `dsh web` → 设置 → SSH 机器。

> 版本要求：`dsh-tauri-ssh-ui` 的 `dsh.client.inject` 面向
> **dsh ≥ 0.1.2-alpha.1**（`slots` 服务由 `dsh-client-ui-renderer` 提供），
> 本仓库当前对齐 **0.1.5-rc.2**（远端 bootstrap 的
> `RECOMMENDED_DSH_VERSION` 与桌面 `version-recommend.json` 同步钉定）。
> 更早版本（≤ 0.1.1-rc.2）需把该行换回 `@deepseek-ai/dsh-client-runtime`。

同时需要：

1. **包位置**：把 `packages/dsh-tauri-ssh` 复制为
   `<dsh>/packages/host/dsh-tauri-ssh`，把 `packages/dsh-tauri-ssh-ui` 复制为
   `<dsh>/packages/client/dsh-tauri-ssh-ui`。工作区 glob `packages/*/*` 会自动收录。

2. **pnpm-workspace.yaml**：在 DSH 检出的 `pnpm-workspace.yaml` 的
   `allowBuilds:` 里追加两行（ssh2 的安装脚本在纯 JS 回退下不需要执行）：

   ```yaml
   allowBuilds:
     ssh2: false
     cpu-features: false
   ```

3. **类型检查接线**（`tsc -b` 构建顺序）：
   - `tsconfig.host.json` 的 `references` 数组追加
     `{ "path": "./packages/host/dsh-tauri-ssh" }`；
   - `tsconfig.client.json` 的 `references` 数组追加
     `{ "path": "./packages/client/dsh-tauri-ssh-ui" }`。

4. 构建并启动：

   ```bash
   pnpm install
   pnpm run build:lib
   dsh web            # 或 pnpm run dev:web
   ```

5. 打开 Web UI → 设置 → SSH 机器，添加机器、测试、连接、打开。
