use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Runtime, WebviewWindow};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub title: String,
    pub detail: String,
    pub log: String,
    pub r#type: String,
    pub percentage: f64,
    // 子任务进度
    pub progress: f64,
}

pub struct ProgressTracker<'a, R: Runtime> {
    pub(super) window: &'a WebviewWindow<R>,
    total_phases: usize,
    current_phase: usize,
    current_title: String,
    current_type: String,
    last_emit_time: Mutex<Option<Instant>>,
}

impl<'a, R: Runtime> ProgressTracker<'a, R> {
    pub fn new(window: &'a WebviewWindow<R>, task_count: usize) -> Self {
        Self {
            window,
            total_phases: task_count,
            current_phase: 0,
            current_title: String::from("准备中..."),
            current_type: String::from(""),
            last_emit_time: Mutex::new(None),
        }
    }

    /// 切换阶段，并设置大标题
    pub fn start_phase(&mut self, r#type: &str, title: &str) {
        self.current_title = title.to_string();
        self.current_type = r#type.to_string();
    }

    /// 完成一个阶段
    pub fn end_phase(&mut self) {
        if self.current_phase < self.total_phases {
            self.current_phase += 1;
        }
    }

    /// stage_pct: 当前子任务的进度 (0.0 - 100.0)
    /// detail: 用于显示的主要信息 (如 "已下载 xx MB / xx MB" 或 "已解压 30%")
    /// log: 用于在 log 窗口显示的文字 (如 "Download http://..." 或 "Extract xx/xx/xx")
    pub fn update(&self, stage_pct: f64, detail: String, log: String) {
        let now = Instant::now();
        // 中毒安全：若 install 过程中已有 panic 污染该锁，后续不应再次 panic
        // 导致整个桌面进程退出，这里忽略中毒状态继续读取旧值。
        let mut last_emit = self
            .last_emit_time
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        // 节流处理：如果距离上次发送不足 50ms，则跳过
        if let Some(last_time) = *last_emit {
            if now.duration_since(last_time) < Duration::from_millis(50) {
                return;
            }
        }

        *last_emit = Some(now);

        let global_pct = global_percentage(self.current_phase, self.total_phases, stage_pct);

        let _ = self.window.emit(
            "install-progress",
            ProgressPayload {
                title: self.current_title.clone(),
                r#type: self.current_type.clone(),
                percentage: global_pct,
                progress: stage_pct,
                detail,
                log,
            },
        );
    }

    /// 跳过指定数量的阶段
    pub fn skip_phases(&mut self, count: usize) {
        self.current_phase = (self.current_phase + count).min(self.total_phases);
    }
}

/// 计算全局安装进度百分比 (0.0 - 100.0)，并永远以 100.0 封顶。
///
/// 阶段权重均匀分摊：`current_phase` 个已完成阶段各占 `100/total_phases`，
/// 当前阶段的 `stage_pct`（0-100）再折算进最后一个权重区间。
///
/// 末尾调用方（如 `install.rs` 在全部任务结束后再补一次
/// `update(100.0, "依赖已安装完毕", "All tasks completed")`）会携带已经等于
/// `total_phases` 的 `current_phase`；若此刻再把 `stage_pct` 折算进权重，
/// 会在已完成阶段之外多算一份权重（macOS 6 阶段时得到 `6×(100/6) + 100×(100/6)/100
/// = 116.7 ≈ 117%`，正是 issue #283 首页「第一次安装卡住」误显示 117% 的根因）。
/// 因此这里一律把结果钳制到 100.0，避免进度条数值越过 100%。
fn global_percentage(current_phase: usize, total_phases: usize, stage_pct: f64) -> f64 {
    if total_phases == 0 {
        return 100.0;
    }
    let phase_weight = 100.0 / total_phases as f64;
    let global = (current_phase as f64 * phase_weight) + (stage_pct * phase_weight / 100.0);
    global.clamp(0.0, 100.0)
}

#[cfg(test)]
mod tests {
    use super::global_percentage;

    #[test]
    fn clamps_to_100_when_all_phases_done_plus_final_update() {
        // issue #283：macOS 首装 3 任务 × 2 阶段 = 6 阶段，全部结束后再补一次
        // update(100.0)。修复前得到 116.7%，界面误显示 117%。
        let pct = global_percentage(6, 6, 100.0);
        assert_eq!(pct, 100.0);
    }

    #[test]
    fn stays_below_100_mid_phase() {
        // 当前处于第 0 阶段（download 开始），stage 进度 50% → 6 阶段下应约 8.33%
        let pct = global_percentage(0, 6, 50.0);
        assert!((pct - 8.3333).abs() < 1e-3);
        assert!(pct < 100.0);
    }

    #[test]
    fn reaches_100_exactly_at_last_phase_end() {
        // 最后一个阶段（第 5 个，index 5）完成到 100% → 恰为 100%
        let pct = global_percentage(5, 6, 100.0);
        assert_eq!(pct, 100.0);
    }

    #[test]
    fn total_phases_one_and_mid() {
        // 单阶段（total=1）：阶段完成即 100，无越界
        let done = global_percentage(1, 1, 100.0);
        assert_eq!(done, 100.0);
        let half = global_percentage(0, 1, 50.0);
        assert_eq!(half, 50.0);
    }

    #[test]
    fn never_exceeds_100_regardless_of_input() {
        // 防御性：任何输入组合都不应越过 100
        for current in 0..=10 {
            for stage in [0.0, 25.0, 50.0, 75.0, 100.0, 200.0] {
                let pct = global_percentage(current, 6, stage);
                assert!(pct <= 100.0, "pct={pct} current={current} stage={stage}");
            }
        }
    }

    #[test]
    fn degenerate_zero_total_is_safe() {
        assert_eq!(global_percentage(0, 0, 100.0), 100.0);
    }
}
