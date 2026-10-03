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

  it('moves a non-empty rollback target aside instead of overwriting it', () => {
    const source = readSource(MIGRATE)
    expect(source).toContain('if fs_ops::is_dir_empty(&restore_to)')
    expect(source).toContain('state::with_current_suffix(&restore_to, &stamp)?')
    expect(source).toContain('DATA_DIR_ROLLBACK_ASIDE')
    expect(source).toContain('DATA_DIR_BACKUP_MISSING')
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
