//! 事件過濾(AD5;計畫 §3.3 第 1 點:EventID 在記憶體以 HashSet 過濾,不受 XPath 條件數上限)。純函式。
//!
//! Security:
//! - 既有 v3 FTP 匯出的 23 種稽核事件(scripts/dc/ADLog-FtpBackup-3.ps1 $SecurityEventIds)全收
//! - 4672 特殊權限登入:排除電腦帳戶(`$` 結尾)與 SYSTEM / LOCAL SERVICE / NETWORK SERVICE(名稱或 SID)
//! - 4776 NTLM 認證、4768 Kerberos TGT:只收失敗(Status ≠ 0x0)
//! - 4624 登入成功:`include_user_logon_4624` 開啟時才收,只收真人帳號(排除 `$` 結尾、內建服務帳號與匿名)
//!
//! 其他 Channel(System、Directory Service、DNS Server)全收。

use crate::channel::Channel;
use crate::parser::ParsedEvent;
use std::collections::HashSet;

/// v3 FTP 匯出的 23 種(順序同腳本)
pub const V3_SECURITY_IDS: [u32; 23] = [
    4625, 4771, 4740, 4767, 4720, 4722, 4725, 4726, 4724, 4738, 4781, 4728, 4729, 4732, 4733, 4756,
    4757, 4727, 4731, 4754, 4704, 4794, 1102,
];

const SERVICE_NAMES: [&str; 3] = ["SYSTEM", "LOCAL SERVICE", "NETWORK SERVICE"];
/// SYSTEM、LOCAL SERVICE、NETWORK SERVICE、ANONYMOUS LOGON(名稱在非英文系統可能被翻譯,SID 不會)
const SERVICE_SIDS: [&str; 4] = ["S-1-5-18", "S-1-5-19", "S-1-5-20", "S-1-5-7"];

pub struct EventFilter {
    security: HashSet<u32>,
    include_4624: bool,
}

fn is_service_account(name: Option<&str>, sid: Option<&str>) -> bool {
    let name = name.unwrap_or("").trim();
    name.ends_with('$')
        || SERVICE_NAMES.iter().any(|s| s.eq_ignore_ascii_case(name))
        || name.eq_ignore_ascii_case("ANONYMOUS LOGON")
        || sid.is_some_and(|s| SERVICE_SIDS.contains(&s.trim()))
}

/// Status 欄位不是 0(缺欄位或無法解析時保守收下)
fn failed_status(e: &ParsedEvent) -> bool {
    let Some(s) = e.data("Status") else {
        return true;
    };
    let s = s.trim();
    let v = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .map_or_else(
            || s.parse::<u64>().ok(),
            |h| u64::from_str_radix(h, 16).ok(),
        );
    v != Some(0)
}

impl EventFilter {
    pub fn new(include_user_logon_4624: bool) -> Self {
        let mut security: HashSet<u32> = V3_SECURITY_IDS.into_iter().collect();
        security.extend([4672, 4776, 4768]);
        if include_user_logon_4624 {
            security.insert(4624);
        }
        Self {
            security,
            include_4624: include_user_logon_4624,
        }
    }

    pub fn accept(&self, channel: Channel, e: &ParsedEvent) -> bool {
        if channel != Channel::Security {
            return true;
        }
        if !self.security.contains(&e.event_id) {
            return false;
        }
        match e.event_id {
            4672 => !is_service_account(e.data("SubjectUserName"), e.data("SubjectUserSid")),
            4776 | 4768 => failed_status(e),
            4624 => {
                self.include_4624
                    && !is_service_account(e.data("TargetUserName"), e.data("TargetUserSid"))
            }
            _ => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::{parse_event_xml, tests::sample};

    fn ev(id: u32, data: &[(&str, &str)]) -> ParsedEvent {
        parse_event_xml(&sample(id, 10, "0x8020000000000000", data)).unwrap()
    }

    #[test]
    fn security白名單23種全收_其他id不收() {
        let f = EventFilter::new(false);
        for id in V3_SECURITY_IDS {
            assert!(f.accept(Channel::Security, &ev(id, &[])), "{id} 應收");
        }
        for id in [4634, 4648, 4769, 5136, 4624] {
            assert!(!f.accept(Channel::Security, &ev(id, &[])), "{id} 不應收");
        }
    }

    #[test]
    fn 其他channel全收() {
        let f = EventFilter::new(false);
        assert!(f.accept(Channel::System, &ev(7036, &[])));
        assert!(f.accept(Channel::DnsServer, &ev(4013, &[])));
        assert!(f.accept(Channel::DirectoryService, &ev(1644, &[])));
    }

    #[test]
    fn 事件4672排除電腦帳戶與服務帳號() {
        let f = EventFilter::new(false);
        let s = Channel::Security;
        assert!(f.accept(
            s,
            &ev(
                4672,
                &[
                    ("SubjectUserName", "admin.chen"),
                    ("SubjectUserSid", "S-1-5-21-1-2-3-1105")
                ]
            )
        ));
        assert!(!f.accept(s, &ev(4672, &[("SubjectUserName", "GSMC-DC1$")])));
        assert!(!f.accept(s, &ev(4672, &[("SubjectUserName", "system")])));
        assert!(!f.accept(s, &ev(4672, &[("SubjectUserName", "NETWORK SERVICE")])));
        // 名稱被翻譯時以 SID 判斷
        assert!(!f.accept(
            s,
            &ev(
                4672,
                &[
                    ("SubjectUserName", "本機服務"),
                    ("SubjectUserSid", "S-1-5-19")
                ]
            )
        ));
    }

    #[test]
    fn 事件4776與4768只收失敗() {
        let f = EventFilter::new(false);
        let s = Channel::Security;
        assert!(!f.accept(s, &ev(4776, &[("Status", "0x0")])));
        assert!(f.accept(s, &ev(4776, &[("Status", "0xc000006a")])));
        assert!(!f.accept(s, &ev(4768, &[("Status", "0x0")])));
        assert!(f.accept(s, &ev(4768, &[("Status", "0x18")])));
        assert!(f.accept(s, &ev(4768, &[])), "缺 Status 時保守收下");
    }

    #[test]
    fn 事件4624預設關閉_開啟時只收真人帳號() {
        let off = EventFilter::new(false);
        let on = EventFilter::new(true);
        let s = Channel::Security;
        let user = ev(
            4624,
            &[
                ("TargetUserName", "alice"),
                ("TargetUserSid", "S-1-5-21-1-2-3-1201"),
            ],
        );
        assert!(!off.accept(s, &user));
        assert!(on.accept(s, &user));
        assert!(!on.accept(s, &ev(4624, &[("TargetUserName", "WS-001$")])));
        assert!(!on.accept(
            s,
            &ev(
                4624,
                &[
                    ("TargetUserName", "ANONYMOUS LOGON"),
                    ("TargetUserSid", "S-1-5-7")
                ]
            )
        ));
        assert!(!on.accept(
            s,
            &ev(
                4624,
                &[("TargetUserName", "SYSTEM"), ("TargetUserSid", "S-1-5-18")]
            )
        ));
    }
}
