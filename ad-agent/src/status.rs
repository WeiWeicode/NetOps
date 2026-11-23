//! Agent 狀態(採集主迴圈更新,具名管道 `get_status` 讀取;計畫 §3.2 看守細節 1、2)。
//!
//! `lastCollectTickMs` 是 Watchdog 判斷停止回應的依據:**每輪採集迴圈開頭都更新,不論後端成敗**(審查 M4)。
//! 後端斷線或回 503 時迴圈仍在退避重送、tick 照常前進,Watchdog 不會誤殺。

use crate::bookmark::Mark;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};

#[derive(Debug, Default, Clone)]
pub struct StatusData {
    pub started_at_ms: i64,
    pub last_send_ok_ms: Option<i64>,
    pub last_error: String,
    pub bookmarks: BTreeMap<&'static str, Mark>,
    /// 尚未 ACK 的筆數(重送中的那一批)
    pub pending_events: usize,
    /// 啟動後累計送出(後端接受)的筆數
    pub sent_events: u64,
}

#[derive(Debug, Default)]
pub struct SharedStatus {
    tick_ms: AtomicI64,
    data: Mutex<StatusData>,
}

pub fn iso_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| {
            t.with_timezone(&chrono::Local)
                .format("%Y-%m-%dT%H:%M:%S%.3f%:z")
                .to_string()
        })
        .unwrap_or_default()
}

impl SharedStatus {
    pub fn new(now_ms: i64) -> Self {
        let s = Self::default();
        s.tick_ms.store(now_ms, Ordering::Relaxed);
        s.update(|d| d.started_at_ms = now_ms);
        s
    }

    pub fn tick(&self, now_ms: i64) {
        self.tick_ms.store(now_ms, Ordering::Relaxed);
    }

    pub fn last_tick(&self) -> i64 {
        self.tick_ms.load(Ordering::Relaxed)
    }

    pub fn update(&self, f: impl FnOnce(&mut StatusData)) {
        // 鎖被毒化(panic = abort,實際不會發生)時仍取用資料
        let mut g = self.data.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut g);
    }

    pub fn snapshot(&self) -> StatusData {
        self.data.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 管道 `get_status` 的回應(一行 JSON)
    pub fn to_pipe_json(&self, pid: u32, version: &str) -> Value {
        let d = self.snapshot();
        json!({
            "type": "status",
            "pid": pid,
            "version": version,
            "startedAt": iso_ms(d.started_at_ms),
            "lastCollectTickMs": self.last_tick(),
            "lastSendOkAt": d.last_send_ok_ms.map(iso_ms).unwrap_or_default(),
            "lastError": d.last_error,
            "pendingEvents": d.pending_events,
            "bookmarks": d.bookmarks,
        })
    }
}

/// 管道請求的處理(純函式):只支援 `get_status`,其他一律回錯誤,不提供任何指令執行(計畫 §7 第 2 點)
pub fn handle_pipe_request(line: &str, status: &SharedStatus, pid: u32, version: &str) -> Value {
    match serde_json::from_str::<Value>(line) {
        Ok(v) if v.get("type").and_then(Value::as_str) == Some("get_status") => {
            status.to_pipe_json(pid, version)
        }
        _ => json!({ "type": "error", "message": "unsupported request" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 管道只回應get_status() {
        let s = SharedStatus::new(1_000);
        s.tick(5_000);
        s.update(|d| {
            d.last_error = "後端回應 HTTP 503".into();
            d.bookmarks.insert(
                "Security",
                Mark {
                    log_epoch: 1,
                    last_record_id: 9,
                },
            );
        });
        let r = handle_pipe_request(r#"{"type":"get_status"}"#, &s, 4120, "0.1.0");
        assert_eq!(r["type"], "status");
        assert_eq!(r["pid"], 4120);
        assert_eq!(r["lastCollectTickMs"], 5_000);
        assert_eq!(r["lastError"], "後端回應 HTTP 503");
        assert_eq!(r["bookmarks"]["Security"]["logEpoch"], 1);
        for bad in ["", "{}", r#"{"type":"run","cmd":"calc"}"#, "not json"] {
            assert_eq!(handle_pipe_request(bad, &s, 1, "0.1.0")["type"], "error");
        }
    }
}
