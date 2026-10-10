import { beforeEach, describe, expect, it } from 'vitest'
import { consumePortConflictRestart, resetPortConflictRestarts } from './utils'

/** 真实崩溃现场那份 dsh-web.log 的内容，原样保留行序 */
const REAL_CRASH_LOG = [
  '\'codegraph\' 不是内部或外部命令，也不是可运行的程序',
  '或批处理文件。',
  '{"ts":"2026-10-09T23:54:55.816Z","level":"warn","msg":"Phase 3 SAFE MODE 激活：存在未恢复的 transaction，destructive 操作被阻断（如需恢复请先显式处理）"}',
  '{"ts":"2026-10-09T23:54:55.834Z","level":"warn","msg":"webServer 服务不可用：跳过 /api/dsh-config-manager 路由注册（引擎能力仍可用）"}',
  '\'codegraph\' 不是内部或外部命令，也不是可运行的程序',
  '或批处理文件。',
  '{"ts":"2026-10-09T23:54:57.055Z","level":"warn","msg":"Phase 3 RECOVERY_REQUIRED：上次 destructive operation 崩溃残留，需显式恢复；destructive 调度器未启动（read-only host 存活）"}',
  '\'codegraph\' 不是内部或外部命令，也不是可运行的程序',
  '或批处理文件。',
  '\'codegraph\' 不是内部或外部命令，也不是可运行的程序',
  '或批处理文件。',
  '\'codegraph\' 不是内部或外部命令，也不是可运行的程序',
  '或批处理文件。',
  '\'codegraph\' 不是内部或外部命令，也不是可运行的程序',
  '或批处理文件。',
  '\'npx\' 不是内部或外部命令，也不是可运行的程序',
  '或批处理文件。',
  '\'codegraph\' 不是内部或外部命令，也不是可运行的程序',
  '或批处理文件。',
  'dsh-mnemon: could not recover retained legacy settings Error: cannot get required service "profileContext" in inactive context',
  'at Proxy.configuration (file:///C:/Users/iuuuuuuuu/AppData/Roaming/dsh-tauri/dependencies/dsh/node_modules/@deepseek-ai/dsh-config-editor/lib/index.js:40:37)',
  'at Object.apply (file:///C:/Users/iuuuuuuuu/AppData/Roaming/dsh-tauri/dependencies/dsh/node_modules/@deepseek-ai/cordis/lib/index.js:120:36)',
  'at plan (file:///D:/DSHHome/profiles/tauri/node_modules/dsh-mnemon/lib/index.js:14517:38)',
  'at ProfileMnemonSettings.performImport (file:///D:/DSHHome/profiles/tauri/node_modules/dsh-mnemon/lib/index.js:14541:19)',
  'at async file:///D:/DSHHome/profiles/tauri/node_modules/dsh-mnemon/lib/index.js:14680:4',
  'dsh: startup failed: 2 required plugins did not activate',
  'Failed plugins (1):',
  'webserver (required)',
  'Package: @deepseek-ai/dsh-host-webserver',
  'Error: listen EADDRINUSE: address already in use 127.0.0.1:3080',
  'at Server.setupListenHandle [as _listen2] (node:net:2008:16)',
  'at listenInCluster (node:net:2065:12)',
  'at node:net:2274:7',
  'at process.processTicksAndRejections (node:internal/process/task_queues:90:21)',
  'Plugins waiting for services (15):',
  'Plugin                  Missing services',
  'web-runtime (required)  webServer',
  'open-in-app             webServer',
  'directory-picker        webServer',
  'client-hmr              webServer',
  'dsh-tauri-archive       webServer',
  'dsh-tauri-extension     webServer',
  'dsh-tauri-model         webServer',
  'dsh-tauri-notification  webServer',
  'dsh-tauri-pet           webServer',
  'dsh-tauri-rightclick    webServer',
  'dsh-tauri-scheduler     webServer',
  'ssh-remote              webServer',
  'dsh-tauri-ui            webServer',
  'dsh-tauri-worktree      webServer',
  'bridge-browser          webServer',
  'Full diagnostics: D:\\DSHHome\\logs\\startup-2026-10-09T23-55-29.658Z-4efe91d3-b128-4ce5-8738-1e5a1d34a6a8.log',
]

describe('端口冲突自愈：真实崩溃日志', () => {
  beforeEach(() => {
    resetPortConflictRestarts()
  })

  it('真实 EADDRINUSE 崩溃日志判定为需自愈', () => {
    expect(consumePortConflictRestart(REAL_CRASH_LOG)).toBe(true)
  })

  it('前端读取的 64KB 尾部窗口内同样命中', () => {
    expect(consumePortConflictRestart(REAL_CRASH_LOG.slice(-64))).toBe(true)
  })
})
