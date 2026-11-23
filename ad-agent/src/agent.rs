//! Agent 採集主迴圈(計畫 §3.2 Running 狀態、§3.3;AD6)。不依賴 Windows API:Event Log 與 HTTP 都經 trait,測試用假的。
//!
//! 每輪([`Agent::step`],約每秒一次):
//! 1. 更新 `lastCollectTickMs`(**不論後端成敗**,M4)
//! 2. 心跳到期 → `POST /ad/v1/heartbeat`(含 Security Log 容量與 `wrapRisk`);回應的 `channels` 用來接續遺失的水位
//! 3. 有未 ACK 的一批 → 退避時間到才重送**同一批**,不加入新事件(M2);沒有 → 每 3–5 秒讀一次各 Channel 水位之後的事件
//! 4. 收到 200 才移動水位並寫 bookmarks.json

use crate::bookmark::{Bookmarks, Mark, ResetInfo, ServerMark, resolve_initial};
use crate::channel::Channel;
use crate::filter::EventFilter;
use crate::parser::parse_event_xml;
use crate::status::{SharedStatus, iso_ms};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// 接收端 message 上限 3,000 字(payload.ts MAX_MESSAGE);Agent 先截斷,少送資料
pub const MAX_MESSAGE_CHARS: usize = 3000;
/// 一批的 JSON 大小上限(接收端 4 MB;留餘裕)
pub const MAX_BATCH_BYTES: usize = 3 * 1024 * 1024;
/// 心跳一次最多附幾筆 Agent 警告(接收端 watchdogEvents 上限 50)
const MAX_NOTICES_PER_HEARTBEAT: usize = 20;
const MAX_PENDING_NOTICES: usize = 50;
/// Security Log 涵蓋時數低於這個值就標記 wrapRisk(計畫 §3.3 第 2 點)
pub const WRAP_RISK_HOURS: f64 = 24.0;

/// Event Log 的 Channel 資訊
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LogInfo {
    /// 目前最大的 RecordID(沒有事件時 0)
    pub newest_record_id: u64,
    pub file_size: u64,
    pub max_size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawEvent {
    pub xml: String,
    pub message: String,
}

pub trait EventSource {
    /// None = 這台 DC 沒有這個 Channel(例:沒裝 DNS 角色,AD5 自動略過)
    fn log_info(&mut self, c: Channel) -> Result<Option<LogInfo>, String>;
    /// RecordID > after 的事件,由小到大,最多 max 筆
    fn read_after(&mut self, c: Channel, after: u64, max: usize) -> Result<Vec<RawEvent>, String>;
    /// since_ms 之後第一筆事件的 RecordID(首次啟動往回讀,M8)
    fn first_record_since(&mut self, c: Channel, since_ms: i64) -> Result<Option<u64>, String>;
    /// 最舊一筆事件的時間(Security 涵蓋時數)
    fn oldest_event_ms(&mut self, c: Channel) -> Result<Option<i64>, String>;
}

#[derive(Debug, Clone, PartialEq)]
pub enum HttpResult {
    Status {
        code: u16,
        body: Option<Value>,
        retry_after_sec: Option<u64>,
    },
    /// 連線失敗、逾時等
    Failed(String),
}

pub trait Transport {
    fn post(&mut self, path: &str, body: &Value) -> HttpResult;
}

/// 失敗後的退避:2、4、8、16、32、60 秒(上限),429 依 Retry-After(最多 300 秒)
#[derive(Debug, Default, Clone)]
pub struct Backoff {
    attempts: u32,
    next_at_ms: i64,
}

impl Backoff {
    pub fn ready(&self, now_ms: i64) -> bool {
        now_ms >= self.next_at_ms
    }

    pub fn fail(&mut self, now_ms: i64, retry_after_sec: Option<u64>) -> i64 {
        self.attempts = self.attempts.saturating_add(1);
        let base = 2_000i64
            .saturating_mul(1 << self.attempts.min(6).saturating_sub(1))
            .min(60_000);
        // 錯開多台 DC 同時重送(0–20%)
        let jitter = (now_ms.rem_euclid(1000) * base) / 5_000;
        let delay = match retry_after_sec {
            Some(s) => (s.min(300) as i64 * 1000).max(base),
            None => base + jitter,
        };
        self.next_at_ms = now_ms + delay;
        delay
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// Security Log 涵蓋時數與 wrapRisk(計畫 §3.3 第 2 點)
pub fn coverage(now_ms: i64, oldest_ms: i64) -> (f64, bool) {
    let hours = ((now_ms - oldest_ms).max(0) as f64) / 3_600_000.0;
    ((hours * 10.0).round() / 10.0, hours < WRAP_RISK_HOURS)
}

#[derive(Debug, Clone)]
pub struct AgentSettings {
    pub computer: String,
    pub domain: String,
    pub channels: Vec<Channel>,
    pub state_dir: PathBuf,
    pub initial_lookback_minutes: u32,
    pub include_user_logon_4624: bool,
    pub batch_interval_ms: i64,
    pub heartbeat_interval_ms: i64,
    pub max_batch_events: usize,
}

impl AgentSettings {
    pub fn from_config(c: &crate::config::Config) -> Self {
        Self {
            computer: c.computer.clone(),
            domain: c.domain.clone(),
            channels: c.channels.clone(),
            state_dir: c.state_dir.clone(),
            initial_lookback_minutes: c.initial_lookback_minutes,
            include_user_logon_4624: c.include_user_logon_4624,
            batch_interval_ms: c.batch_interval_sec as i64 * 1000,
            heartbeat_interval_ms: c.heartbeat_interval_sec as i64 * 1000,
            max_batch_events: c.max_batch_events,
        }
    }
}

/// 送出中(未 ACK)的一批
#[derive(Debug, Clone)]
struct Batch {
    events: Vec<Value>,
    /// 收到 200 後各 Channel 的水位:(世代, 讀到的最後 RecordID,含被過濾掉的)
    marks: Vec<(Channel, u32, u64)>,
}

/// 額外的主機資訊(Watchdog 服務狀態、記憶體;Windows 才有),併進心跳
pub type SysInfo = Box<dyn FnMut() -> Map<String, Value> + Send>;

pub struct Agent<S: EventSource, T: Transport> {
    cfg: AgentSettings,
    source: S,
    transport: T,
    filter: EventFilter,
    bookmarks: Bookmarks,
    status: Arc<SharedStatus>,
    inflight: Option<Batch>,
    backoff: Backoff,
    next_collect_ms: i64,
    next_heartbeat_ms: i64,
    /// 心跳成功後才知道後端的水位;沒有本機水位的 Channel 要等它(bookmarks 遺失時接續 log_epoch)
    server_marks: Option<BTreeMap<Channel, ServerMark>>,
    /// Channel 是否存在(心跳回報)
    present: BTreeMap<Channel, bool>,
    /// 要隨心跳上報的 Agent 警告(log_record_id_reset 等)
    notices: VecDeque<Value>,
    rotate: usize,
    /// 同一個警告每分鐘最多記一次(例:Security 無權限時不洗日誌)
    last_warn: BTreeMap<String, i64>,
    sysinfo: Option<SysInfo>,
    pid: u32,
}

fn trunc(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

impl<S: EventSource, T: Transport> Agent<S, T> {
    pub fn new(
        cfg: AgentSettings,
        source: S,
        transport: T,
        status: Arc<SharedStatus>,
        now_ms: i64,
    ) -> Result<Self, String> {
        let (bookmarks, warn) = Bookmarks::load(&cfg.state_dir)?;
        let filter = EventFilter::new(cfg.include_user_logon_4624);
        let mut a = Self {
            cfg,
            source,
            transport,
            filter,
            bookmarks,
            status,
            inflight: None,
            backoff: Backoff::default(),
            next_collect_ms: now_ms,
            next_heartbeat_ms: now_ms,
            server_marks: None,
            present: BTreeMap::new(),
            notices: VecDeque::new(),
            rotate: 0,
            last_warn: BTreeMap::new(),
            sysinfo: None,
            pid: std::process::id(),
        };
        if let Some(w) = warn {
            log::warn!("{w}");
            a.notice(now_ms, json!({ "type": "bookmarks_corrupted" }));
        }
        a.publish_bookmarks();
        Ok(a)
    }

    pub fn with_sysinfo(mut self, f: SysInfo) -> Self {
        self.sysinfo = Some(f);
        self
    }

    pub fn bookmarks(&self) -> &Bookmarks {
        &self.bookmarks
    }

    pub fn has_inflight(&self) -> bool {
        self.inflight.is_some()
    }

    fn notice(&mut self, now_ms: i64, mut v: Value) {
        if let Some(o) = v.as_object_mut() {
            o.insert("source".into(), json!("agent"));
            o.insert("at".into(), json!(iso_ms(now_ms)));
        }
        if self.notices.len() >= MAX_PENDING_NOTICES {
            self.notices.pop_front();
        }
        self.notices.push_back(v);
    }

    fn warn_throttled(&mut self, now_ms: i64, msg: &str) {
        let last = self.last_warn.get(msg).copied();
        if last.is_none_or(|t| now_ms - t >= 60_000) {
            if self.last_warn.len() > 100 {
                self.last_warn.clear();
            }
            self.last_warn.insert(msg.to_string(), now_ms);
            log::warn!("{msg}");
        }
        self.set_error(msg);
    }

    fn set_error(&self, e: impl Into<String>) {
        let e = trunc(&e.into(), 300);
        self.status.update(|d| d.last_error = e);
    }

    fn publish_bookmarks(&self) {
        let marks: BTreeMap<&'static str, Mark> = self
            .bookmarks
            .iter()
            .map(|(c, m)| (c.wire_name(), m))
            .collect();
        let pending = self.inflight.as_ref().map_or(0, |b| b.events.len());
        self.status.update(|d| {
            d.bookmarks = marks;
            d.pending_events = pending;
        });
    }

    fn save_bookmarks(&self) {
        if let Err(e) = self.bookmarks.save(&self.cfg.state_dir) {
            log::error!("{e}");
            self.set_error(e);
        }
        self.publish_bookmarks();
    }

    /// 一輪主迴圈
    pub fn step(&mut self, now_ms: i64) {
        // M4:先更新 tick,不論之後後端成敗
        self.status.tick(now_ms);
        if now_ms >= self.next_heartbeat_ms {
            self.next_heartbeat_ms = now_ms + self.cfg.heartbeat_interval_ms;
            self.heartbeat(now_ms);
        }
        if self.inflight.is_some() {
            if self.backoff.ready(now_ms) {
                self.send_inflight(now_ms);
            }
            return;
        }
        if now_ms >= self.next_collect_ms {
            self.next_collect_ms = now_ms + self.cfg.batch_interval_ms;
            self.init_missing_marks(now_ms);
            if let Some(b) = self.collect(now_ms) {
                self.inflight = Some(b);
                self.publish_bookmarks();
                self.send_inflight(now_ms);
            }
        }
    }

    /// 沒有本機水位的 Channel:等心跳拿到後端水位後再決定起點(resolve_initial)
    fn init_missing_marks(&mut self, now_ms: i64) {
        let Some(server) = self.server_marks.clone() else {
            return;
        };
        let mut changed = false;
        for c in self.cfg.channels.clone() {
            if self.bookmarks.get(c).is_some() {
                continue;
            }
            let info = match self.source.log_info(c) {
                Ok(Some(i)) => i,
                Ok(None) => {
                    self.present.insert(c, false);
                    continue;
                }
                Err(e) => {
                    self.set_error(e);
                    continue;
                }
            };
            let since = now_ms - self.cfg.initial_lookback_minutes as i64 * 60_000;
            let lookback = match self.source.first_record_since(c, since) {
                Ok(r) => r,
                Err(e) => {
                    self.set_error(e);
                    continue;
                }
            };
            let m = resolve_initial(server.get(&c).copied(), info.newest_record_id, lookback);
            log::info!(
                "{} 沒有本機水位:後端紀錄 {:?},從世代 {} RecordID {} 之後開始",
                c.log_name(),
                server.get(&c),
                m.log_epoch,
                m.last_record_id
            );
            if let Some(s) = server.get(&c)
                && m.log_epoch != s.log_epoch
            {
                self.notice(now_ms, json!({ "type": "log_record_id_reset", "channel": c.wire_name(), "oldEpoch": s.log_epoch, "newEpoch": m.log_epoch, "detectedBy": "startup" }));
            }
            self.bookmarks.set(c, m);
            changed = true;
        }
        if changed {
            self.save_bookmarks();
        }
    }

    fn on_reset(&mut self, now_ms: i64, r: &ResetInfo) {
        log::warn!(
            "{} 的 RecordID 被重設(水位 {} > 目前最大 {}):世代 {} → {}",
            r.channel.log_name(),
            r.old_last_record_id,
            r.newest_record_id,
            r.old_epoch,
            r.new_epoch
        );
        self.notice(
            now_ms,
            json!({
                "type": "log_record_id_reset",
                "channel": r.channel.wire_name(),
                "oldEpoch": r.old_epoch,
                "newEpoch": r.new_epoch,
                "oldLastRecordId": r.old_last_record_id,
                "newestRecordId": r.newest_record_id,
            }),
        );
    }

    fn collect(&mut self, now_ms: i64) -> Option<Batch> {
        let mut events: Vec<Value> = Vec::new();
        let mut marks = Vec::new();
        let mut bytes = 0usize;
        let mut full = false;
        let mut reset = false;
        let n = self.cfg.channels.len();
        for i in 0..n {
            if full {
                break;
            }
            let c = self.cfg.channels[(self.rotate + i) % n];
            let info = match self.source.log_info(c) {
                Ok(Some(i)) => i,
                Ok(None) => {
                    self.present.insert(c, false);
                    continue;
                }
                Err(e) => {
                    self.warn_throttled(now_ms, &e);
                    continue;
                }
            };
            self.present.insert(c, true);
            if self.bookmarks.get(c).is_none() {
                continue;
            }
            if let Some(r) = self.bookmarks.detect_reset(c, info.newest_record_id) {
                self.on_reset(now_ms, &r);
                reset = true;
            }
            let Some(mark) = self.bookmarks.get(c) else {
                continue;
            };
            if info.newest_record_id <= mark.last_record_id {
                continue;
            }
            let capacity = self.cfg.max_batch_events.saturating_sub(events.len());
            if capacity == 0 {
                break;
            }
            let raws = match self.source.read_after(c, mark.last_record_id, capacity) {
                Ok(r) => r,
                Err(e) => {
                    self.warn_throttled(now_ms, &e);
                    continue;
                }
            };
            let mut through = mark.last_record_id;
            for raw in raws {
                let ev = match parse_event_xml(&raw.xml) {
                    Ok(ev) => ev,
                    Err(e) => {
                        log::warn!("{} 事件無法解析,略過:{e}", c.log_name());
                        continue;
                    }
                };
                if ev.record_id <= through {
                    continue;
                }
                if self.filter.accept(c, &ev) {
                    let v = json!({
                        "time": ev.time,
                        "channel": c.wire_name(),
                        "eventId": ev.event_id,
                        "recordId": ev.record_id,
                        "logEpoch": mark.log_epoch,
                        "level": ev.level,
                        "provider": ev.provider,
                        "message": trunc(&raw.message, MAX_MESSAGE_CHARS),
                    });
                    let size = v.to_string().len() + 1;
                    if !events.is_empty() && bytes + size > MAX_BATCH_BYTES {
                        full = true;
                        break;
                    }
                    bytes += size;
                    events.push(v);
                }
                through = ev.record_id;
            }
            if through > mark.last_record_id {
                marks.push((c, mark.log_epoch, through));
            }
            if events.len() >= self.cfg.max_batch_events {
                full = true;
            }
        }
        self.rotate = self.rotate.wrapping_add(1);
        if reset {
            self.save_bookmarks();
        }
        if events.is_empty() {
            // 全部被過濾掉:不必送,直接移動水位
            if !marks.is_empty() {
                for (c, e, t) in marks {
                    self.bookmarks.ack(c, e, t);
                }
                self.save_bookmarks();
            }
            return None;
        }
        Some(Batch { events, marks })
    }

    fn describe(code: u16, body: &Option<Value>) -> String {
        let server_code = body
            .as_ref()
            .and_then(|b| b.get("code"))
            .and_then(Value::as_str)
            .map(|c| format!(" {}", trunc(c, 64)))
            .unwrap_or_default();
        format!("後端回應 HTTP {code}{server_code}")
    }

    fn send_inflight(&mut self, now_ms: i64) {
        let Some(batch) = self.inflight.as_ref() else {
            return;
        };
        let body = json!({
            "computer": self.cfg.computer,
            "domain": self.cfg.domain,
            "agentVersion": VERSION,
            "events": batch.events,
        });
        match self.transport.post("/ad/v1/logs", &body) {
            HttpResult::Status {
                code: 200, body, ..
            } => {
                let batch = self.inflight.take().expect("inflight");
                for (c, e, t) in &batch.marks {
                    self.bookmarks.ack(*c, *e, *t);
                }
                let rejected = body
                    .as_ref()
                    .and_then(|b| b.get("rejected"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if rejected > 0 {
                    log::warn!("後端拒收 {rejected} 筆格式錯誤的事件(其餘已接受)");
                }
                let n = batch.events.len() as u64;
                self.backoff.reset();
                self.status.update(|d| {
                    d.last_send_ok_ms = Some(now_ms);
                    d.last_error.clear();
                    d.sent_events += n;
                });
                self.save_bookmarks();
                // 還有積壓時不等下一個週期(離線補送)
                self.next_collect_ms = now_ms;
            }
            HttpResult::Status {
                code,
                body,
                retry_after_sec,
            } => {
                let msg = Self::describe(code, &body);
                let delay = self
                    .backoff
                    .fail(now_ms, if code == 429 { retry_after_sec } else { None });
                log::warn!(
                    "送出 {} 筆失敗:{msg},{} 秒後重送同一批",
                    batch.events.len(),
                    delay / 1000
                );
                self.set_error(msg);
            }
            HttpResult::Failed(e) => {
                let delay = self.backoff.fail(now_ms, None);
                log::warn!(
                    "送出 {} 筆失敗:{e},{} 秒後重送同一批",
                    batch.events.len(),
                    delay / 1000
                );
                self.set_error(format!("連線失敗:{e}"));
            }
        }
    }

    fn channels_json(&mut self, now_ms: i64) -> Value {
        let mut out = Map::new();
        for c in self.cfg.channels.clone() {
            let mut o = Map::new();
            if let Some(m) = self.bookmarks.get(c) {
                o.insert("lastRecordId".into(), json!(m.last_record_id));
                o.insert("logEpoch".into(), json!(m.log_epoch));
            }
            if let Some(p) = self.present.get(&c) {
                o.insert("present".into(), json!(p));
            }
            if c == Channel::Security {
                if let Ok(Some(info)) = self.source.log_info(c) {
                    o.insert(
                        "fileSizeMb".into(),
                        json!((info.file_size as f64 / 1_048_576.0 * 10.0).round() / 10.0),
                    );
                    if let Some(max) = info.max_size {
                        o.insert(
                            "maxSizeMb".into(),
                            json!((max as f64 / 1_048_576.0 * 10.0).round() / 10.0),
                        );
                    }
                }
                match self.source.oldest_event_ms(c) {
                    Ok(Some(oldest)) => {
                        let (hours, risk) = coverage(now_ms, oldest);
                        o.insert("oldestEventAt".into(), json!(iso_ms(oldest)));
                        o.insert("coverageHours".into(), json!(hours));
                        o.insert("wrapRisk".into(), json!(risk));
                    }
                    Ok(None) => {}
                    Err(e) => log::warn!("{}", e),
                }
            }
            out.insert(c.wire_name().into(), Value::Object(o));
        }
        Value::Object(out)
    }

    pub fn heartbeat_body(&mut self, now_ms: i64) -> (Value, usize) {
        let d = self.status.snapshot();
        let mut agent = json!({
            "pid": self.pid,
            "serviceState": "running",
            "statusOk": true,
            "lastCollectTickAt": iso_ms(self.status.last_tick()),
            "lastSendOkAt": d.last_send_ok_ms.map(iso_ms).unwrap_or_default(),
            "lastError": d.last_error,
            "pendingEvents": d.pending_events,
            "sentEvents": d.sent_events,
            "startedAt": iso_ms(d.started_at_ms),
        });
        let mut extra = self.sysinfo.as_mut().map(|f| f()).unwrap_or_default();
        if let (Some(a), Some(Value::Object(more))) = (agent.as_object_mut(), extra.remove("agent"))
        {
            a.extend(more);
        }
        let n = self.notices.len().min(MAX_NOTICES_PER_HEARTBEAT);
        let notices: Vec<Value> = self.notices.iter().take(n).cloned().collect();
        let mut body = json!({
            "computer": self.cfg.computer,
            "domain": self.cfg.domain,
            "reportedAt": iso_ms(now_ms),
            "agentVersion": VERSION,
            "source": "agent",
            "agent": agent,
            "channels": self.channels_json(now_ms),
            "watchdogEvents": notices,
        });
        if let Some(o) = body.as_object_mut() {
            o.extend(extra);
        }
        (body, n)
    }

    fn heartbeat(&mut self, now_ms: i64) {
        let (body, sent_notices) = self.heartbeat_body(now_ms);
        match self.transport.post("/ad/v1/heartbeat", &body) {
            HttpResult::Status {
                code: 200, body, ..
            } => {
                for _ in 0..sent_notices {
                    self.notices.pop_front();
                }
                let mut marks = BTreeMap::new();
                if let Some(chs) = body
                    .as_ref()
                    .and_then(|b| b.get("channels"))
                    .and_then(Value::as_object)
                {
                    for (k, v) in chs {
                        if let (Some(c), Ok(m)) = (
                            Channel::from_name(k),
                            serde_json::from_value::<ServerMark>(v.clone()),
                        ) {
                            marks.insert(c, m);
                        }
                    }
                }
                if self.server_marks.is_none() {
                    log::info!("心跳成功;後端水位 {marks:?}");
                }
                self.server_marks = Some(marks);
            }
            HttpResult::Status { code, body, .. } => {
                let msg = Self::describe(code, &body);
                log::warn!("心跳失敗:{msg}");
                self.set_error(format!("心跳:{msg}"));
            }
            HttpResult::Failed(e) => {
                log::warn!("心跳失敗:{e}");
                self.set_error(format!("心跳連線失敗:{e}"));
            }
        }
    }
}

#[cfg(test)]
mod tests;
