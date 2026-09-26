# S5 桌面壳集成 — 数据面全旅程 E2E 证据（dev 真机）

> **最新一次（v14 适配分支复跑）**：2026-09-13，分支 `feat/ssh-remote-machines-v14`
> （origin/main v0.14.1 + DSH 0.1.5-rc.2 版本钉），同一驱动脚本同一 dev 机器
> **ALL STEPS PASSED ✅**：connect 5.1s（bootstrap probe→launch→ready）、
> list 回报 `connected + tunnelBaseUrl + authMethod=key`、隧道 GET / 通
> （远端 401 鉴权提示）、事件 6 条（probe×3/launch/ready/auth）、
> disconnect/remove 干净。原始输出转录于本节末尾。
> 注：本次复跑时 `~/.dsh.dev/profiles/s5e2e` 已不存在，按下方复现步骤 2
> 重建后执行。

- 日期：2026-09-04（首轮）/ 2026-09-13（v14 适配分支复跑）
- 本地实例：无头 `dsh web`（DSH_HOME=`~/.dsh.dev`，profile `s5e2e`，端口 3185，
  挂载本 worktree 的 `dsh-tauri-ssh` / `dsh-tauri-ssh-ui` link: 包，见下方复现步骤）
- 远端机器：`dev`（Linux 5.4 x86_64，root + 密钥认证，`~/.ssh/config` 别名）
- 驱动脚本：`scripts/e2e-ssh-data-plane.mjs`（/api-ssh HTTP 信封直驱，退出码 0 = 通过）
- 本文档转录的是脚本原始输出（`--out`），未做修饰。

## 结果：ALL STEPS PASSED ✅

```text
# S5 SSH 数据面全旅程 — 2026-09-04T19:00:49.683Z
base=http://127.0.0.1:3185 host=dev user=root sshPort=22 remotePort=3082
machineId=a0f9fff6-e69a-49c3-91d2-89787a0d78c7

[1] machine.save ok → name=s5-e2e-dev state=disconnected color=#7c5cff tintBorder=true (discovered aliases: 5)

[2] machine.connect …（bootstrap/健康探测可能需要数十秒）
    connect ok in 3.7s tunnelBaseUrl=http://127.0.0.1:64985
[3] machine.list → state=connected tunnelBaseUrl=http://127.0.0.1:64985 authMethod=key
[4] tunnel GET / → HTTP 401（远端实例鉴权提示，隧道传输已通）body head: dsh web authentication required; reopen the URL printed by d
[5] machine.events → 6 条 (1:probe 2:probe 3:probe 4:launch 5:ready 6:auth)
[6] machine.disconnect ok → state=disconnected
[7] machine.remove ok → items=0（目标机器已从列表消失，discovered 别名不受影响：5）

ALL STEPS PASSED ✅
```

各步对应 Spec 验收点：

| 步骤 | 观察点 |
|---|---|
| machine.save | color/tintBorder 落库并透传（切换器色点与边框着色的数据源） |
| machine.connect | S2 bootstrap 链路（probe→launch→ready），密钥认证 `authMethod=key`，3.7s 就绪 |
| machine.list | 六态词汇 `connected` + `tunnelBaseUrl`（S3 契约增量字段透传） |
| tunnel GET / | 回环隧道真实传输（远端实例 alpha 鉴权 401 标记 = 远端 dsh 应答） |
| machine.events | 事件通道含 `probe`/`launch`/`ready`/`auth` 阶段（C-EVENT） |
| machine.disconnect / remove | 断开回 `disconnected`；删除后列表行消失、别名机器不受影响 |

## 复现步骤

1. 构建插件产物（worktree 内）：`pnpm build:plugins`。
2. 建无头档案 `~/.dsh.dev/profiles/s5e2e`（方式 B，见
   `docs/plugins/ssh-cordis.patch.example.md`）：`package.json` 依赖两包
   `link:<worktree>/packages/dsh-tauri-ssh{,-ui}`，`dsh.profile.bundles` 含
   `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 与两插件；
   `cordis.patch.yml` 为空层 `[]`（插件包自带 cordis.patch.yml，profile 层
   再 insert 会得到 `duplicate loader entry id: ssh-remote`）。
3. `cd ~/.dsh.dev/profiles/s5e2e && pnpm install`。
4. 启动无头实例（注意 alpha token）：
   `DSH_HOME=~/.dsh.dev node <AppData>/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile s5e2e --host 127.0.0.1 --port 3185`
5. 清理远端残留（上一轮实例不随断开退出）：`ssh dev 'pkill -f dsh-s5e2e'`。
6. 驱动全旅程（见下方命令；`--out` 落证据）。

```bash
node scripts/e2e-ssh-data-plane.mjs \
  --base http://127.0.0.1:3185 --token <alpha-token> \
  --host dev --user root --port 22 --remote-port 3082 \
  --start-command 'export DSH_HOME=$HOME/.dsh-s5e2e && exec "$HOME/.dsh-desktop/runtime/bin/node" "$HOME/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" web --host 127.0.0.1 --port 3082 --no-open' \
  --out evidence.md
```

## dev 机器环境注记（为什么带自定义 startCommand）

- dev 的 home 层补丁 `~/.dsh/cordis.patch.yml` 静态 pin 了
  `webserver.port: 3081`（该机器跑着 caddy 反代的常驻实例；按 dsh 设计，
  patch 层 config 压过 CLI `--port`，任何默认启动都会撞 EADDRINUSE 3081）。
  故用独立 `DSH_HOME=~/.dsh-s5e2e` 绕开机器本地配置，3082 为空闲端口。
- 非交互 ssh 无 nvm PATH；远端已有 S2 bootstrap 三件套
  （`~/.dsh-desktop/runtime/bin/node` + `dependencies/dsh`），startCommand
  直接用绝对路径引用。
- 引擎默认启动命令（不带 startCommand）在本机同样可行，只要远端 home 层
  不 pin 端口；自定义 startCommand 是 `MachineProfile.startCommand` 的
  一等能力（逐字执行，无 `{port}` 模板替换——文档示例中的 `{port}` 占位
  笔记与实现不符，以 `bootstrap.ts startCommandFor` 为准）。
- 断开只关隧道、不停远端实例（引擎语义），重复跑前需第 5 步清理。

## 附录：v14 适配分支复跑原始输出（2026-09-13）

```text
# S5 SSH 数据面全旅程 — 2026-09-13T16:58:27.271Z
base=http://127.0.0.1:3185 host=dev user=root sshPort=22 remotePort=3082
machineId=5d44371b-f013-49f3-9ac3-c7891629fdce

[1] machine.save ok → name=s5-e2e-dev state=disconnected color=#7c5cff tintBorder=true (discovered aliases: 5)

[2] machine.connect …（bootstrap/健康探测可能需要数十秒）
    connect ok in 5.1s tunnelBaseUrl=http://127.0.0.1:50324
[3] machine.list → state=connected tunnelBaseUrl=http://127.0.0.1:50324 authMethod=key
[4] tunnel GET / → HTTP 401（远端实例鉴权提示，隧道传输已通）body head: dsh web authentication required; reopen the URL printed by d
[5] machine.events → 6 条 (1:probe 2:probe 3:probe 4:launch 5:ready 6:auth)
[6] machine.disconnect ok → state=disconnected
[7] machine.remove ok → items=0（目标机器已从列表消失，discovered 别名不受影响：5）

ALL STEPS PASSED ✅
```
