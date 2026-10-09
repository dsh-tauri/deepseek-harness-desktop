/**
 * react-query 查询键集中定义。
 *
 * 查询键是「谁在读写同一份缓存」的契约：面板查询、store 的重启失效、后端事件
 * 写入缓存都按同一份字面量操作，散落各处会出现「失效不生效」的静默 bug。
 */
export const queryKeys = {
  appIdentifier: ['app_identifier'] as const,
  taskManager: ['task_manager'] as const,
  taskManagerLogs: ['task_manager_logs'] as const,
  /** 运行时信息（版本 / 端口 / 路径，debug 面板） */
  info: ['info'] as const,
  /** CLI 链接状态（debug 面板） */
  cliStatus: ['cli_status'] as const,
  /** 开机自启开关 */
  launchOnLogin: ['launch_on_login'] as const,
  /** Harness 核心列表（local / app-<tag>） */
  cores: ['cores'] as const,
  /** 已安装 dsh 插件列表（面板 / 配置对话框角标 / 导航栏共用） */
  plugins: ['plugins'] as const,
  /** 本地插件热重载开关与监听状态（插件面板） */
  localPluginHmr: ['local_plugin_hmr'] as const,
  /** dsh 档案列表 */
  profiles: ['profiles'] as const,
  /** 某一档案的可迁移插件与数据（迁移对话框，按源档案 id 区分） */
  profileMigration: (sourceId: string) => ['profile_migration', sourceId] as const,
  /** 当前档案的备份快照列表 */
  backups: ['backups'] as const,
  /** 数据目录状态与旧目录备份（issue #871） */
  dataDir: ['data_dir'] as const,
  /** 数据目录下的一级子项体积（issue #871） */
  dataDirEntries: ['data_dir_entries'] as const,
  remoteMachines: ['remote_machines'] as const,
  remoteEvents: ['remote_events'] as const,
} as const
