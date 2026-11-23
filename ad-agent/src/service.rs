//! Windows 服務進入點與兩種模式的主迴圈(計畫 §3.1 service.rs、watchdog.rs;AD3)。
//!
//! - `--mode agent`:採集主迴圈(每秒一輪)+ 具名管道 + 每 60 秒反向看守 Watchdog(只在 Watchdog 是自動啟動卻停止時拉起;
//!   `-Pause` 把它改成手動,維護期間不會被拉起,M5)
//! - `--mode watchdog`:每 15 秒看守 Agent(Monitor 判斷,這裡執行 SCM 動作與上報)
//! - 設定錯誤時以非 0 結束代碼停止(安裝腳本設定 failureflag,SCM 失敗復原照樣重試)

use crate::agent::{Agent, AgentSettings, VERSION};
use crate::config::Config;
use crate::http::HttpTransport;
use crate::outbox::Outbox;
use crate::status::{SharedStatus, iso_ms};
use crate::watchdog::{
    Action, Monitor, Observation, PIPE_TIMEOUT_MS, PROBE_INTERVAL_MS, StartOutcome, SvcState,
    restart_event,
};
use crate::winlog::WinEventLog;
use crate::{AGENT_SERVICE, WATCHDOG_SERVICE, logging, pipe, scm};
use serde_json::{Map, Value, json};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::{define_windows_service, service_dispatcher};

static MODE: OnceLock<(String, PathBuf)> = OnceLock::new();
const REVERSE_WATCH_MS: i64 = 60_000;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 等 ms 毫秒,期間每 200 毫秒檢查一次停止訊號
fn sleep_unless_stopped(stop: &AtomicBool, ms: u64) {
    let mut left = ms;
    while left > 0 && !stop.load(Ordering::Relaxed) {
        let d = left.min(200);
        std::thread::sleep(Duration::from_millis(d));
        left -= d;
    }
}

define_windows_service!(ffi_service_main, service_main);

pub fn entry(mode: &str, config: PathBuf, console: bool) -> i32 {
    if console {
        let stop = Arc::new(AtomicBool::new(false));
        return run_mode(mode, &config, &stop, true);
    }
    let name = if mode == "agent" {
        AGENT_SERVICE
    } else {
        WATCHDOG_SERVICE
    };
    let _ = MODE.set((mode.to_string(), config));
    match service_dispatcher::start(name, ffi_service_main) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("必須由服務控制管理員啟動(前景執行請加 --console):{e}");
            1
        }
    }
}

fn service_main(_args: Vec<OsString>) {
    let Some((mode, config)) = MODE.get().cloned() else {
        return;
    };
    let name = if mode == "agent" {
        AGENT_SERVICE
    } else {
        WATCHDOG_SERVICE
    };
    let stop = Arc::new(AtomicBool::new(false));
    let s = stop.clone();
    let handler = move |c| match c {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            s.store(true, Ordering::Relaxed);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    };
    let Ok(h) = service_control_handler::register(name, handler) else {
        return;
    };
    let status = |state, accept, exit| ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: accept,
        exit_code: exit,
        checkpoint: 0,
        wait_hint: Duration::from_secs(10),
        process_id: None,
    };
    let _ = h.set_service_status(status(
        ServiceState::Running,
        ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        ServiceExitCode::Win32(0),
    ));
    let code = run_mode(&mode, &config, &stop, false);
    let exit = if code == 0 {
        ServiceExitCode::Win32(0)
    } else {
        ServiceExitCode::ServiceSpecific(code as u32)
    };
    let _ = h.set_service_status(status(
        ServiceState::Stopped,
        ServiceControlAccept::empty(),
        exit,
    ));
}

fn run_mode(mode: &str, config: &std::path::Path, stop: &Arc<AtomicBool>, console: bool) -> i32 {
    let cfg = match Config::load(config) {
        Ok(c) => c,
        Err(e) => {
            // 設定讀不到時寫到預設日誌目錄(不含 Token)
            logging::init(
                &PathBuf::from(crate::config::DEFAULT_DATA_DIR).join("logs"),
                mode,
                console,
                "",
            );
            log::error!("設定錯誤,無法啟動:{e}");
            return 1;
        }
    };
    logging::init(&cfg.log_dir, mode, console, &cfg.token);
    if let Err(e) = std::fs::create_dir_all(&cfg.state_dir) {
        log::error!("無法建立 {}:{e}", cfg.state_dir.display());
        return 1;
    }
    log::info!(
        "netops-ad-agent {VERSION} 啟動(模式 {mode},computer {},server {})",
        cfg.computer,
        cfg.server_url
    );
    let code = if mode == "agent" {
        run_agent(&cfg, stop)
    } else {
        run_watchdog(&cfg, stop)
    };
    log::info!("netops-ad-agent 結束(模式 {mode})");
    log::logger().flush();
    code
}

fn svc_json(name: &str) -> Value {
    match scm::query(name) {
        Ok(i) => json!({ "serviceState": i.state.as_str(), "startType": i.start_type.as_str() }),
        Err(_) => json!({ "serviceState": "unknown" }),
    }
}

fn run_agent(cfg: &Config, stop: &Arc<AtomicBool>) -> i32 {
    let status = Arc::new(SharedStatus::new(now_ms()));
    pipe::spawn_server(status.clone(), VERSION);
    let sysinfo = Box::new(|| {
        let mut m = Map::new();
        m.insert("watchdogVersion".into(), json!(VERSION));
        m.insert("watchdog".into(), svc_json(WATCHDOG_SERVICE));
        m.insert(
            "agent".into(),
            json!({ "rssMb": scm::rss_mb(), "startType": svc_json(AGENT_SERVICE)["startType"] }),
        );
        m
    });
    let mut agent = match Agent::new(
        AgentSettings::from_config(cfg),
        WinEventLog::new(),
        HttpTransport::new(&cfg.server_url, &cfg.token),
        status,
        now_ms(),
    ) {
        Ok(a) => a.with_sysinfo(sysinfo),
        Err(e) => {
            log::error!("{e}");
            return 1;
        }
    };
    let mut next_reverse = now_ms() + REVERSE_WATCH_MS;
    while !stop.load(Ordering::Relaxed) {
        let now = now_ms();
        agent.step(now);
        if now >= next_reverse {
            next_reverse = now + REVERSE_WATCH_MS;
            reverse_watch();
        }
        sleep_unless_stopped(stop, 1_000);
    }
    0
}

/// Agent 反向看守 Watchdog:自動啟動卻停止(當掉超過 SCM 復原次數等)時拉起;手動 / 停用(-Pause)不動
fn reverse_watch() {
    if scm::system_shutting_down() {
        return;
    }
    match scm::query(WATCHDOG_SERVICE) {
        Ok(i)
            if i.state == SvcState::Stopped && i.start_type == crate::watchdog::StartType::Auto =>
        {
            let r = scm::start(WATCHDOG_SERVICE);
            log::warn!("Watchdog 服務停止中(自動啟動),已嘗試啟動:{r:?}");
        }
        Ok(_) => {}
        Err(e) => log::warn!("{e}"),
    }
}

fn run_watchdog(cfg: &Config, stop: &Arc<AtomicBool>) -> i32 {
    use crate::agent::{HttpResult, Transport};
    let mut transport = HttpTransport::new(&cfg.server_url, &cfg.token);
    let mut outbox = Outbox::load(&cfg.state_dir);
    let mut monitor = Monitor::new(now_ms());
    let push = |outbox: &mut Outbox, ev: Value| {
        log::warn!("看守事件:{ev}");
        if let Err(e) = outbox.push(ev) {
            log::error!("{e}");
        }
    };
    while !stop.load(Ordering::Relaxed) {
        let now = now_ms();
        if scm::system_shutting_down() {
            sleep_unless_stopped(stop, PROBE_INTERVAL_MS as u64);
            continue;
        }
        let info = match scm::query(AGENT_SERVICE) {
            Ok(i) => i,
            Err(e) => {
                log::warn!("{e}");
                sleep_unless_stopped(stop, PROBE_INTERVAL_MS as u64);
                continue;
            }
        };
        let probe = match (info.state, info.pid) {
            (SvcState::Running, Some(pid)) => Some(pipe::request_status(
                pid,
                Duration::from_millis(PIPE_TIMEOUT_MS),
            )),
            _ => None,
        };
        if let Some(Err(e)) = &probe {
            log::warn!("Agent 狀態查詢失敗:{e}");
        }
        let obs = Observation {
            state: info.state,
            start_type: info.start_type,
            pid: info.pid,
            probe: probe.clone(),
        };
        let at = iso_ms(now);
        let mut acted = false;
        match monitor.decide(&obs, now) {
            Action::None => {}
            Action::Recover { set_auto, start } => {
                acted = true;
                if set_auto && let Err(e) = scm::set_auto_start(AGENT_SERVICE) {
                    log::error!("{e}");
                }
                if start {
                    let outcome = scm::start(AGENT_SERVICE);
                    let pid = if outcome.ok() {
                        scm::wait_running_pid(AGENT_SERVICE, None, Duration::from_secs(15))
                    } else {
                        None
                    };
                    let detail = format!(
                        "服務狀態 {}、啟動類型 {}",
                        info.state.as_str(),
                        info.start_type.as_str()
                    );
                    push(
                        &mut outbox,
                        restart_event("stopped", &detail, None, pid, &outcome, &at),
                    );
                    if monitor.record_restart(now, &outcome) {
                        push(
                            &mut outbox,
                            json!({ "type": "agent_start_failed", "source": "watchdog", "cause": "restart_storm", "cooldownMinutes": 10, "at": at }),
                        );
                    }
                } else {
                    push(
                        &mut outbox,
                        json!({ "type": "agent_service_stopped", "source": "watchdog", "cause": "start_type_changed", "startType": info.start_type.as_str(), "at": at }),
                    );
                }
            }
            Action::KillHung { pid, reason } => {
                acted = true;
                log::warn!("Agent 停止回應({reason}),結束行程 {pid} 後重啟");
                let outcome = match scm::terminate_service_process(AGENT_SERVICE, pid) {
                    Ok(()) => scm::start(AGENT_SERVICE),
                    Err(e) => StartOutcome::Failed(e),
                };
                let new_pid = if outcome.ok() {
                    scm::wait_running_pid(AGENT_SERVICE, Some(pid), Duration::from_secs(20))
                } else {
                    None
                };
                push(
                    &mut outbox,
                    restart_event("hung", &reason, Some(pid), new_pid, &outcome, &at),
                );
                if monitor.record_restart(now, &outcome) {
                    push(
                        &mut outbox,
                        json!({ "type": "agent_start_failed", "source": "watchdog", "cause": "restart_storm", "cooldownMinutes": 10, "at": at }),
                    );
                }
            }
        }
        let cooldown = monitor.in_cooldown(now);
        let agent_ok = !acted && !cooldown && matches!(probe, Some(Ok(_)));
        // Agent 正常時由 Agent 自己送心跳;Watchdog 只在有事件要報或 Agent 不正常時送(不蓋掉 Agent 的心跳內容)
        if !outbox.pending().is_empty()
            || (cooldown || (info.state != SvcState::Running && info.state != SvcState::Missing))
        {
            let n = outbox.pending().len().min(20);
            let body = json!({
                "computer": cfg.computer,
                "domain": cfg.domain,
                "reportedAt": at,
                "agentVersion": VERSION,
                "watchdogVersion": VERSION,
                "source": "watchdog",
                "agent": {
                    "pid": info.pid,
                    "serviceState": info.state.as_str(),
                    "startType": info.start_type.as_str(),
                    "statusOk": agent_ok,
                    "lastCollectTickAt": match &probe { Some(Ok(p)) => iso_ms(p.last_collect_tick_ms), _ => String::new() },
                    "restarts24h": monitor.recent_restarts(),
                    "cooldown": cooldown,
                },
                "watchdogEvents": &outbox.pending()[..n],
            });
            match transport.post("/ad/v1/heartbeat", &body) {
                HttpResult::Status { code: 200, .. } => {
                    if let Err(e) = outbox.ack(n) {
                        log::error!("{e}");
                    }
                }
                HttpResult::Status { code, .. } => log::warn!("Watchdog 上報失敗:HTTP {code}"),
                HttpResult::Failed(e) => log::warn!("Watchdog 上報失敗:{e}"),
            }
        }
        sleep_unless_stopped(stop, PROBE_INTERVAL_MS as u64);
    }
    0
}
