import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readLocale, readSource } from './setup/read-source'

/** issue #871：数据目录的安装期选择与运行期迁移。 */
const PANEL = 'src/ui/config/data-dir.tsx'
const BRIDGE = 'src-tauri/src/bridge/data_dir.rs'
const BUILDER = 'src-tauri/src/desktop/builder.rs'
const MODULE = 'src-tauri/src/service/data_dir/mod.rs'
const MIGRATE = 'src-tauri/src/service/data_dir/migrate.rs'
const ENV = 'src-tauri/src/service/data_dir/env.rs'
const STATE = 'src-tauri/src/service/data_dir/state.rs'
const INSTALLER = 'src-tauri/templates/installer.nsi'

const COMMANDS = [
  'get_data_dir_status',
  'pick_data_dir',
  'list_data_dir_entries',
  'preview_data_dir_migration',
  'migrate_data_dir',
  'rollback_data_dir',
]

describe('data directory panel contract', () => {
  it('exports a named ConfigDataDir function', () => {
    expect(readSource(PANEL)).toContain('export function ConfigDataDir')
  })

  it('invokes every data directory command', () => {
    const source = readSource(PANEL)
    for (const command of COMMANDS)
      expect(source).toContain(command)
  })

  it('renders progress from the data-dir://progress event', () => {
    expect(readSource(PANEL)).toContain('data-dir://progress')
    expect(readSource(MODULE)).toContain('pub const PROGRESS_EVENT: &str = "data-dir://progress";')
  })

  it('uses useTranslation with no hardcoded strings', () => {
    const source = readSource(PANEL)
    expect(source).toContain('useTranslation')
    const cjkRange = '[\\u4e00-\\u9fff]'
    expect(source).not.toMatch(new RegExp(`>${cjkRange}+<`))
    expect(source).not.toContain('useCallback')
    expect(source).not.toContain('useMemo')
  })

  it('invalidates through the shared setting_updated hook instead of listening directly', () => {
    const source = readSource(PANEL)
    expect(source).toContain('useInvalidateOnSettingUpdated(queryKeys.dataDir)')
    expect(source).toContain('useInvalidateOnSettingUpdated(queryKeys.dataDirEntries)')
  })

  it('leaves the Harness shutdown to the backend lock', () => {
    // 前端若自己 shutdown_harness，配置对话框会连带关闭，迁移向导半路消失
    expect(readSource(PANEL)).not.toContain('shutdown_harness')
    expect(readSource(BRIDGE)).toContain('acquire_core_transition')
    expect(readSource(BRIDGE)).toContain('acquire_operation_lock')
  })
})

describe('data directory backend contract', () => {
  it('exposes each command through the bridge', () => {
    const source = readSource(BRIDGE)
    for (const command of COMMANDS)
      expect(source).toMatch(new RegExp(`pub (async )?fn ${command}`))
  })

  it('registers each command with the Tauri builder exactly once', () => {
    const builder = readSource(BUILDER)
    for (const command of COMMANDS) {
      const hits = builder.split(`crate::bridge::${command}`).length - 1
      expect(hits).toBe(1)
    }
  })

  it('keeps the user-level DSH_HOME as the single source of truth', () => {
    expect(readSource(ENV)).toContain('pub(super) const DATA_DIR_ENV: &str = "DSH_HOME";')
    expect(readSource(ENV)).toContain('read_user_env(DATA_DIR_ENV)')
    expect(readSource(ENV)).toContain('write_user_env(DATA_DIR_ENV, value)')
  })
})
describe('data directory usage contract', () => {
  it('treats a missing data directory as an empty list instead of an error', () => {
    // 迁移刚把旧目录改名搬走、Harness 还没重建它，或安装器指向尚未创建的目录时，
    // 「占用空间」区必须走空态文案，不能弹红色 DATA_DIR_READ。
    const source = readSource(MODULE)
    expect(source).toContain('entries_in(&crate::config::get_dsh_data_path(app_handle))')
    expect(source).toContain('Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),')
    expect(source).toContain('DATA_DIR_READ')
  })
})

describe('migration safety contract', () => {
  it('cites the junction accident it must not repeat', () => {
    const source = readSource(MODULE)
    expect(source).toContain('issue #871')
    expect(source).toContain('issue #848')
    expect(source).toContain('不使用目录联接')
  })

  it('never links the new home into place', () => {
    const source = readSource(MIGRATE)
    expect(source).not.toContain('symlink')
    expect(source).not.toContain('junction')
    expect(source).toContain('fs_ops::copy_tree(source, target, &progress)?;')
  })

  it('verifies the copy by file count and total bytes before touching the source', () => {
    const source = readSource(MIGRATE)
    expect(source).toContain('actual.covers(&expected)')
    expect(source).toContain('DATA_DIR_COPY_INCOMPLETE')
    expect(source.indexOf('actual.covers(&expected)')).toBeLessThan(source.indexOf('fs::rename(source, &moved)'))
  })

  it('renames the old directory instead of deleting it', () => {
    // 只看生产代码：测试模块里的 remove_dir_all 清的是临时目录
    const source = readSource(MIGRATE).split('#[cfg(test)]')[0]
    expect(source).toContain('fs::rename(source, &moved)')
    expect(source).not.toContain('remove_dir_all')
    expect(readSource(STATE)).toContain(`const MOVED_INFIX: &str = ".moved-";`)
    expect(readSource(STATE)).toContain(`pub(super) const CURRENT_INFIX: &str = ".current-";`)
  })

  it('records the original location before renaming so cross-drive rollback stays possible', () => {
    const source = readSource(MIGRATE)
    const record = 'state::write_last_migration(app_handle, &source.to_string_lossy())?;'
    expect(source).toContain(record)
    expect(source.indexOf(record)).toBeLessThan(source.indexOf('fs::rename(source, &moved)'))
  })

  it('puts the old directory back when the environment write fails', () => {
    const source = readSource(MIGRATE)
    expect(source).toContain('if let Err(error) = env::write_user_home(&text)')
    expect(source).toContain('if let Err(restore) = fs::rename(&moved, source)')
    expect(source).toContain('DATA_DIR_RENAME_BACK')
  })

  it('refuses to migrate while the Harness still holds the data directory', () => {
    const module = readSource(MODULE)
    expect(module).toContain('pub(super) fn harness_stopped(app_handle: &AppHandle) -> bool')
    expect(module).toContain('.harness.pid')
    const source = readSource(MIGRATE)
    expect(source).toContain('DATA_DIR_HARNESS_RUNNING')
    // 预检（preview_data_dir_migration）不停服，用户点「预检」时 Harness 通常正在运行，
    // 所以停服检查只能落在真正动手的 run() 里；放进 plan() 会让预检永远失败。
    const guard = 'if !harness_stopped(app_handle) {'
    const plan = source.slice(source.indexOf('pub(super) fn plan('), source.indexOf('pub(super) fn run('))
    const run = source.slice(source.indexOf('pub(super) fn run('), source.indexOf('pub(super) fn rollback('))
    expect(plan).not.toContain('harness_stopped')
    expect(run).toContain(guard)
    expect(run.indexOf(guard)).toBeLessThan(run.indexOf('fs_ops::copy_tree'))
  })

  it('confirms the Harness really stopped before touching the data directory', () => {
    // `stop()` 成功后会把 `.harness.pid` 删掉：崩溃残留、不在 owned 注册表里的
    // Harness 会因此看起来「已退出」，所以标记必须在停之前读、停之后再复核。
    const bridge = readSource(BRIDGE)
    // 逐个命令切开看顺序，而不是只数「出现了两次」：数量断言在某一处把复核挪到
    // `stop()` 之前时照样通过，而那种顺序在「崩溃残留、不在 owned 注册表里的
    // Harness」上会直接放行迁移——正是这道守卫要拦的场景。
    const bodies = bridge
      .split('#[tauri::command]')
      .filter(body => body.includes('workflow::stop'))
    expect(bodies.length).toBe(2)
    for (const body of bodies) {
      const recorded = body.indexOf('let recorded = data_dir::harness_marker(&app_handle);')
      const reject = body.indexOf('reject_unreadable_marker(recorded)?;')
      const stop = body.indexOf('crate::service::workflow::stop(app_handle.clone()).await?;')
      const confirm = body.indexOf('confirm_harness_stopped(recorded)?;')
      expect(recorded).toBeGreaterThan(-1)
      expect(reject).toBeGreaterThan(recorded)
      expect(stop).toBeGreaterThan(reject)
      expect(confirm).toBeGreaterThan(stop)
    }
    // 停之前只拦「标记读不出来」，停之后才复核「标记里那个 PID 是否还在」：
    // 标记里写着一个存活 PID 通常就是本应用自己刚拉起的 Harness，停之前一并
    // 拒绝会让正常迁移永远走不下去（`stop()` 才是停它的那一步）。
    // 停之前那道检查必须放行「存活 PID」分支
    expect(bridge).toContain('HarnessMarker::Missing | HarnessMarker::Pid(_) => Ok(())')
    // 停之前那一步必须排在 `stop()` 前面，否则标记已经被删、什么都查不出
    expect(bridge.indexOf('reject_unreadable_marker(recorded)?;')).toBeLessThan(bridge.indexOf('workflow::stop'))
    expect(bridge).toContain('DATA_DIR_HARNESS_RUNNING')
    expect(bridge).toContain('DATA_DIR_HARNESS_MARKER_INVALID')
    // 标记读不出来与标记不在必须分开：前者要先拒绝，否则 `stop()` 删掉标记后
    // 就再也查不出「有个不在 owned 注册表里的 Harness 还在写这个目录」。
    expect(bridge).toContain('HarnessMarker::Invalid')
    expect(bridge).toContain('HarnessMarker::Missing')
    const module = readSource(MODULE)
    expect(module).toContain('pub(crate) enum HarnessMarker {')
    expect(module).toContain('pub(crate) fn harness_marker(app_handle: &AppHandle) -> HarnessMarker {')
    // `harness_stopped` 复用同一份分类，不再各写一遍解析逻辑
    expect(module).toContain('match harness_marker(app_handle) {')
  })

  it('moves a non-empty rollback target aside instead of overwriting it', () => {
    const source = readSource(MIGRATE)
    expect(source).toContain('if fs_ops::is_dir_empty(&restore_to)')
    expect(source).toContain('state::with_current_suffix(&restore_to, &stamp)?')
    expect(source).toContain('DATA_DIR_ROLLBACK_ASIDE')
    expect(source).toContain('DATA_DIR_BACKUP_MISSING')
  })

  it('puts the backup back when the rollback cannot rewrite the environment', () => {
    // 回滚的最后一步是改环境变量，此时备份已搬回原位、当前目录已挪到一边；
    // 直接 `?` 返回会让 DSH_HOME 继续指着刚被搬空的那个目录。
    const source = readSource(MIGRATE)
    // 切到定义处而不是调用处：`indexOf` 命中的是 rollback 里那行调用
    const rollback = source.slice(
      source.indexOf('pub(super) fn rollback('),
      source.indexOf('\nfn rewrite_env_or_undo'),
    )
    expect(rollback).not.toContain('env::write_user_home(&text)?')
    expect(rollback).toContain('rewrite_env_or_undo(&chosen, &restore_to, &aside, apply)?;')
    // 「写失败时到底有没有复原」不看字符串、看行为：Rust 侧
    // `env_write_failure_puts_both_directories_back` 注入一个必然失败的写入，
    // 再核对备份回到 chosen、被挪到一边的当前目录回到 restore_to。
    expect(source).toContain('fn rewrite_env_or_undo<F>(')
    expect(source).toContain('undo_rollback(chosen, restore_to, aside);')
    expect(source).toContain('fn undo_rollback(chosen: &Path, restore_to: &Path, aside: &str)')
    expect(source).toContain('DATA_DIR_ROLLBACK_UNDO')
  })

  it('ranks backups by session count before timestamp', () => {
    const source = readSource(MIGRATE)
    expect(source).toContain('.cmp(&a.sessions)')
    expect(source).toContain('.then_with')
    expect(source).toContain('DATA_DIR_NO_BACKUP')
  })
})

describe('installer data directory page', () => {
  it('stays UTF-8 with a BOM so NSIS 3.x can compile the Chinese strings', () => {
    const bytes = readFileSync(new URL(`../${INSTALLER}`, import.meta.url))
    expect([...bytes.subarray(0, 3)]).toEqual([0xEF, 0xBB, 0xBF])
  })

  it('asks for the data directory after the install directory', () => {
    const source = readSource(INSTALLER)
    const directoryPage = source.indexOf('!insertmacro MUI_PAGE_DIRECTORY')
    const dataPage = source.indexOf('Page custom DshDataDirPage DshDataDirLeave')
    expect(directoryPage).toBeGreaterThan(-1)
    expect(dataPage).toBeGreaterThan(directoryPage)
  })

  it('writes the user-level DSH_HOME and broadcasts the change', () => {
    const source = readSource(INSTALLER)
    expect(source).toContain('ReadRegStr $DshDataDirOriginal HKCU "Environment" "DSH_HOME"')
    expect(source).toContain('WriteRegStr HKCU "Environment" "DSH_HOME" "$DshDataDirNew"')
    expect(source).toContain('DeleteRegValue HKCU "Environment" "DSH_HOME"')
    expect(source).toContain(`SendMessageTimeoutW(p 0xFFFF, i ${'$'}{WM_SETTINGCHANGE}`)
  })

  it('prefers the persisted value over the inherited environment when pre-filling', () => {
    const source = readSource(INSTALLER)
    const onInit = source.slice(source.indexOf('Function .onInit'), source.indexOf('Section EarlyChecks'))
    const persistedWins = onInit.indexOf('    StrCpy $DshDataDirNew "$DshDataDirOriginal"')
    const inheritedWins = onInit.indexOf('    StrCpy $DshDataDirOriginal "$DshDataDirNew"')
    expect(persistedWins).toBeGreaterThan(-1)
    expect(inheritedWins).toBeGreaterThan(-1)
    expect(persistedWins).toBeGreaterThan(inheritedWins)
  })

  it('does not disturb updates, silent or passive installs', () => {
    const source = readSource(INSTALLER)
    const page = source.slice(source.indexOf('Function DshDataDirPage'), source.indexOf('Function DshDataDirPick'))
    expect(page).toContain('$PassiveMode = 1')
    expect(page).toContain(`${'$'}{Silent}`)
    expect(page).toContain('$UpdateMode = 1')
    expect(page).toContain('Abort')
  })

  it('ships both bundled languages', () => {
    const source = readSource(INSTALLER)
    expect(source).toContain(`LangString DshDataDirTitle ${'$'}{LANG_ENGLISH} "Data directory"`)
    expect(source).toContain(`LangString DshDataDirTitle ${'$'}{LANG_SIMPCHINESE} "数据存放目录"`)
    expect(source).toContain('!ifdef LANG_SIMPCHINESE')
  })
})

describe('data directory translations', () => {
  it('keeps both locales in step', () => {
    const zh = readLocale('zh-CN')
    const en = readLocale('en-US')
    const picked = (locale: Record<string, string>) => Object.keys(locale)
      .filter(key => key === 'config.dataDir' || key.startsWith('data_dir.'))
      .sort()
    expect(picked(zh)).toEqual(picked(en))
    expect(picked(zh).length).toBeGreaterThan(40)
  })
})
