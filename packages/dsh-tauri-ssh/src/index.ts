/**
 * The DSH remote-machine host plugin. Owns the plugin state document (the
 * enable switch + the manual machine table), the SSH connection manager (TOFU
 * host keys, remote `dsh web` auto-start, loopback tunnels), and mounts the
 * same-origin `/api-ssh` route on `ctx.webServer` for the settings page. No
 * upstream DSH source is touched: every integration is a documented cordis
 * extension point.
 *
 * 三层目录（host / shared）：
 *   - index.ts（本文件）  public barrel（只保留导出面）；
 *   - shared/constants    跨 half 协议常量（插件名 / API 前缀）；
 *   - host/               Node half：routes（/api-ssh 路由）/ storage
 *                         （状态文档读写与插件配置）/
 *                         service（manager 状态机、bootstrap 远端保障、
 *                         ssh-config 凭据解析、transport ssh2 传输、
 *                         host-keys TOFU 存储）/ types / apply。
 * @module dsh-tauri-ssh
 */

export { apply, Config, default, inject, name, SshRemoteService } from './host/apply'
export type { SshMachineEvent, SshMachineEventsPage, SshMachineStage, SshMachineTerminal } from './host/types/index'
export { SSH_API_PREFIX } from './shared/constants'
