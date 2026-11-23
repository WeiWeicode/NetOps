//! Event XML(EvtRender EvtRenderEventXml)→ 事件欄位(計畫 §3.1 parser.rs)。純函式,不依賴 Windows API。
//!
//! 欄位對齊 FTP CSV(scripts/dc/ADLog-FtpBackup-3.ps1)與接收端 payload(backend/src/ad-receiver/payload.ts):
//! time(含時區的 ISO 8601,換成本機時區、毫秒)、eventId、recordId、level、provider;message 由 EvtFormatMessage 另外取得。

use chrono::{DateTime, Local};
use std::collections::HashMap;

/// Keywords:稽核成功 / 失敗(winmeta.xml WINEVENT_KEYWORD_AUDIT_*)
const KW_AUDIT_FAILURE: u64 = 0x0010_0000_0000_0000;
const KW_AUDIT_SUCCESS: u64 = 0x0020_0000_0000_0000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedEvent {
    pub event_id: u32,
    pub record_id: u64,
    /// 本機時區、毫秒,例 2026-11-20T13:05:12.345+08:00
    pub time: String,
    /// Audit Success / Audit Failure / Critical / Error / Warning / Information / Verbose(adlog.js levelOf 認得的英文)
    pub level: &'static str,
    pub provider: String,
    /// EventData 的 Data Name → 值(只用在過濾)
    pub data: HashMap<String, String>,
}

impl ParsedEvent {
    pub fn data(&self, name: &str) -> Option<&str> {
        self.data.get(name).map(String::as_str)
    }
}

fn parse_u64(s: &str) -> Option<u64> {
    let s = s.trim();
    match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        Some(h) => u64::from_str_radix(h, 16).ok(),
        None => s.parse().ok(),
    }
}

/// SystemTime(UTC,最多 7 位小數)→ 本機時區、毫秒
pub fn to_local_iso(system_time: &str) -> Option<String> {
    let t = DateTime::parse_from_rfc3339(system_time.trim()).ok()?;
    Some(
        t.with_timezone(&Local)
            .format("%Y-%m-%dT%H:%M:%S%.3f%:z")
            .to_string(),
    )
}

/// SystemTime → Unix 毫秒
pub fn to_unix_ms(system_time: &str) -> Option<i64> {
    Some(
        DateTime::parse_from_rfc3339(system_time.trim())
            .ok()?
            .timestamp_millis(),
    )
}

fn level_of(level: u64, keywords: u64) -> &'static str {
    if keywords & KW_AUDIT_FAILURE != 0 {
        return "Audit Failure";
    }
    if keywords & KW_AUDIT_SUCCESS != 0 {
        return "Audit Success";
    }
    match level {
        1 => "Critical",
        2 => "Error",
        3 => "Warning",
        5 => "Verbose",
        _ => "Information",
    }
}

/// 解析一筆事件;缺 EventID / EventRecordID / TimeCreated 時回錯誤原因
pub fn parse_event_xml(xml: &str) -> Result<ParsedEvent, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("Event XML 格式錯誤:{e}"))?;
    let mut event_id = None;
    let mut record_id = None;
    let mut time = None;
    let mut level = 0u64;
    let mut keywords = 0u64;
    let mut provider = String::new();
    let mut data = HashMap::new();
    for n in doc.descendants().filter(|n| n.is_element()) {
        match n.tag_name().name() {
            "EventID" => event_id = n.text().and_then(parse_u64),
            "EventRecordID" => record_id = n.text().and_then(parse_u64),
            "TimeCreated" => time = n.attribute("SystemTime").map(str::to_string),
            "Level" => level = n.text().and_then(parse_u64).unwrap_or(0),
            "Keywords" => keywords = n.text().and_then(parse_u64).unwrap_or(0),
            "Provider" => {
                provider = n
                    .attribute("Name")
                    .or_else(|| n.attribute("EventSourceName"))
                    .unwrap_or("")
                    .to_string()
            }
            "Data" => {
                if let Some(name) = n.attribute("Name")
                    && data.len() < 64
                {
                    data.insert(name.to_string(), n.text().unwrap_or("").to_string());
                }
            }
            _ => {}
        }
    }
    let event_id = event_id.filter(|v| *v <= 65_535).ok_or("缺少 EventID")? as u32;
    let record_id = record_id.filter(|v| *v > 0).ok_or("缺少 EventRecordID")?;
    let time = time
        .as_deref()
        .and_then(to_local_iso)
        .ok_or("缺少 TimeCreated")?;
    Ok(ParsedEvent {
        event_id,
        record_id,
        time,
        level: level_of(level, keywords),
        provider: provider.chars().take(256).collect(),
        data,
    })
}

/// 只取 TimeCreated(Security Log 最舊一筆的時間)
pub fn event_time_ms(xml: &str) -> Option<i64> {
    let doc = roxmltree::Document::parse(xml).ok()?;
    doc.descendants()
        .find(|n| n.tag_name().name() == "TimeCreated")
        .and_then(|n| n.attribute("SystemTime"))
        .and_then(to_unix_ms)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 測試用的 Event XML(格式同 EvtRender)
    pub fn sample(event_id: u32, record_id: u64, keywords: &str, data: &[(&str, &str)]) -> String {
        let d: String = data
            .iter()
            .map(|(k, v)| format!("<Data Name='{k}'>{v}</Data>"))
            .collect();
        format!(
            "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System>\
             <Provider Name='Microsoft-Windows-Security-Auditing' Guid='{{54849625-5478-4994-A5BA-3E3B0328C30D}}'/>\
             <EventID>{event_id}</EventID><Version>0</Version><Level>0</Level><Task>12544</Task><Opcode>0</Opcode>\
             <Keywords>{keywords}</Keywords><TimeCreated SystemTime='2026-11-20T05:05:12.3456789Z'/>\
             <EventRecordID>{record_id}</EventRecordID><Correlation/><Execution ProcessID='636' ThreadID='700'/>\
             <Channel>Security</Channel><Computer>GSMC-DC1.gsmc.com.tw</Computer><Security/></System>\
             <EventData>{d}</EventData></Event>"
        )
    }

    #[test]
    fn 解析security稽核失敗事件() {
        let x = sample(
            4625,
            98765432,
            "0x8010000000000000",
            &[("TargetUserName", "alice")],
        );
        let e = parse_event_xml(&x).unwrap();
        assert_eq!(e.event_id, 4625);
        assert_eq!(e.record_id, 98765432);
        assert_eq!(e.level, "Audit Failure");
        assert_eq!(e.provider, "Microsoft-Windows-Security-Auditing");
        assert_eq!(e.data("TargetUserName"), Some("alice"));
        // 換成本機時區、毫秒;同一個時間點
        let ms = DateTime::parse_from_rfc3339(&e.time)
            .unwrap()
            .timestamp_millis();
        assert_eq!(ms, 1_795_151_112_345);
        assert!(e.time.len() <= 40);
    }

    #[test]
    fn 系統事件含qualifiers與等級() {
        let x = "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System>\
                 <Provider Name='Service Control Manager' EventSourceName='Service Control Manager'/>\
                 <EventID Qualifiers='49152'>7031</EventID><Level>2</Level><Keywords>0x8080000000000000</Keywords>\
                 <TimeCreated SystemTime='2026-11-20T05:05:12.000Z'/><EventRecordID>451200</EventRecordID>\
                 <Channel>System</Channel></System><EventData><Data Name='param1'>x</Data></EventData></Event>";
        let e = parse_event_xml(x).unwrap();
        assert_eq!((e.event_id, e.record_id, e.level), (7031, 451200, "Error"));
        assert_eq!(e.provider, "Service Control Manager");
    }

    #[test]
    fn 缺欄位或壞xml回錯誤() {
        assert!(parse_event_xml("<Event>").is_err());
        assert!(parse_event_xml("<Event><System><EventID>1</EventID></System></Event>").is_err());
        assert_eq!(
            event_time_ms(&sample(1, 1, "0x0", &[])),
            Some(1_795_151_112_345)
        );
    }
}
