//! Watchdog 看守判斷(計畫 §3.2 看守細節 2–4;AD3 防護 2、3;審查 M4)。純邏輯,不呼叫 Windows API。
//!
//! 每 15 秒一次 [`Monitor::decide`]:
//! - Agent 服務停止 / 被改成非自動啟動 → 改回自動並啟動,上報 `agent_service_stopped`
//! - 管道 `get_status` 連續失敗 3 次(約 45 秒),或回傳的 `lastCollectTickMs` 停滯 > 90 秒 → 強制結束 + 重啟,上報 `agent_restarted`(cause `hung`)
//! - 後端 503 / 斷線不影響 tick(Agent 每輪都更新),所以不會被誤殺
//! - 新行程啟動後 60 秒內管道失敗不計(管道還沒建好)
//! - 10 分鐘內強制重啟達 5 次 → 冷卻 10 分鐘(不再重啟,只上報 `agent_start_failed`),防重啟風暴
//! - `StartService` 回 `ERROR_SERVICE_ALREADY_RUNNING`(SCM 失敗復原先拉起)視為成功,不算啟動失敗

use serde_json::{Value, json};
use std::collections::VecDeque;

pub const PROBE_INTERVAL_MS: i64 = 15_000;
pub const PIPE_TIMEOUT_MS: u64 = 5_000;
pub const STALE_MS: i64 = 90_000;
pub const PIPE_FAIL_LIMIT: u32 = 3;
pub const GRACE_MS: i64 = 60_000;
pub const STORM_WINDOW_MS: i64 = 10 * 60_000;
pub const STORM_LIMIT: usize = 5;
pub const COOLDOWN_MS: i64 = 10 * 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SvcState {
    Running,
    Stopped,
    StartPending,
    StopPending,
    Paused,
    Missing,
}

impl SvcState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopped => "stopped",
            Self::StartPending => "start_pending",
            Self::StopPending => "stop_pending",
            Self::Paused => "paused",
            Self::Missing => "missing",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartType {
    Auto,
    Manual,
    Disabled,
    Other,
}

impl StartType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Manual => "manual",
            Self::Disabled => "disabled",
            Self::Other => "other",
        }
    }
}

/// 管道 `get_status` 回應中看守需要的部分
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Probe {
    pub pid: u32,
    pub last_collect_tick_ms: i64,
    /// Agent 以單調時鐘算的「距上次 tick 毫秒數」;有就用它判斷停滯(不受校時影響,審查 M3)
    pub tick_age_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    pub state: SvcState,
    pub start_type: StartType,
    pub pid: Option<u32>,
    /// 只有執行中才探測
    pub probe: Option<Result<Probe, String>>,
}

impl Observation {
    pub fn running(pid: u32, probe: Result<Probe, String>) -> Self {
        Self {
            state: SvcState::Running,
            start_type: StartType::Auto,
            pid: Some(pid),
            probe: Some(probe),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    None,
    /// 服務被停 / 改啟動類型:改回自動(set_auto)並啟動(start)
    Recover {
        set_auto: bool,
        start: bool,
    },
    /// 停止回應:結束行程後重啟
    KillHung {
        pid: u32,
        reason: String,
    },
}

/// StartService 的結果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartOutcome {
    Started,
    /// ERROR_SERVICE_ALREADY_RUNNING(1056):SCM 失敗復原已先拉起 → 視為成功(M4)
    AlreadyRunning,
    Failed(String),
}

impl StartOutcome {
    pub fn ok(&self) -> bool {
        !matches!(self, Self::Failed(_))
    }
}

#[derive(Debug)]
pub struct Monitor {
    fails: u32,
    grace_until: i64,
    last_pid: Option<u32>,
    restarts: VecDeque<i64>,
    cooldown_until: Option<i64>,
    /// 啟動失敗次數(ALREADY_RUNNING 不算)
    pub start_failures: u32,
}

impl Monitor {
    /// Watchdog 剛啟動:給 Agent 60 秒建立管道(開機時兩個服務同時啟動)
    pub fn new(now_ms: i64) -> Self {
        Self {
            fails: 0,
            grace_until: now_ms + GRACE_MS,
            last_pid: None,
            restarts: VecDeque::new(),
            cooldown_until: None,
            start_failures: 0,
        }
    }

    pub fn in_cooldown(&mut self, now_ms: i64) -> bool {
        match self.cooldown_until {
            Some(t) if now_ms < t => true,
            Some(_) => {
                self.cooldown_until = None;
                false
            }
            None => false,
        }
    }

    pub fn decide(&mut self, obs: &Observation, now_ms: i64) -> Action {
        if self.in_cooldown(now_ms) {
            return Action::None;
        }
        let set_auto = obs.start_type != StartType::Auto;
        match obs.state {
            SvcState::Missing | SvcState::StartPending | SvcState::StopPending => Action::None,
            SvcState::Stopped | SvcState::Paused => Action::Recover {
                set_auto,
                start: true,
            },
            SvcState::Running => {
                if set_auto {
                    return Action::Recover {
                        set_auto: true,
                        start: false,
                    };
                }
                if obs.pid != self.last_pid {
                    // 換了新行程(SCM 失敗復原拉起或手動重啟):重新計算,並給新行程建立管道的寬限
                    if self.last_pid.is_some() {
                        self.grace_until = self.grace_until.max(now_ms + GRACE_MS);
                    }
                    self.last_pid = obs.pid;
                    self.fails = 0;
                }
                let Some(pid) = obs.pid else {
                    return Action::None;
                };
                match &obs.probe {
                    Some(Ok(p)) => {
                        self.fails = 0;
                        let idle = p
                            .tick_age_ms
                            .unwrap_or(now_ms - p.last_collect_tick_ms);
                        if idle > STALE_MS {
                            Action::KillHung {
                                pid,
                                reason: format!("採集迴圈停滯 {} 秒", idle / 1000),
                            }
                        } else {
                            Action::None
                        }
                    }
                    Some(Err(e)) => {
                        if now_ms < self.grace_until {
                            return Action::None;
                        }
                        self.fails += 1;
                        if self.fails >= PIPE_FAIL_LIMIT {
                            Action::KillHung {
                                pid,
                                reason: format!("管道連續 {} 次無回應:{e}", self.fails),
                            }
                        } else {
                            Action::None
                        }
                    }
                    None => Action::None,
                }
            }
        }
    }

    /// 執行重啟後記錄;回傳 true = 進入冷卻(10 分鐘內第 5 次)
    pub fn record_restart(&mut self, now_ms: i64, outcome: &StartOutcome) -> bool {
        if !outcome.ok() {
            self.start_failures += 1;
        }
        self.fails = 0;
        self.grace_until = now_ms + GRACE_MS;
        self.restarts.push_back(now_ms);
        while self
            .restarts
            .front()
            .is_some_and(|t| now_ms - t >= STORM_WINDOW_MS)
        {
            self.restarts.pop_front();
        }
        if self.restarts.len() >= STORM_LIMIT {
            self.restarts.clear();
            self.cooldown_until = Some(now_ms + COOLDOWN_MS);
            return true;
        }
        false
    }

    /// 24 小時內的重啟次數(心跳 restarts24h 只算目前視窗內的,近似值)
    pub fn recent_restarts(&self) -> usize {
        self.restarts.len()
    }
}

/// 重啟後要上報的事件(watchdogEvents 一筆)
pub fn restart_event(
    cause: &str,
    detail: &str,
    previous_pid: Option<u32>,
    new_pid: Option<u32>,
    outcome: &StartOutcome,
    at: &str,
) -> Value {
    let (kind, err) = match outcome {
        StartOutcome::Failed(e) => ("agent_start_failed", e.as_str()),
        _ => (
            if cause == "hung" {
                "agent_restarted"
            } else {
                "agent_service_stopped"
            },
            "",
        ),
    };
    json!({
        "type": kind,
        "source": "watchdog",
        "cause": cause,
        "detail": detail.chars().take(300).collect::<String>(),
        "previousPid": previous_pid,
        "pid": new_pid,
        "alreadyRunning": matches!(outcome, StartOutcome::AlreadyRunning),
        "error": err.chars().take(300).collect::<String>(),
        "at": at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 1_000_000_000;

    fn ok(pid: u32, tick: i64) -> Observation {
        Observation::running(
            pid,
            Ok(Probe {
                pid,
                last_collect_tick_ms: tick,
                tick_age_ms: None,
            }),
        )
    }

    fn fail(pid: u32) -> Observation {
        Observation::running(pid, Err("本機管道逾時".into()))
    }

    #[test]
    fn tick停滯超過90秒才判定hung() {
        let mut m = Monitor::new(T);
        assert_eq!(m.decide(&ok(10, T), T), Action::None);
        assert_eq!(
            m.decide(&ok(10, T), T + STALE_MS),
            Action::None,
            "剛好 90 秒不算"
        );
        match m.decide(&ok(10, T), T + STALE_MS + 1) {
            Action::KillHung { pid: 10, reason } => assert!(reason.contains("停滯")),
            a => panic!("{a:?}"),
        }
    }

    #[test]
    fn 管道連續3次逾時才判定hung_成功一次就歸零() {
        let mut m = Monitor::new(T - GRACE_MS);
        assert_eq!(m.decide(&fail(10), T), Action::None);
        assert_eq!(m.decide(&fail(10), T + 15_000), Action::None);
        assert_eq!(
            m.decide(&ok(10, T + 30_000), T + 30_000),
            Action::None,
            "成功一次歸零"
        );
        assert_eq!(m.decide(&fail(10), T + 45_000), Action::None);
        assert_eq!(m.decide(&fail(10), T + 60_000), Action::None);
        assert!(matches!(
            m.decide(&fail(10), T + 75_000),
            Action::KillHung { pid: 10, .. }
        ));
    }

    #[test]
    fn 啟動寬限60秒內管道失敗不計() {
        let mut m = Monitor::new(T);
        for k in 0..4 {
            assert_eq!(m.decide(&fail(10), T + k * 15_000), Action::None);
        }
        assert_eq!(m.decide(&fail(10), T + GRACE_MS), Action::None);
        assert_eq!(m.decide(&fail(10), T + GRACE_MS + 15_000), Action::None);
        assert!(matches!(
            m.decide(&fail(10), T + GRACE_MS + 30_000),
            Action::KillHung { .. }
        ));
    }

    #[test]
    fn 後端503時tick照常更新不誤殺() {
        // Agent 送不出去(lastError = 503)但採集迴圈仍每秒更新 tick
        let mut m = Monitor::new(T);
        for k in 0..100 {
            let now = T + k * PROBE_INTERVAL_MS;
            assert_eq!(m.decide(&ok(10, now - 1_000), now), Action::None);
        }
    }

    #[test]
    fn 服務被停止或改啟動類型時恢復() {
        let mut m = Monitor::new(T);
        let stopped = Observation {
            state: SvcState::Stopped,
            start_type: StartType::Auto,
            pid: None,
            probe: None,
        };
        assert_eq!(
            m.decide(&stopped, T),
            Action::Recover {
                set_auto: false,
                start: true
            }
        );
        let disabled = Observation {
            state: SvcState::Stopped,
            start_type: StartType::Disabled,
            pid: None,
            probe: None,
        };
        assert_eq!(
            m.decide(&disabled, T),
            Action::Recover {
                set_auto: true,
                start: true
            }
        );
        let manual_running = Observation {
            start_type: StartType::Manual,
            ..ok(10, T)
        };
        assert_eq!(
            m.decide(&manual_running, T),
            Action::Recover {
                set_auto: true,
                start: false
            }
        );
        let pending = Observation {
            state: SvcState::StartPending,
            start_type: StartType::Auto,
            pid: Some(10),
            probe: None,
        };
        assert_eq!(m.decide(&pending, T), Action::None);
        let missing = Observation {
            state: SvcState::Missing,
            start_type: StartType::Other,
            pid: None,
            probe: None,
        };
        assert_eq!(m.decide(&missing, T), Action::None);
    }

    #[test]
    fn 十分鐘內第5次重啟進入冷卻_冷卻結束後恢復看守() {
        let mut m = Monitor::new(T);
        for k in 0..4 {
            assert!(!m.record_restart(T + k * 60_000, &StartOutcome::Started));
        }
        assert!(m.record_restart(T + 4 * 60_000, &StartOutcome::Started));
        let now = T + 5 * 60_000;
        assert!(m.in_cooldown(now));
        assert_eq!(m.decide(&ok(10, 0), now), Action::None, "冷卻期間不重啟");
        let stopped = Observation {
            state: SvcState::Stopped,
            start_type: StartType::Auto,
            pid: None,
            probe: None,
        };
        assert_eq!(
            m.decide(&stopped, T + 4 * 60_000 + COOLDOWN_MS - 1),
            Action::None
        );
        assert_eq!(
            m.decide(&stopped, T + 4 * 60_000 + COOLDOWN_MS),
            Action::Recover {
                set_auto: false,
                start: true
            }
        );
    }

    #[test]
    fn 間隔超過10分鐘的重啟不累計() {
        let mut m = Monitor::new(T);
        for k in 0..10 {
            assert!(!m.record_restart(T + k * 3 * 60_000, &StartOutcome::Started));
        }
    }

    #[test]
    fn error_service_already_running視為成功() {
        let mut m = Monitor::new(T);
        assert!(StartOutcome::AlreadyRunning.ok());
        m.record_restart(T, &StartOutcome::AlreadyRunning);
        assert_eq!(m.start_failures, 0, "不計入啟動失敗");
        let e = restart_event(
            "hung",
            "管道無回應",
            Some(10),
            Some(11),
            &StartOutcome::AlreadyRunning,
            "x",
        );
        assert_eq!(e["type"], "agent_restarted");
        assert_eq!(e["cause"], "hung");
        assert_eq!(e["pid"], 11);
        assert_eq!(e["alreadyRunning"], true);
        m.record_restart(T, &StartOutcome::Failed("拒絕存取".into()));
        assert_eq!(m.start_failures, 1);
        let e = restart_event(
            "hung",
            "",
            Some(10),
            None,
            &StartOutcome::Failed("拒絕存取".into()),
            "x",
        );
        assert_eq!(e["type"], "agent_start_failed");
    }

    #[test]
    fn 新pid重新計算失敗次數() {
        let mut m = Monitor::new(T - GRACE_MS);
        m.decide(&fail(10), T);
        m.decide(&fail(10), T + 15_000);
        // SCM 失敗復原拉起新行程:失敗次數歸零,寬限 60 秒後再連續 3 次才判定
        let t = T + 30_000;
        for k in 0..=4 {
            assert_eq!(m.decide(&fail(11), t + k * 15_000), Action::None);
        }
        assert_eq!(m.decide(&fail(11), t + 75_000), Action::None);
        assert!(matches!(
            m.decide(&fail(11), t + 90_000),
            Action::KillHung { pid: 11, .. }
        ));
    }

    #[test]
    fn 有單調時鐘tick_age時以它判斷_系統時間跳動不誤殺() {
        let mut m = Monitor::new(T);
        let probe = |age: Option<i64>| {
            Observation::running(
                7,
                Ok(Probe {
                    pid: 7,
                    // 壁鐘看起來停滯 2 小時(校時往前跳)
                    last_collect_tick_ms: T - 7_200_000,
                    tick_age_ms: age,
                }),
            )
        };
        assert_eq!(m.decide(&probe(Some(1_000)), T), Action::None);
        assert!(matches!(
            m.decide(&probe(Some(STALE_MS + 1)), T + 15_000),
            Action::KillHung { pid: 7, .. }
        ));
        // 舊版 Agent 沒有 tickAgeMs:沿用壁鐘
        let mut m = Monitor::new(T);
        assert!(matches!(
            m.decide(&probe(None), T),
            Action::KillHung { .. }
        ));
    }
}
