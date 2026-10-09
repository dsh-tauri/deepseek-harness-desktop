import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  containsPatchEntryUnresolved,
  containsPatchLayerParseError,
  containsQuarantineFailure,
  PATCH_ENTRY_UNRESOLVED_CODE,
  patchEntryUnresolvedEntries,
  patchLayerErrorDetail,
  quarantineFailureDetail,
} from '../src/store/modules/harness/patch-layer'

const eventListeners = new Map<string, (event: unknown) => void>()
const invoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, callback: (payload: unknown) => void) => {
    eventListeners.set(event, callback)
    return vi.fn()
  }),
}))
vi.mock('@/config/client', () => ({ queryClient: { invalidateQueries: vi.fn() } }))
vi.mock('../src/store/modules/harness-updater', () => ({
  harnessUpdater: { checkForUpdate: vi.fn() },
}))

// 必须在 mock 工厂所需的变量初始化之后再取用 store（vi.mock 会被提升到文件顶部）。
const { harness } = await import('../src/store/modules/harness')

beforeEach(() => {
  eventListeners.clear()
  invoke.mockReset()
  Object.assign(harness, {
    status: 'ready',
    errorMsg: '',
    errorLogs: [],
    busyAction: null,
  })
})
/**
 * issue #525：用户手写的 `cordis.patch.yml` 解析失败时，启动失败信息里的真实
 * 原因被包在「Plugin installation 阶段失败」里，前端必须能识别出来并给出
 * 「哪个文件、哪一行、怎么改」的提示与隔离入口。
 */
const REAL_FAILURE = 'Harness 在Plugin installation阶段失败。最后的就绪状态：'
  + 'INTERNAL_PLUGIN_INSTALL_FAILED: INTERNAL_PLUGIN_PATCH_PARSE_FAILED: '
  + 'C:\\Users\\Administrator\\.dsh\\cordis.patch.yml: '
  + 'mapping values are not allowed in this context at line 15 column 155'

describe('patch layer diagnostics', () => {
  it('recognizes a wrapped patch parse failure', () => {
    expect(containsPatchLayerParseError(REAL_FAILURE)).toBe(true)
  })

  it('ignores unrelated startup failures', () => {
    expect(containsPatchLayerParseError('Harness 在process-boot阶段失败')).toBe(false)
    // 只是提到错误码（例如日志行）但没有 `:` 分隔的细节时不算命中。
    expect(containsPatchLayerParseError('see INTERNAL_PLUGIN_PATCH_PARSE_FAILED for details')).toBe(false)
  })

  it('extracts the file path and YAML error with line and column', () => {
    expect(patchLayerErrorDetail(REAL_FAILURE)).toBe(
      'C:\\Users\\Administrator\\.dsh\\cordis.patch.yml: '
      + 'mapping values are not allowed in this context at line 15 column 155',
    )
  })

  it('returns an empty detail when the code is absent', () => {
    expect(patchLayerErrorDetail('Harness 在plugin-install阶段失败')).toBe('')
  })
})

/**
 * 隔离失败（改名被占用 / 权限拒绝）：后端拒绝切档案与重启并回
 * `PATCH_LAYER_QUARANTINE_FAILED`，前端必须据此换成「先处理文件」的提示，
 * 而不是假装已恢复。
 */
const QUARANTINE_FAILURE = 'PATCH_LAYER_QUARANTINE_FAILED: '
  + 'C:\\Users\\Administrator\\.dsh\\cordis.patch.yml: Access is denied. (os error 5)'

describe('patch quarantine failures', () => {
  it('recognizes an aborted quarantine', () => {
    expect(containsQuarantineFailure(QUARANTINE_FAILURE)).toBe(true)
    // 成功路径上的解析失败提示不应被误判为隔离失败。
    expect(containsQuarantineFailure(REAL_FAILURE)).toBe(false)
  })

  it('extracts the path and rename error', () => {
    expect(quarantineFailureDetail(QUARANTINE_FAILURE)).toBe(
      'C:\\Users\\Administrator\\.dsh\\cordis.patch.yml: Access is denied. (os error 5)',
    )
    expect(quarantineFailureDetail(REAL_FAILURE)).toBe('')
  })
})

/**
 * 补丁层悬空 insert：包被卸载后手写的 `insert` 还留在 `cordis.patch.yml` 里，
 * loader 抛 ERR_MODULE_NOT_FOUND 让整棵树加载失败。启动前预检把「哪个文件、
 * 哪一行、哪个包」以 JSON 挂在错误码之后，前端解析出来给提示与「移除悬空条目」入口。
 */
const ENTRY_UNRESOLVED = `PATCH_LAYER_ENTRY_UNRESOLVED: ${JSON.stringify({
  entries: [
    {
      layer: 'C:\\Users\\Administrator\\.dsh\\profiles\\web\\cordis.patch.yml',
      line: 3,
      id: 'file-edit',
      name: 'dsh-file-edit',
      declared: false,
    },
    {
      layer: 'C:\\Users\\Administrator\\.dsh\\cordis.patch.yml',
      line: 1,
      id: null,
      name: 'dsh-other',
      declared: true,
    },
  ],
})}`

describe('patch layer unresolved entries', () => {
  it('recognizes a dangling insert failure', () => {
    expect(containsPatchEntryUnresolved(ENTRY_UNRESOLVED)).toBe(true)
    expect(containsPatchEntryUnresolved(REAL_FAILURE)).toBe(false)
    expect(containsPatchEntryUnresolved('see PATCH_LAYER_ENTRY_UNRESOLVED for details')).toBe(false)
  })

  it('parses the structured detail', () => {
    expect(patchEntryUnresolvedEntries(ENTRY_UNRESOLVED)).toEqual([
      {
        layer: 'C:\\Users\\Administrator\\.dsh\\profiles\\web\\cordis.patch.yml',
        line: 3,
        id: 'file-edit',
        name: 'dsh-file-edit',
        declared: false,
      },
      {
        layer: 'C:\\Users\\Administrator\\.dsh\\cordis.patch.yml',
        line: 1,
        id: null,
        name: 'dsh-other',
        declared: true,
      },
    ])
  })

  it('parses a payload wrapped in other copy', () => {
    const wrapped = `Harness 在process-boot阶段失败：${ENTRY_UNRESOLVED}（退出码 1）`
    expect(patchEntryUnresolvedEntries(wrapped)).toHaveLength(2)
  })

  it('degrades to an empty list when the payload is unusable', () => {
    expect(patchEntryUnresolvedEntries('Harness 在process-boot阶段失败')).toEqual([])
    expect(patchEntryUnresolvedEntries('PATCH_LAYER_ENTRY_UNRESOLVED: not json')).toEqual([])
    expect(patchEntryUnresolvedEntries('PATCH_LAYER_ENTRY_UNRESOLVED: {"entries":{}}')).toEqual([])
  })
})

/**
 * 错误码与恢复入口的跨层契约：前端识别用的码必须与 Rust 预检抛出的码一致，
 * 错误页的按钮必须真的接到「移除悬空条目」命令上——漏注册 invoke 命令时，
 * 用户点下去只会得到一个 unknown command 报错，而这种链路断点在单测里最容易漏。
 */
describe('unresolved-entry recovery wiring', () => {
  const rustSource = readFileSync(
    new URL('../src-tauri/src/service/plugin/patch_entries.rs', import.meta.url),
    'utf8',
  )
  const handlerSource = readFileSync(
    new URL('../src-tauri/src/desktop/builder.rs', import.meta.url),
    'utf8',
  )
  const storeSource = readFileSync(
    new URL('../src/store/modules/harness/store.ts', import.meta.url),
    'utf8',
  )
  const setupSource = readFileSync(
    new URL('../src/layout/components/setup.tsx', import.meta.url),
    'utf8',
  )

  it('shares the error code with the Rust preflight', () => {
    expect(rustSource).toContain(`"${PATCH_ENTRY_UNRESOLVED_CODE}"`)
  })

  it('registers the strip command and calls it from the error page', () => {
    expect(handlerSource).toContain('crate::bridge::strip_unresolved_patch_entries')
    expect(storeSource).toContain('invoke<PatchEntryStripReport>(\'strip_unresolved_patch_entries\')')
    expect(setupSource).toContain('store.harness.stripUnresolvedPatchEntries()')
    expect(setupSource).toContain('buttons.strip_patch_entries')
  })

  it('keeps the two patch-layer recovery buttons mutually exclusive', () => {
    expect(setupSource).toContain('patchLayerHint !== \'\' && !patchEntriesUnresolved')
  })

  it('backs the file up before rewriting it', () => {
    expect(rustSource).toContain('backup_path(&layer, "bak"')
  })

  it('routes every recovery entry through the shared busy reservation', () => {
    for (const call of [
      'runPatchRepair(\'safe-mode\'',
      'runPatchRepair(\'quarantine\'',
      'runPatchRepair(\'strip\'',
    ]) {
      expect(storeSource).toContain(call)
    }
  })

  it('reserves the busy state before the repair callback gets to run', async () => {
    let release: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    // 让修复之后的 restart 能安静跑完：这条用例只关心占住忙态的时机。
    invoke.mockImplementation(async (command: string) => {
      if (command === 'get_runtime_info')
        return { service_url: 'http://127.0.0.1:31415' }
      if (command === 'runtime_ready')
        return true
      if (command === 'proxy_health_check')
        return 'Healthy'
      if (command === 'get_preinstall_pending')
        return false
      if (command === 'detect_plugin_recovery')
        return { plugins: [], reason: 'unknown', detail: '', rawError: '' }
      if (command === 'read_service_logs')
        return ''
      if (command === 'get_app_config')
        return { installed: true, port: 3080, harness_max_heap_mb: 16384, proxy_url: '', auto_start: true, cli_link_enabled: true, zoom_factor: 1, close_action: 'tray', backup_retention_count: 10, backup_include_credentials: false, language: null }
      return undefined
    })

    const repair = harness.runPatchRepair('safe-mode', async () => {
      await pending
    })
    // 忙态必须在修复动作的第一次 await 之前就占住：顺序反过来就等于没占，
    // 退出处理器的自动恢复会在修复途中把它自己的重启插进来。
    expect(harness.busyAction).toBe('repair')
    release()
    await repair
  })
})
