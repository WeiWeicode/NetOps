//! Watchdog 待上報事件 state\watchdog-events.json(計畫 §3.2 看守細節 3)。只有 Watchdog 讀寫。
//! 上報成功(心跳 200)才移除;最多保留 [`MAX_EVENTS`] 筆(超過丟最舊的)。

use serde_json::Value;
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "watchdog-events.json";
pub const MAX_EVENTS: usize = 50;

#[derive(Debug, Default)]
pub struct Outbox {
    path: PathBuf,
    events: Vec<Value>,
}

impl Outbox {
    /// 讀檔;檔案壞掉時從空的開始(事件只是告警輔助,不影響採集)
    pub fn load(state_dir: &Path) -> Self {
        let path = state_dir.join(FILE_NAME);
        let events = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok())
            .unwrap_or_default();
        Self { path, events }
    }

    pub fn push(&mut self, ev: Value) -> Result<(), String> {
        self.events.push(ev);
        if self.events.len() > MAX_EVENTS {
            let extra = self.events.len() - MAX_EVENTS;
            self.events.drain(..extra);
        }
        self.save()
    }

    pub fn pending(&self) -> &[Value] {
        &self.events
    }

    /// 前 n 筆已上報
    pub fn ack(&mut self, n: usize) -> Result<(), String> {
        let n = n.min(self.events.len());
        if n == 0 {
            return Ok(());
        }
        self.events.drain(..n);
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        let text = serde_json::to_vec_pretty(&self.events).map_err(|e| e.to_string())?;
        crate::bookmark::write_atomic(&self.path, &text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 事件寫檔_上報後移除_最多50筆() {
        let d = tempfile::tempdir().unwrap();
        let mut o = Outbox::load(d.path());
        for i in 0..60 {
            o.push(json!({ "type": "agent_restarted", "i": i }))
                .unwrap();
        }
        let o2 = Outbox::load(d.path());
        assert_eq!(o2.pending().len(), MAX_EVENTS);
        assert_eq!(o2.pending()[0]["i"], 10);
        o.ack(49).unwrap();
        assert_eq!(
            Outbox::load(d.path()).pending(),
            &[json!({ "type": "agent_restarted", "i": 59 })]
        );
        std::fs::write(d.path().join(FILE_NAME), "oops").unwrap();
        assert!(Outbox::load(d.path()).pending().is_empty());
    }
}
