//! Windows Event Log(wevtapi)讀取(計畫 §3.1 winlog.rs、§3.3)。只讀,不清除、不改設定。
//!
//! - 增量(0.1.1):`EvtQuery(channel, "*", 正向)` 不帶篩選 → `EvtCreateBookmark` + `EvtSeek` 直接定位到水位
//!   → `EvtNext` → `EvtRender`(XML)+ `EvtFormatMessage`。0.1.0 的 XPath `EventRecordID > N` 會從最舊一筆
//!   依序比對,3 GB Security Log 在 10 秒內找不到第一筆而逾時(GSMC-DC1 2026-11-25)。定位判斷在 [`crate::seek`]。
//! - 讀滿、逾時時保留查詢,下個週期水位相同就接著讀,不重新查詢
//! - 首次往回 60 分鐘:依 RecordID 二分搜尋([`crate::seek::first_id_since`]),不用 `timediff` 掃整個 Log
//! - 容量:`EvtGetLogInfo`(檔案大小、最舊 RecordID)、`EvtGetChannelConfigProperty`(MaxSize)
//! - Channel 不存在(例:沒裝 DNS 角色)回 None,呼叫端略過

use crate::agent::{EventSource, LogInfo, RawEvent};
use crate::channel::Channel;
use crate::seek::{self, ReadEnd, StartPlan};
use std::collections::HashMap;
use windows_sys::Win32::Foundation::{
    ERROR_INSUFFICIENT_BUFFER, ERROR_NO_MORE_ITEMS, GetLastError,
};
use windows_sys::Win32::System::EventLog::{
    EVT_HANDLE, EVT_VARIANT, EvtChannelLoggingConfigMaxSize, EvtClose, EvtCreateBookmark,
    EvtFormatMessage, EvtFormatMessageEvent, EvtGetChannelConfigProperty, EvtGetLogInfo,
    EvtLogFileSize, EvtLogOldestRecordNumber, EvtNext, EvtOpenChannelConfig, EvtOpenChannelPath,
    EvtOpenLog, EvtOpenPublisherMetadata, EvtQuery, EvtQueryChannelPath, EvtQueryForwardDirection,
    EvtQueryReverseDirection, EvtRender, EvtRenderEventXml, EvtSeek, EvtSeekRelativeToBookmark,
    EvtSeekStrict,
};

const ERROR_EVT_CHANNEL_NOT_FOUND: u32 = 15007;
const ERROR_EVT_UNRESOLVED_VALUE_INSERT: u32 = 15029;
const ERROR_EVT_UNRESOLVED_PARAMETER_INSERT: u32 = 15030;
const ERROR_EVT_MAX_INSERTS_REACHED: u32 = 15031;
const ERROR_TIMEOUT: u32 = 1460;
/// EvtNext 等待上限(毫秒):超過視為 Event Log 服務異常,回錯誤(主迴圈照常前進)
const NEXT_TIMEOUT_MS: u32 = 10_000;
const CHUNK: usize = 64;
/// 一次 read_after 最多略過幾筆 ≤ 水位的事件(書籤定位失敗、改從最舊一筆找水位時);超過就保留查詢,下個週期接著找
const SKIP_BUDGET: usize = 4096;
const MAX_PUBLISHERS: usize = 256;
/// 訊息緩衝上限(字元);送出前再截斷到 3,000 字
const MAX_MESSAGE_WCHARS: usize = 64 * 1024;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn last_error() -> u32 {
    // SAFETY:只讀執行緒的最後錯誤碼
    unsafe { GetLastError() }
}

/// EVT_HANDLE 的 RAII
struct Handle(EVT_HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        if self.0 != 0 {
            // SAFETY:由 wevtapi 取得、只關閉一次
            unsafe { EvtClose(self.0) };
        }
    }
}

fn get_u64(f: impl FnOnce(*mut EVT_VARIANT, u32, *mut u32) -> i32) -> Option<u64> {
    let mut v = EVT_VARIANT::default();
    let mut used = 0u32;
    let ok = f(&mut v, std::mem::size_of::<EVT_VARIANT>() as u32, &mut used);
    // SAFETY:這幾個屬性的型別都是 UInt64(EvtVarTypeUInt64);型別不符時讀到的是 0
    (ok != 0).then_some(unsafe { v.Anonymous.UInt64Val })
}

/// 保留的增量查詢:下一次 `EvtNext` 會從 RecordID > `after` 的事件開始
struct Cursor {
    rs: Handle,
    after: u64,
}

/// `EvtNext` 的結果
enum Next {
    Events(Vec<Handle>),
    NoMore,
    TimedOut,
}

#[derive(Default)]
pub struct WinEventLog {
    publishers: HashMap<String, Handle>,
    cursors: HashMap<Channel, Cursor>,
}

impl WinEventLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// None = Channel 不存在
    fn open_log(c: Channel) -> Result<Option<Handle>, String> {
        let path = wide(c.log_name());
        // SAFETY:字串以 NUL 結尾;控制代碼由 Handle 關閉
        let log = Handle(unsafe { EvtOpenLog(0, path.as_ptr(), EvtOpenChannelPath) });
        if log.0 == 0 {
            let e = last_error();
            if e == ERROR_EVT_CHANNEL_NOT_FOUND {
                return Ok(None);
            }
            return Err(format!("無法開啟 {}(錯誤 {e})", c.log_name()));
        }
        Ok(Some(log))
    }

    /// 最舊一筆的 RecordID(0 = 不明或沒有事件);None = Channel 不存在
    fn oldest_record_id(c: Channel) -> Result<Option<u64>, String> {
        let Some(log) = Self::open_log(c)? else {
            return Ok(None);
        };
        // SAFETY:EVT_VARIANT 緩衝與大小一致
        Ok(Some(
            get_u64(|v, size, used| unsafe {
                EvtGetLogInfo(log.0, EvtLogOldestRecordNumber, size, v, used)
            })
            .unwrap_or(0),
        ))
    }

    /// 把查詢定位到 `record_id` 那一筆(下一次 EvtNext 回傳它);那一筆不存在時失敗(EvtSeekStrict)
    fn seek_to(rs: &Handle, c: Channel, record_id: u64) -> Result<(), String> {
        let xml = wide(&seek::bookmark_xml(c.log_name(), record_id));
        // SAFETY:字串以 NUL 結尾;書籤控制代碼由 Handle 關閉
        let bm = Handle(unsafe { EvtCreateBookmark(xml.as_ptr()) });
        if bm.0 == 0 {
            return Err(format!(
                "{} 建立書籤失敗(錯誤 {})",
                c.log_name(),
                last_error()
            ));
        }
        // SAFETY:rs、bm 都是有效的控制代碼;timeout 保留參數必須為 0
        let ok = unsafe { EvtSeek(rs.0, 0, bm.0, 0, EvtSeekRelativeToBookmark | EvtSeekStrict) };
        if ok == 0 {
            return Err(format!(
                "{} 定位到 RecordID {record_id} 失敗(錯誤 {})",
                c.log_name(),
                last_error()
            ));
        }
        Ok(())
    }

    /// 開一個新的增量查詢,定位到水位 `after`(含)附近;None = Channel 不存在。
    /// 定位失敗(水位剛好被覆寫)時改從最舊一筆讀,呼叫端會丟掉 ≤ 水位的事件。
    fn open_after(&self, c: Channel, after: u64) -> Result<Option<Handle>, String> {
        let Some(oldest) = Self::oldest_record_id(c)? else {
            return Ok(None);
        };
        let Some(rs) = self.query_dir(c, "*", EvtQueryForwardDirection)? else {
            return Ok(None);
        };
        match seek::plan_start(after, oldest) {
            StartPlan::FromOldest => Ok(Some(rs)),
            StartPlan::AtRecord(id) => match Self::seek_to(&rs, c, id) {
                Ok(()) => Ok(Some(rs)),
                Err(e) => {
                    log::warn!("{e};改從最舊一筆讀");
                    drop(rs);
                    self.query_dir(c, "*", EvtQueryForwardDirection)
                }
            },
        }
    }

    /// 從 `rs` 讀 RecordID > `after` 的事件,最多 max 筆;回傳事件、讀到(含略過)的最大 RecordID、結束原因
    fn drain(
        &mut self,
        rs: &Handle,
        c: Channel,
        after: u64,
        max: usize,
    ) -> (Vec<RawEvent>, u64, ReadEnd, Option<String>) {
        let mut out = Vec::new();
        let mut consumed = after;
        let mut skipped = 0usize;
        while out.len() < max {
            let evs = match self.next_ex(rs, c, CHUNK.min(max - out.len())) {
                Ok(Next::Events(evs)) => evs,
                Ok(Next::NoMore) => return (out, consumed, ReadEnd::Exhausted, None),
                Ok(Next::TimedOut) => {
                    let e = format!("讀取 {} 逾時", c.log_name());
                    return (out, consumed, ReadEnd::TimedOut, Some(e));
                }
                Err(e) => return (out, consumed, ReadEnd::Failed, Some(e)),
            };
            for ev in evs {
                let xml = match Self::render_xml(&ev) {
                    Ok(x) => x,
                    Err(e) => {
                        log::warn!("{} {e},略過一筆", c.log_name());
                        continue;
                    }
                };
                // 定位到水位那一筆、或從最舊一筆找水位時:丟掉 ≤ 水位的事件(不算在 max 內,但有上限)
                if let Ok(p) = crate::parser::parse_event_xml(&xml) {
                    if p.record_id <= after {
                        skipped += 1;
                        if skipped >= SKIP_BUDGET {
                            return (out, consumed, ReadEnd::SkipBudget, None);
                        }
                        continue;
                    }
                    consumed = consumed.max(p.record_id);
                }
                let provider = provider_name(&xml).to_string();
                let message = self.format_message(&ev, &provider);
                out.push(RawEvent { xml, message });
            }
        }
        (out, consumed, ReadEnd::Full, None)
    }

    /// None = Channel 不存在
    fn query_dir(&self, c: Channel, xpath: &str, dir: u32) -> Result<Option<Handle>, String> {
        let path = wide(c.log_name());
        let q = wide(xpath);
        // SAFETY:字串以 NUL 結尾且活到呼叫結束;回傳的控制代碼由 Handle 關閉
        let h = unsafe { EvtQuery(0, path.as_ptr(), q.as_ptr(), EvtQueryChannelPath | dir) };
        if h == 0 {
            let e = last_error();
            if e == ERROR_EVT_CHANNEL_NOT_FOUND {
                return Ok(None);
            }
            return Err(format!("查詢 {} 失敗(錯誤 {e})", c.log_name()));
        }
        Ok(Some(Handle(h)))
    }

    fn query(&self, c: Channel, xpath: &str) -> Result<Option<Handle>, String> {
        self.query_dir(c, xpath, EvtQueryForwardDirection)
    }

    /// 以反向查詢讀最新 1 筆事件的真實 EventRecordID(無兩次 EvtGetLogInfo 的覆寫競態;審查 M2)
    /// None = Channel 不存在;Some(0) = Channel 目前沒有任何事件
    fn newest_record_id(&self, c: Channel) -> Result<Option<u64>, String> {
        let Some(rs) = self.query_dir(c, "*", EvtQueryReverseDirection)? else {
            return Ok(None);
        };
        let Some(ev) = self.next(&rs, c, 1)?.into_iter().next() else {
            return Ok(Some(0));
        };
        let xml = Self::render_xml(&ev)?;
        let parsed = crate::parser::parse_event_xml(&xml)
            .map_err(|e| format!("{} 最新事件 XML 解析失敗:{e}", c.log_name()))?;
        Ok(Some(parsed.record_id))
    }

    fn next(&self, rs: &Handle, c: Channel, n: usize) -> Result<Vec<Handle>, String> {
        match self.next_ex(rs, c, n)? {
            Next::Events(v) => Ok(v),
            Next::NoMore => Ok(Vec::new()),
            Next::TimedOut => Err(format!("讀取 {} 逾時", c.log_name())),
        }
    }

    fn next_ex(&self, rs: &Handle, c: Channel, n: usize) -> Result<Next, String> {
        let mut buf = vec![0isize; n];
        let mut returned = 0u32;
        // SAFETY:buf 長度與 eventssize 一致
        let ok = unsafe {
            EvtNext(
                rs.0,
                n as u32,
                buf.as_mut_ptr(),
                NEXT_TIMEOUT_MS,
                0,
                &mut returned,
            )
        };
        if ok == 0 {
            return match last_error() {
                ERROR_NO_MORE_ITEMS => Ok(Next::NoMore),
                ERROR_TIMEOUT => Ok(Next::TimedOut),
                e => Err(format!("讀取 {} 失敗(錯誤 {e})", c.log_name())),
            };
        }
        Ok(Next::Events(
            buf[..returned as usize]
                .iter()
                .map(|h| Handle(*h))
                .collect(),
        ))
    }

    fn render_xml(ev: &Handle) -> Result<String, String> {
        let mut used = 0u32;
        let mut count = 0u32;
        let mut buf: Vec<u16> = vec![0; 4096];
        for _ in 0..2 {
            // SAFETY:buffersize 以位元組計,與 buf 一致
            let ok = unsafe {
                EvtRender(
                    0,
                    ev.0,
                    EvtRenderEventXml,
                    (buf.len() * 2) as u32,
                    buf.as_mut_ptr().cast(),
                    &mut used,
                    &mut count,
                )
            };
            if ok != 0 {
                let n = (used as usize / 2).min(buf.len());
                let s = &buf[..n];
                let end = s.iter().position(|c| *c == 0).unwrap_or(n);
                return Ok(String::from_utf16_lossy(&s[..end]));
            }
            if last_error() != ERROR_INSUFFICIENT_BUFFER {
                break;
            }
            buf = vec![0; used as usize / 2 + 1];
        }
        Err(format!("事件 XML 轉換失敗(錯誤 {})", last_error()))
    }

    fn publisher(&mut self, name: &str) -> EVT_HANDLE {
        if name.is_empty() {
            return 0;
        }
        if let Some(h) = self.publishers.get(name) {
            return h.0;
        }
        if self.publishers.len() >= MAX_PUBLISHERS {
            self.publishers.clear();
        }
        let w = wide(name);
        // SAFETY:字串以 NUL 結尾;locale 0 = 系統預設語系(與 FTP 匯出的 Message 相同語言)
        let h = unsafe { EvtOpenPublisherMetadata(0, w.as_ptr(), std::ptr::null(), 0, 0) };
        self.publishers.insert(name.to_string(), Handle(h));
        h
    }

    fn format_message(&mut self, ev: &Handle, provider: &str) -> String {
        let meta = self.publisher(provider);
        let mut buf: Vec<u16> = vec![0; 2048];
        for _ in 0..2 {
            let mut used = 0u32;
            // SAFETY:buffersize 以字元計,與 buf 一致
            let ok = unsafe {
                EvtFormatMessage(
                    meta,
                    ev.0,
                    0,
                    0,
                    std::ptr::null(),
                    EvtFormatMessageEvent,
                    buf.len() as u32,
                    buf.as_mut_ptr(),
                    &mut used,
                )
            };
            let e = if ok != 0 { 0 } else { last_error() };
            match e {
                0
                | ERROR_EVT_UNRESOLVED_VALUE_INSERT
                | ERROR_EVT_UNRESOLVED_PARAMETER_INSERT
                | ERROR_EVT_MAX_INSERTS_REACHED => {
                    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
                    return String::from_utf16_lossy(&buf[..end]);
                }
                ERROR_INSUFFICIENT_BUFFER if (used as usize) <= MAX_MESSAGE_WCHARS => {
                    buf = vec![0; used as usize + 1];
                }
                // 沒有訊息資源(FTP 匯出也會是空的):送空字串
                _ => return String::new(),
            }
        }
        String::new()
    }

    fn first_xml(&self, c: Channel, xpath: &str) -> Result<Option<String>, String> {
        let Some(rs) = self.query(c, xpath)? else {
            return Ok(None);
        };
        match self.next(&rs, c, 1)?.first() {
            Some(ev) => Self::render_xml(ev).map(Some),
            None => Ok(None),
        }
    }
}

/// XML 中 Provider 的 Name(只為了找訊息資源;找不到回空字串)
fn provider_name(xml: &str) -> &str {
    let Some(i) = xml.find("<Provider Name=") else {
        return "";
    };
    let rest = &xml[i + 15..];
    let Some(q) = rest.chars().next().filter(|c| *c == '\'' || *c == '"') else {
        return "";
    };
    rest[1..].split(q).next().unwrap_or("")
}

impl EventSource for WinEventLog {
    fn log_info(&mut self, c: Channel) -> Result<Option<LogInfo>, String> {
        let path = wide(c.log_name());
        let Some(log) = Self::open_log(c)? else {
            return Ok(None);
        };
        // SAFETY:EVT_VARIANT 緩衝與大小一致
        let prop = |id| get_u64(|v, size, used| unsafe { EvtGetLogInfo(log.0, id, size, v, used) });
        let file_size = prop(EvtLogFileSize).unwrap_or(0);
        // 反向 EvtQuery 直接讀最新 1 筆 EventRecordID,避免 oldest + count - 1 在覆寫中途誤判換世代(審查 M2)
        let Some(newest) = self.newest_record_id(c)? else {
            return Ok(None);
        };
        let max_size = if c == Channel::Security {
            // SAFETY:同上
            let cfg = Handle(unsafe { EvtOpenChannelConfig(0, path.as_ptr(), 0) });
            (cfg.0 != 0)
                .then(|| {
                    get_u64(|v, size, used| unsafe {
                        EvtGetChannelConfigProperty(
                            cfg.0,
                            EvtChannelLoggingConfigMaxSize,
                            0,
                            size,
                            v,
                            used,
                        )
                    })
                })
                .flatten()
        } else {
            None
        };
        Ok(Some(LogInfo {
            newest_record_id: newest,
            file_size,
            max_size,
        }))
    }

    fn confirm_newest_record_id(&mut self, c: Channel) -> Result<Option<u64>, String> {
        self.newest_record_id(c)
    }

    fn read_after(&mut self, c: Channel, after: u64, max: usize) -> Result<Vec<RawEvent>, String> {
        // 上個週期讀滿或逾時、水位相同:接著用同一個查詢,不重新查詢
        let kept = self.cursors.remove(&c);
        let reused = seek::can_reuse(kept.as_ref().map(|k| k.after), after);
        let mut rs = match kept {
            Some(k) if reused => k.rs,
            _ => match self.open_after(c, after)? {
                Some(rs) => rs,
                None => return Ok(Vec::new()),
            },
        };
        let (mut out, mut consumed, mut end, mut err) = self.drain(&rs, c, after, max);
        if reused && end == ReadEnd::Failed && out.is_empty() {
            // 保留的查詢失效(例:等待期間 Log 被覆寫或清除):重新定位一次
            log::warn!(
                "{} 保留的查詢無法使用({}),重新定位",
                c.log_name(),
                err.as_deref().unwrap_or("")
            );
            drop(rs);
            rs = match self.open_after(c, after)? {
                Some(rs) => rs,
                None => return Ok(Vec::new()),
            };
            (out, consumed, end, err) = self.drain(&rs, c, after, max);
        }
        if seek::keep_cursor(end) {
            self.cursors.insert(
                c,
                Cursor {
                    rs,
                    after: consumed,
                },
            );
        }
        match err {
            // 已讀到的事件先交出去(水位照常前進);沒讀到才回錯誤,查詢保留到下個週期
            Some(e) if out.is_empty() => Err(e),
            Some(e) => {
                log::warn!("{e},先送出已讀到的 {} 筆", out.len());
                Ok(out)
            }
            None => Ok(out),
        }
    }

    fn first_record_since(&mut self, c: Channel, since_ms: i64) -> Result<Option<u64>, String> {
        let Some(oldest) = Self::oldest_record_id(c)? else {
            return Ok(None);
        };
        let Some(newest) = self.newest_record_id(c)? else {
            return Ok(None);
        };
        let Some(rs) = self.query_dir(c, "*", EvtQueryForwardDirection)? else {
            return Ok(None);
        };
        // 依 RecordID 二分搜尋,每次以書籤定位讀 1 筆的時間(不用 timediff 掃整個 Log)
        seek::first_id_since(oldest, newest, since_ms, |id| {
            Self::seek_to(&rs, c, id)?;
            let ev = self
                .next(&rs, c, 1)?
                .into_iter()
                .next()
                .ok_or_else(|| format!("{} 定位到 RecordID {id} 後讀不到事件", c.log_name()))?;
            let xml = Self::render_xml(&ev)?;
            let p = crate::parser::parse_event_xml(&xml)
                .map_err(|e| format!("{} RecordID {id} XML 解析失敗:{e}", c.log_name()))?;
            if p.record_id != id {
                return Err(format!(
                    "{} 定位到 RecordID {id} 卻讀到 {}",
                    c.log_name(),
                    p.record_id
                ));
            }
            crate::parser::event_time_ms(&xml)
                .ok_or_else(|| format!("{} RecordID {id} 沒有時間", c.log_name()))
        })
    }

    fn oldest_event_ms(&mut self, c: Channel) -> Result<Option<i64>, String> {
        Ok(self
            .first_xml(c, "*")?
            .as_deref()
            .and_then(crate::parser::event_time_ms))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 取出provider名稱() {
        assert_eq!(
            provider_name(
                "<Event><System><Provider Name='Microsoft-Windows-Security-Auditing' Guid='x'/>"
            ),
            "Microsoft-Windows-Security-Auditing"
        );
        assert_eq!(
            provider_name("<Provider Name=\"Service Control Manager\"/>"),
            "Service Control Manager"
        );
        assert_eq!(provider_name("<Event/>"), "");
    }

    /// 開發機上讀真的 System Log(不需系統管理員;Security 需要)
    #[test]
    fn 讀本機system_log() {
        let mut w = WinEventLog::new();
        let info = w
            .log_info(Channel::System)
            .unwrap()
            .expect("System channel");
        assert!(info.newest_record_id > 0);
        let evs = w
            .read_after(Channel::System, info.newest_record_id.saturating_sub(3), 10)
            .unwrap();
        assert!(!evs.is_empty());
        let e = crate::parser::parse_event_xml(&evs[0].xml).unwrap();
        assert!(e.record_id > info.newest_record_id.saturating_sub(3));
        assert!(w.oldest_event_ms(Channel::System).unwrap().is_some());
        // 一般電腦沒有 Directory Service
        assert!(w.log_info(Channel::DirectoryService).unwrap().is_none());
    }

    fn ids(evs: &[RawEvent]) -> Vec<u64> {
        evs.iter()
            .map(|e| crate::parser::parse_event_xml(&e.xml).unwrap().record_id)
            .collect()
    }

    /// 0.1.1:書籤定位、讀滿保留查詢接著讀、水位不同重新定位
    #[test]
    fn 書籤定位與保留查詢_本機system_log() {
        let mut w = WinEventLog::new();
        let newest = w
            .log_info(Channel::System)
            .unwrap()
            .unwrap()
            .newest_record_id;
        let oldest = WinEventLog::oldest_record_id(Channel::System)
            .unwrap()
            .unwrap();
        assert!(oldest >= 1 && oldest <= newest);
        if newest < oldest + 20 {
            return; // Log 太少,略過
        }
        let start = newest - 10;
        let a = w.read_after(Channel::System, start, 3).unwrap();
        let a_ids = ids(&a);
        assert_eq!(a_ids.len(), 3);
        assert!(a_ids.iter().all(|id| *id > start));
        assert!(a_ids.windows(2).all(|p| p[0] < p[1]));
        // 讀滿 → 保留查詢,水位相同接著讀
        let last = *a_ids.last().unwrap();
        assert_eq!(w.cursors.get(&Channel::System).map(|c| c.after), Some(last));
        let b_ids = ids(&w.read_after(Channel::System, last, 2).unwrap());
        assert!(!b_ids.is_empty() && b_ids[0] > last);
        // 水位不同(例:批次只送出一部分)→ 重新定位
        let c_ids = ids(&w.read_after(Channel::System, a_ids[0], 1).unwrap());
        assert_eq!(c_ids.len(), 1);
        assert!(c_ids[0] > a_ids[0]);
        // 水位 0 → 從最舊一筆
        let d_ids = ids(&w.read_after(Channel::System, 0, 1).unwrap());
        assert_eq!(d_ids, vec![oldest]);
        // 讀到結尾 → 不保留查詢
        let e = w.read_after(Channel::System, newest, 1000).unwrap();
        assert!(ids(&e).iter().all(|id| *id > newest));
        if e.len() < 1000 {
            assert!(!w.cursors.contains_key(&Channel::System));
        }
    }

    /// 0.1.1:往回找改二分搜尋;結果的前一筆時間早於 since
    #[test]
    fn 往回找第一筆_本機system_log() {
        let mut w = WinEventLog::new();
        let now = chrono::Utc::now().timestamp_millis();
        // 比最舊還早 → 最舊一筆;未來 → None
        let oldest = WinEventLog::oldest_record_id(Channel::System)
            .unwrap()
            .unwrap();
        assert_eq!(
            w.first_record_since(Channel::System, 0).unwrap(),
            Some(oldest)
        );
        assert_eq!(
            w.first_record_since(Channel::System, now + 86_400_000)
                .unwrap(),
            None
        );
        // 往回 7 天:找到的那筆時間 ≥ since
        let since = now - 7 * 86_400_000;
        if let Some(id) = w.first_record_since(Channel::System, since).unwrap() {
            let ev = w.read_after(Channel::System, id - 1, 1).unwrap();
            let t = crate::parser::event_time_ms(&ev[0].xml).unwrap();
            assert!(t >= since);
        }
    }
}
