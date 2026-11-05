use crate::config;
use async_trait::async_trait;
use std::path::PathBuf;
use crate::AppHandle;

/// 安装任务的类型标识：下载源选择、完整性校验与版本记录都按它分支，
/// 而不是按任务在 `tasks` 向量里的位置索引（重排向量不应改变行为）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallKind {
    Dsh,
    Pnpm,
    /// 仅 Windows 构造：`Git` 安装任务按 `#[cfg(windows)]` 加入任务列表。
    #[cfg_attr(not(windows), allow(dead_code))]
    Git,
}

impl InstallKind {
    /// 对应的依赖映射键（见 `config::dependencies`）
    pub fn dependency_key(self) -> &'static str {
        match self {
            InstallKind::Dsh => config::dependencies::DEP_DSH,
            InstallKind::Pnpm => config::dependencies::DEP_PNPM,
            InstallKind::Git => config::dependencies::DEP_GIT,
        }
    }
}

#[async_trait]
pub trait Installable: Send + Sync {
    fn kind(&self) -> InstallKind;
    fn title(&self) -> &str;
    fn check_installed(&self, app: &AppHandle) -> bool;
    fn get_download_url(&self) -> Result<String, String>;
    fn get_install_path(&self, app: &AppHandle) -> PathBuf;
    /// 把该依赖当前解析出的安装根写回映射表（系统环境满足 → `null`）。
    ///
    /// 与 [`Installable::check_installed`] 同一套判定：检测到系统合规版本就不托管，
    /// 只有真正落到托管根的依赖才记录路径。
    fn record_mapping(&self, app: &AppHandle);
}

/// 依赖任务清单（唯一构造点：安装流程与映射回写共用同一组任务）。
pub fn tasks() -> Vec<Box<dyn Installable>> {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut tasks: Vec<Box<dyn Installable>> = vec![Box::new(Dsh), Box::new(Pnpm)];
    #[cfg(windows)]
    tasks.push(Box::new(Git));
    tasks
}

/// 回写全部依赖的映射（幂等；内容未变化时不落盘）。
pub fn record_mappings(app: &AppHandle) {
    for task in tasks() {
        task.record_mapping(app);
    }
}

// --- DeepSeek Harness 实现 ---
pub struct Dsh;

#[async_trait]
impl Installable for Dsh {
    fn kind(&self) -> InstallKind {
        InstallKind::Dsh
    }
    fn title(&self) -> &str {
        "Harness 核心"
    }
    fn get_download_url(&self) -> Result<String, String> {
        config::get_dsh_download_url()
    }
    fn get_install_path(&self, app: &AppHandle) -> PathBuf {
        config::get_dsh_install_path(app)
    }
    fn check_installed(&self, app: &AppHandle) -> bool {
        // 文件在盘还不够：应用自动更新会把清单的最低支持核心版本顶高，而托管目录里
        // 还是升级前的旧文件。此时判为「未安装」才能让安装流程按记录 tag 重新下载，
        // 否则启动永远停在校验失败，重试也走同一条链路（issue #1374）。
        crate::service::core::active_dsh_binary(app).is_file()
            && crate::service::core::app_core_meets_baseline(app)
    }
    fn record_mapping(&self, app: &AppHandle) {
        // 记录**当前生效的根**而不是清单托管根：随包资源构建（离线包）里用户可以把内核
        // 切到 AppData 的槽位，写回托管根会把这次切换悄悄改回随包内核。
        let active = config::dependencies::active_root(app, config::dependencies::DEP_DSH);
        if config::get_dsh_binary_path(app).is_file() {
            config::dependencies::record(app, InstallKind::Dsh.dependency_key(), Some(active));
        } else if crate::service::core::active_version(app).is_some() {
            // 只有系统（本地）核心可用：该依赖由系统环境满足。
            config::dependencies::record(app, InstallKind::Dsh.dependency_key(), None);
        }
    }
}

// --- pnpm 实现（dsh 的 plugin 命令依赖） ---
pub struct Pnpm;

#[async_trait]
impl Installable for Pnpm {
    fn kind(&self) -> InstallKind {
        InstallKind::Pnpm
    }
    fn title(&self) -> &str {
        "pnpm 包管理器"
    }
    fn get_download_url(&self) -> Result<String, String> {
        Ok(config::get_pnpm_download_url())
    }
    fn get_install_path(&self, app: &AppHandle) -> PathBuf {
        config::get_pnpm_install_path(app)
    }
    fn check_installed(&self, app: &AppHandle) -> bool {
        // "有则跳过"：用户 PATH 中已有 pnpm 时不再安装捆绑版
        if crate::service::cli::find_user_pnpm(app).is_some() {
            log::info!("Detected user-installed pnpm, skipping bundled pnpm");
            return true;
        }
        config::get_pnpm_binary_path(app).exists()
    }
    fn record_mapping(&self, app: &AppHandle) {
        let managed = config::get_pnpm_install_path(app);
        let bundled_present = config::get_pnpm_binary_path(app).exists();
        // 捆绑版优先（`dsh plugin` 需要可校验的 pnpm）：只有捆绑版缺失、且系统确有
        // 用户 pnpm 时才把该依赖记为「系统环境满足」；两者都缺失时不写，等下载后记录。
        if bundled_present {
            config::dependencies::record(app, InstallKind::Pnpm.dependency_key(), Some(managed));
        } else if crate::service::cli::find_user_pnpm(app).is_some() {
            config::dependencies::record(app, InstallKind::Pnpm.dependency_key(), None);
        }
    }
}

// --- Windows Git 实现（插件的 git 托管依赖需要） ---
#[cfg(windows)]
pub struct Git;

#[cfg(windows)]
#[async_trait]
impl Installable for Git {
    fn kind(&self) -> InstallKind {
        InstallKind::Git
    }
    fn title(&self) -> &str {
        "Git 环境"
    }

    fn get_download_url(&self) -> Result<String, String> {
        config::get_mingit_download_url()
    }

    fn get_install_path(&self, app: &AppHandle) -> PathBuf {
        config::get_mingit_install_path(app)
    }

    fn check_installed(&self, app: &AppHandle) -> bool {
        if let Some(system_git) = config::find_system_git_binary() {
            log::info!(
                "Detected usable system Git ({}), skipping bundled MinGit",
                system_git.display()
            );
            return true;
        }
        config::git_runtime_ready(app)
    }

    fn record_mapping(&self, app: &AppHandle) {
        let system = config::find_system_git_binary().is_some();
        let managed = config::get_mingit_install_path(app);
        config::dependencies::record(
            app,
            InstallKind::Git.dependency_key(),
            (!system).then_some(managed),
        );
    }
}
