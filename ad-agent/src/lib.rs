//! NetOps AD Agent 與 Watchdog(AD-2;docs/AD-AGENT-PLAN.md §3、ARCHITECTURE D49)。
//!
//! 同一個執行檔 `netops-ad-agent.exe`,以 `--mode agent` / `--mode watchdog` 註冊成兩個 Windows 服務
//! (`NetOpsAdAgent`、`NetOpsAdWatchdog`)。與 Windows 無關的邏輯(過濾、水位、log_epoch、送出與退避、看守判斷)
//! 放在一般模組,用假的 Event Log 與假後端測試;Windows API 只在 `winlog`、`pipe`、`scm`、`service`。

pub mod agent;
pub mod bookmark;
pub mod channel;
pub mod config;
pub mod filter;
pub mod http;
pub mod logging;
pub mod outbox;
pub mod parser;
pub mod status;
pub mod watchdog;

#[cfg(windows)]
pub mod pipe;
#[cfg(windows)]
pub mod scm;
#[cfg(windows)]
pub mod service;
#[cfg(windows)]
pub mod winlog;

/// 服務名稱(安裝腳本 Install-NetOpsAdAgent.ps1 用同樣的名稱)
pub const AGENT_SERVICE: &str = "NetOpsAdAgent";
pub const WATCHDOG_SERVICE: &str = "NetOpsAdWatchdog";
/// 本機具名管道(計畫 §3.2 看守細節 1)
pub const PIPE_NAME: &str = r"\\.\pipe\netops-ad-agent-v1";
