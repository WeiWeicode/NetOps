//! netops-ad-agent.exe 進入點(計畫 §3.1)。
//!
//!   netops-ad-agent.exe --mode agent    --config <agent.toml>   服務 NetOpsAdAgent(由 SCM 啟動)
//!   netops-ad-agent.exe --mode watchdog --config <agent.toml>   服務 NetOpsAdWatchdog(由 SCM 啟動)
//!   netops-ad-agent.exe --mode agent    --config <agent.toml> --console   前景執行(開發 / 測試 VM 除錯,Ctrl+C 結束)
//!   netops-ad-agent.exe --check-config  --config <agent.toml>   只檢查設定與 Token 檔(安裝腳本用;不顯示 Token)
//!   netops-ad-agent.exe --version

use std::path::PathBuf;

fn usage() -> ! {
    eprintln!(
        "用法:netops-ad-agent.exe --mode <agent|watchdog> [--config <agent.toml>] [--console]\n      netops-ad-agent.exe --check-config [--config <agent.toml>]\n      netops-ad-agent.exe --version"
    );
    std::process::exit(2)
}

fn main() {
    let mut mode: Option<String> = None;
    let mut config: Option<PathBuf> = None;
    let mut console = false;
    let mut check = false;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--version" => {
                println!("{}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "--mode" => mode = args.next(),
            "--config" => config = args.next().map(PathBuf::from),
            "--console" => console = true,
            "--check-config" => check = true,
            _ => usage(),
        }
    }
    let config = config.unwrap_or_else(|| {
        PathBuf::from(netops_ad_agent::config::DEFAULT_DATA_DIR).join("agent.toml")
    });
    if check {
        match netops_ad_agent::config::Config::load(&config) {
            Ok(c) => {
                println!(
                    "OK computer={} domain={} server={} channels={} include_user_logon_4624={} include_kerberos_weak_tgs={} include_dcsync_4662={} include_gpo_change_5136={}",
                    c.computer,
                    c.domain,
                    c.server_url,
                    c.channels.len(),
                    c.include_user_logon_4624,
                    c.include_kerberos_weak_tgs,
                    c.include_dcsync_4662,
                    c.include_gpo_change_5136
                );
                return;
            }
            Err(e) => {
                eprintln!("設定錯誤:{e}");
                std::process::exit(1);
            }
        }
    }
    let Some(mode) = mode else { usage() };
    if mode != "agent" && mode != "watchdog" {
        usage();
    }
    run(&mode, config, console);
}

#[cfg(windows)]
fn run(mode: &str, config: PathBuf, console: bool) {
    let code = netops_ad_agent::service::entry(mode, config, console);
    std::process::exit(code);
}

#[cfg(not(windows))]
fn run(_mode: &str, _config: PathBuf, _console: bool) {
    eprintln!("netops-ad-agent 只能在 Windows 執行");
    std::process::exit(1);
}
