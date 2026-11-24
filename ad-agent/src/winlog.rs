//! Windows Event Log(wevtapi)讀取(計畫 §3.1 winlog.rs、§3.3)。只讀,不清除、不改設定。
//!
//! - 增量:`EvtQuery(channel, "*[System[(EventRecordID > N)]]", 正向)` → `EvtNext` → `EvtRender`(XML)+ `EvtFormatMessage`
//! - 容量:`EvtGetLogInfo`(檔案大小、筆數、最舊 RecordID)、`EvtGetChannelConfigProperty`(MaxSize)
//! - Channel 不存在(例:沒裝 DNS 角色)回 None,呼叫端略過

use crate::agent::{EventSource, LogInfo, RawEvent};
use crate::channel::Channel;
use std::collections::HashMap;
use windows_sys::Win32::Foundation::{
    ERROR_INSUFFICIENT_BUFFER, ERROR_NO_MORE_ITEMS, GetLastError,
};
use windows_sys::Win32::System::EventLog::{
    EVT_HANDLE, EVT_VARIANT, EvtChannelLoggingConfigMaxSize, EvtClose, EvtFormatMessage,
    EvtFormatMessageEvent, EvtGetChannelConfigProperty, EvtGetLogInfo, EvtLogFileSize, EvtNext,
    EvtOpenChannelConfig, EvtOpenChannelPath, EvtOpenLog, EvtOpenPublisherMetadata, EvtQuery,
    EvtQueryChannelPath, EvtQueryForwardDirection, EvtQueryReverseDirection, EvtRender,
    EvtRenderEventXml,
};

const ERROR_EVT_CHANNEL_NOT_FOUND: u32 = 15007;
const ERROR_EVT_UNRESOLVED_VALUE_INSERT: u32 = 15029;
const ERROR_EVT_UNRESOLVED_PARAMETER_INSERT: u32 = 15030;
const ERROR_EVT_MAX_INSERTS_REACHED: u32 = 15031;
const ERROR_TIMEOUT: u32 = 1460;
/// EvtNext 等待上限(毫秒):超過視為 Event Log 服務異常,回錯誤(主迴圈照常前進)
const NEXT_TIMEOUT_MS: u32 = 10_000;
const CHUNK: usize = 64;
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

#[derive(Default)]
pub struct WinEventLog {
    publishers: HashMap<String, Handle>,
}

impl WinEventLog {
    pub fn new() -> Self {
        Self::default()
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
                ERROR_NO_MORE_ITEMS => Ok(Vec::new()),
                ERROR_TIMEOUT => Err(format!("讀取 {} 逾時", c.log_name())),
                e => Err(format!("讀取 {} 失敗(錯誤 {e})", c.log_name())),
            };
        }
        Ok(buf[..returned as usize]
            .iter()
            .map(|h| Handle(*h))
            .collect())
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
        // SAFETY:字串以 NUL 結尾;控制代碼由 Handle 關閉
        let log = Handle(unsafe { EvtOpenLog(0, path.as_ptr(), EvtOpenChannelPath) });
        if log.0 == 0 {
            let e = last_error();
            if e == ERROR_EVT_CHANNEL_NOT_FOUND {
                return Ok(None);
            }
            return Err(format!("無法開啟 {}(錯誤 {e})", c.log_name()));
        }
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
        let Some(rs) = self.query(c, &format!("*[System[(EventRecordID > {after})]]"))? else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        while out.len() < max {
            let evs = self.next(&rs, c, CHUNK.min(max - out.len()))?;
            if evs.is_empty() {
                break;
            }
            for ev in evs {
                let xml = match Self::render_xml(&ev) {
                    Ok(x) => x,
                    Err(e) => {
                        log::warn!("{} {e},略過一筆", c.log_name());
                        continue;
                    }
                };
                let provider = provider_name(&xml).to_string();
                let message = self.format_message(&ev, &provider);
                out.push(RawEvent { xml, message });
            }
        }
        Ok(out)
    }

    fn first_record_since(&mut self, c: Channel, since_ms: i64) -> Result<Option<u64>, String> {
        let now = chrono::Utc::now().timestamp_millis();
        let diff = (now - since_ms).max(0);
        let xml = self.first_xml(
            c,
            &format!("*[System[TimeCreated[timediff(@SystemTime) <= {diff}]]]"),
        )?;
        Ok(xml
            .and_then(|x| crate::parser::parse_event_xml(&x).ok())
            .map(|e| e.record_id))
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
}
