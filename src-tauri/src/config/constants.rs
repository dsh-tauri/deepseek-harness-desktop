use std::time::Duration;

/// 捆绑的 Node.js 运行时版本（满足当前 DSH 的 v22.19.0+ 或 v24+ 要求）
pub const NODE_VERSION: &str = "v22.22.0";

/// Node.js 官方下载地址
pub const NODE_BASE_URL: &str = "https://nodejs.org/dist/";

/// Node.js 镜像下载地址（npmmirror，302 重定向至 cdn.npmmirror.com）
pub const NODE_MIRROR_BASE_URL: &str = "https://npmmirror.com/mirrors/node/";

/// 打包的 DeepSeek Harness 发行版下载地址（GitHub Release，默认首选源）
pub const DSH_CORE_URL: &str =
    "https://github.com/dsh-tauri-desk/deepseek-harness-pkg/releases/latest/download/";

/// GitHub Release 的 ghfast.top 中转前缀（透传官方 URL，下载内容一致、
/// 仍可做 SHA-256 完整性校验），用作官方直连失败时的兜底镜像。
pub const DSH_MIRROR_PREFIX: &str = "https://ghfast.top/";

/// 捆绑的 pnpm 版本（与 deepseek-harness-pkg 的 packageManager: pnpm@11.7.0 对齐）
pub const PNPM_VERSION: &str = "11.7.0";
/// pnpm 11.7.0 官方 npm tarball 的 SHA-256；升级版本时必须同步更新。
pub const PNPM_SHA256: &str = "deafa7ec98a1218b6a047289b92fbe2395c1e22d3495bb711653013218ee15ee";

/// pnpm 官方 npm registry tarball 下载地址前缀（纯 JS 发行，全平台同一 URL）
pub const PNPM_BASE_URL: &str = "https://registry.npmjs.org/pnpm/-/";

/// Windows 空白环境使用的免安装 MinGit 版本。
#[cfg_attr(all(not(windows), not(test)), allow(dead_code))] // 仅 Windows 的 MinGit 任务与单测使用
pub const MINGIT_VERSION: &str = "2.53.0.2";
/// MinGit x64 官方发行包 SHA-256。
#[cfg_attr(all(not(windows), not(test)), allow(dead_code))] // 仅 Windows 的 MinGit 任务与单测使用
pub const MINGIT_X64_SHA256: &str =
    "d4bf83d6a860ccae9af44e508e1e00a39f09db6fa78a9ba5543b94d87ca22a29";
/// MinGit ARM64 官方发行包 SHA-256。
#[cfg_attr(all(not(windows), not(test)), allow(dead_code))] // 仅 Windows 的 MinGit 任务与单测使用
pub const MINGIT_ARM64_SHA256: &str =
    "842d50edc6bbcf39693e60a8ebb9dabb89b96b932b63aae12d218522b3e497f3";
/// Git for Windows 官方发行资产地址前缀。
#[cfg_attr(all(not(windows), not(test)), allow(dead_code))] // 仅 Windows 的 MinGit 任务与单测使用
pub const MINGIT_BASE_URL: &str =
    "https://github.com/git-for-windows/git/releases/download/v2.53.0.windows.2/";

/// pnpm 镜像下载地址前缀（npmmirror registry，302 重定向至 cdn.npmmirror.com）
pub const PNPM_MIRROR_BASE_URL: &str = "https://registry.npmmirror.com/pnpm/-/";

/// Harness 服务地址与默认端口
pub const DSH_HOST: &str = "http://127.0.0.1";
/// 生产（release）默认端口
pub const DSH_PORT: u16 = 3080;
/// 开发（debug）默认端口：与生产隔离，避免 `pnpm tauri dev` 与已安装桌面端
/// 争用同一个 3080 端口冲突。
pub const DSH_DEV_PORT: u16 = 3081;

/// 官方 Harness 用户数据目录名：release 构建的 `$DSH_HOME` 默认目录（`~/.dsh`，
/// 与官方 node 安装保持一致）。
pub const DSH_HOME_DIR_NAME: &str = ".dsh";
/// 开发（debug）构建的用户数据目录名（`~/.dsh.dev`）：与生产数据目录隔离。
/// 会话、档案、插件与主题等数据各自独立——`pnpm tauri dev` 与已安装桌面端
/// 同时运行时互不干扰，也不会互相污染对方的会话数据。
pub const DSH_HOME_DEV_DIR_NAME: &str = ".dsh.dev";

/// 开发构建在 AppData 下使用的独立子目录。Node、Harness、pnpm、Git 等可执行
/// 核心不应与 release 共用，否则开发版更新/切换核心会替换正在运行的生产文件。
pub const APP_DATA_DEV_DIR_NAME: &str = "dev";

/// 安装目录与 CLI 入口（相对安装目录）
pub const DSH_CORE_DIR: &str = "dsh";
pub const DSH_ENTRY_RELATIVE: &str = "node_modules/@deepseek-ai/dsh/lib/bin.js";
pub const DSH_MANIFEST_RELATIVE: &str = "package.json";

/// pnpm 安装目录与 CLI 入口（相对安装目录）
pub const PNPM_CORE_DIR: &str = "pnpm";
pub const PNPM_ENTRY_RELATIVE: &str = "bin/pnpm.cjs";

/// 开发构建的用户级 shim 根目录名，不与 release 的 CLI 集成目录冲突。
#[cfg_attr(not(windows), allow(dead_code))] // 仅 Windows 的 bin 目录计算使用
pub const CLI_ROOT_DEV_DIR_NAME: &str = "deepseek-harness-dev";

/// Windows 免安装 Git 的安装目录与 CLI 入口（相对安装目录）。
#[cfg_attr(not(windows), allow(dead_code))] // 仅 Windows 的 MinGit 安装路径使用
pub const MINGIT_CORE_DIR: &str = "git";
#[cfg_attr(not(windows), allow(dead_code))] // 仅 Windows 的 MinGit 安装路径使用
pub const MINGIT_ENTRY_RELATIVE: &str = "cmd/git.exe";

/// 旧版数据目录名：迁移前 $DSH_HOME 位于 `{app_data}/data/dsh`，
/// 现仅用于 legacy 路径识别（见 service::migrate）。新 $DSH_HOME = 官方 `~/.dsh`。
pub const DSH_DATA_DIR_NAME: &str = "dsh";

/// 简单 Store 持久化
pub const STORE_DAT_FILE: &str = ".store.dat";
/// 开发（debug）构建的 Store 持久化文件名：与生产隔离，避免端口、installed、
/// active_core 等设置跨版本互写（生产默认 3080、开发默认 3081，共用一份
/// store 会让两边端口一路漂移并相互污染状态）。
pub const STORE_DAT_DEV_FILE: &str = ".store.dev.dat";
/// E2E 构建的 Store 持久化文件名：与开发/生产三方隔离。
///
/// 测试跑的是 debug 二进制，若复用 `.store.dev.dat`，用例写入的窗口几何会覆盖
/// 用户正在使用的开发版配置（且 `app_data_dir()` 由 `SHGetKnownFolderPath` 解析，
/// 重定向 `APPDATA`/`USERPROFILE` 环境变量**无法**把它引到 scratch 目录）。
pub const STORE_DAT_TEST_FILE: &str = ".store.test.dat";
/// E2E 信号环境变量：与 `tauri-plugin-wdio-webdriver` 的门控同源——该插件只在
/// 此变量存在时监听，应用也据此切到测试 Store，二者不会各走各的。
pub const E2E_PORT_ENV_VAR: &str = "TAURI_WEBDRIVER_PORT";

/// 手动开关：为 `true` 时禁用环境（Node/pnpm/Git）与 Harness 核心的自动下载。
///
/// 默认 `false`——正常使用不受影响。置 `true` 后 `install_dependencies` 直接返回
/// 「未安装」、`download_core` 拒绝执行，应用只能使用已落盘的运行时与预打包核心。
/// 想临时省流量又不想改代码时，用 `E2E_DISABLE_DOWNLOAD_ENV_VAR`。
pub const DISABLE_AUTO_DOWNLOAD: bool = false;

/// 运行期选择禁用自动下载的环境变量：值为 `1` / `true` 时生效。
///
/// 供 E2E 按需选择：只验壳层行为的用例可置位以跳过一次联网核对；需要覆盖
/// 启动装配流程的用例则保持不置位，让应用正常走安装路径。
pub const E2E_DISABLE_DOWNLOAD_ENV_VAR: &str = "DSH_E2E_DISABLE_DOWNLOAD";

/// 下载缓存根的环境变量：覆盖 `<app-data>[/dev]` 这个基础目录。
///
/// 环境（Node/pnpm/Git）与核心都装在该根下。E2E 每次使用全新 scratch home，
/// 若不覆盖就会反复重下；把它指向一个稳定目录即可让首次下载在后续运行中复用。
pub const DOWNLOAD_CACHE_ENV_VAR: &str = "DSH_DOWNLOAD_CACHE_DIR";
pub const STORE_SETTING_KEY: &str = "setting";
/// Store 中记录主窗口几何（位置/大小/最大化）的键
pub const STORE_WINDOW_STATE_KEY: &str = "window_state";
/// Store 中记录桌宠（外置透明宠物窗口）几何（位置/大小）的键
pub const STORE_PET_WINDOW_STATE_KEY: &str = "pet_window_state";
/// Store 中记录「已下载、等待安装」的桌面端安装包路径的键。
/// 刻意独立于 `setting` 键：`Setting` 会被前端整对象写回，该运行期标记
/// 必须由 Rust 精确读写（见 service::update::pending）。
pub const STORE_PENDING_INSTALLER_KEY: &str = "desktop_pending_installer";

/// 健康检查超时
pub const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
