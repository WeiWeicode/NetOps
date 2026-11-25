//! 事件過濾(AD5、AD-6;計畫 §3.3 第 1 點與 §9:EventID 在記憶體以 HashSet 過濾,不受 XPath 條件數上限)。純函式。
//!
//! Security:
//! - 既有 v3 FTP 匯出的 23 種稽核事件(scripts/dc/ADLog-FtpBackup-3.ps1 $SecurityEventIds)全收
//! - AD-6 §9.2 量小事件預設收(27 種無條件 ID + 4616 排除 LOCAL SERVICE / S-1-5-19 + 4624 登入類型 10 真人帳號)
//! - 4672 特殊權限登入:排除電腦帳戶(`$` 結尾)與 SYSTEM / LOCAL SERVICE / NETWORK SERVICE(名稱或 SID)
//! - 4776 NTLM 認證:只收失敗(Status ≠ 0x0)
//! - 4768 Kerberos TGT:收失敗(Status ≠ 0x0)或弱加密 `TicketEncryptionType = 0x17`(RC4)
//! - 4624 登入成功:登入類型 10(RDP)預設收(真人帳號);其他登入類型(含類型 3)由 `include_user_logon_4624`(預設關)控制,仍限真人帳號
//! - AD-6 §9.3 量大事件由開關控制(預設皆 `false`,先在 GSMC-DC1 實測事件量):
//!   - `include_kerberos_weak_tgs`:4769(`TicketEncryptionType` 為 `0x17` 或 `0x18`,排除 `$` 結尾與 `krbtgt` 服務)
//!   - `include_dcsync_4662`:4662(`Properties` 含三個複寫權限 GUID 之一,且 `SubjectUserName` 不以 `$` 結尾)
//!   - `include_gpo_change_5136`:5136(`ObjectClass = groupPolicyContainer` 或 `ObjectDN` 含 `CN=AdminSDHolder`)
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

/// AD-6 §9.2 新增、無額外條件的預設白名單(27 種;4616 與 4624 另附條件)
pub const AD6_DEFAULT_SECURITY_IDS: [u32; 27] = [
    4723, // 使用者自行變更密碼
    4697, // 安裝服務
    4698, 4699, 4700, 4701, 4702, // 排程工作 建立 / 刪除 / 啟用 / 停用 / 更新
    4719, // 系統稽核原則被變更
    1100, // 事件記錄服務被關閉
    1104, // Security Log 已滿
    4741, 4742, 4743, // 電腦帳號 建立 / 變更 / 刪除
    4765, 4766, // 新增 SID History 成功 / 失敗
    4780, // AdminSDHolder 套用到管理員帳號
    4735, 4737, 4755, // 安全群組變更(本機 / 全域 / 通用)
    4730, 4734, 4758, // 安全群組刪除(全域 / 本機 / 通用)
    4739, // 網域原則變更
    4713, // Kerberos 原則變更
    4706, 4707, 4716, // 信任關係 建立 / 移除 / 修改
];

/// AD-6 §9.3 4662 DCSync 複寫權限 GUID(不分大小寫比對 Properties)
pub const DCSYNC_GUIDS: [&str; 3] = [
    "1131f6aa-9c07-11d1-f79f-00c04fc2dcd2", // DS-Replication-Get-Changes
    "1131f6ad-9c07-11d1-f79f-00c04fc2dcd2", // DS-Replication-Get-Changes-All
    "89e95b76-444d-4c62-991a-0facbeda640c", // DS-Replication-Get-Changes-In-Filtered-Set
];

const SERVICE_NAMES: [&str; 3] = ["SYSTEM", "LOCAL SERVICE", "NETWORK SERVICE"];
/// SYSTEM、LOCAL SERVICE、NETWORK SERVICE、ANONYMOUS LOGON(名稱在非英文系統可能被翻譯,SID 不會)
const SERVICE_SIDS: [&str; 4] = ["S-1-5-18", "S-1-5-19", "S-1-5-20", "S-1-5-7"];

/// Security 通道的可選開關(預設全部關閉)
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FilterOptions {
    /// 4624 真人帳號登入(含類型 3 等全部類型;關閉時仍預設收類型 10 RDP)
    pub include_user_logon_4624: bool,
    /// 4769 Kerberos 弱加密 TGS(0x17 / 0x18,排除 `$` 結尾與 `krbtgt`)
    pub include_kerberos_weak_tgs: bool,
    /// 4662 DCSync 複寫權限(三個複寫 GUID 且非 `$` 電腦帳號)
    pub include_dcsync_4662: bool,
    /// 5136 GPO(`groupPolicyContainer`)或 `CN=AdminSDHolder` 變更
    pub include_gpo_change_5136: bool,
}

pub struct EventFilter {
    security: HashSet<u32>,
    opts: FilterOptions,
}

fn parse_num(s: Option<&str>) -> Option<u64> {
    let s = s?.trim();
    s.strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .map_or_else(
            || s.parse::<u64>().ok(),
            |h| u64::from_str_radix(h, 16).ok(),
        )
}

fn is_service_account(name: Option<&str>, sid: Option<&str>) -> bool {
    let name = name.unwrap_or("").trim();
    name.ends_with('$')
        || SERVICE_NAMES.iter().any(|s| s.eq_ignore_ascii_case(name))
        || name.eq_ignore_ascii_case("ANONYMOUS LOGON")
        || sid.is_some_and(|s| SERVICE_SIDS.contains(&s.trim()))
}

/// 4616 排除 W32Time 正常校時的 LOCAL SERVICE(S-1-5-19)
fn is_local_service(name: Option<&str>, sid: Option<&str>) -> bool {
    name.is_some_and(|n| n.trim().eq_ignore_ascii_case("LOCAL SERVICE"))
        || sid.is_some_and(|s| s.trim().eq_ignore_ascii_case("S-1-5-19"))
}

/// Status 欄位不是 0(缺欄位或無法解析時保守收下)
fn failed_status(e: &ParsedEvent) -> bool {
    let Some(s) = e.data("Status") else {
        return true;
    };
    parse_num(Some(s)) != Some(0)
}

fn is_weak_tgs_4769(e: &ParsedEvent) -> bool {
    if !matches!(parse_num(e.data("TicketEncryptionType")), Some(0x17 | 0x18)) {
        return false;
    }
    let svc = e.data("ServiceName").unwrap_or("").trim();
    if svc.ends_with('$') || svc.eq_ignore_ascii_case("krbtgt") {
        return false;
    }
    if svc.len() > 7 && svc.as_bytes()[..7].eq_ignore_ascii_case(b"krbtgt/") {
        return false;
    }
    true
}

fn is_dcsync_4662(e: &ParsedEvent) -> bool {
    let subj = e.data("SubjectUserName").unwrap_or("").trim();
    if subj.ends_with('$') {
        return false;
    }
    let Some(props) = e.data("Properties") else {
        return false;
    };
    let low = props.to_ascii_lowercase();
    DCSYNC_GUIDS.iter().any(|g| low.contains(g))
}

fn is_gpo_or_adminsdholder_5136(e: &ParsedEvent) -> bool {
    e.data("ObjectClass")
        .is_some_and(|c| c.trim().eq_ignore_ascii_case("groupPolicyContainer"))
        || e.data("ObjectDN")
            .is_some_and(|d| d.to_ascii_lowercase().contains("cn=adminsdholder"))
}

impl EventFilter {
    pub fn new(opts: FilterOptions) -> Self {
        let mut security: HashSet<u32> = V3_SECURITY_IDS.into_iter().collect();
        security.extend(AD6_DEFAULT_SECURITY_IDS);
        security.extend([4672, 4776, 4768, 4616, 4624]);
        if opts.include_kerberos_weak_tgs {
            security.insert(4769);
        }
        if opts.include_dcsync_4662 {
            security.insert(4662);
        }
        if opts.include_gpo_change_5136 {
            security.insert(5136);
        }
        Self { security, opts }
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
            4776 => failed_status(e),
            4768 => failed_status(e) || parse_num(e.data("TicketEncryptionType")) == Some(0x17),
            4616 => !is_local_service(e.data("SubjectUserName"), e.data("SubjectUserSid")),
            4624 => {
                !is_service_account(e.data("TargetUserName"), e.data("TargetUserSid"))
                    && (self.opts.include_user_logon_4624
                        || parse_num(e.data("LogonType")) == Some(10))
            }
            4769 => self.opts.include_kerberos_weak_tgs && is_weak_tgs_4769(e),
            4662 => self.opts.include_dcsync_4662 && is_dcsync_4662(e),
            5136 => self.opts.include_gpo_change_5136 && is_gpo_or_adminsdholder_5136(e),
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
    fn security白名單23種與ad6預設27種全收_不收清單拒絕() {
        let f = EventFilter::new(FilterOptions::default());
        for id in V3_SECURITY_IDS {
            assert!(f.accept(Channel::Security, &ev(id, &[])), "{id} 應收");
        }
        for id in AD6_DEFAULT_SECURITY_IDS {
            assert!(f.accept(Channel::Security, &ev(id, &[])), "AD-6 {id} 應收");
        }
        // §9.4 不收 + §9.3 預設關 + 4624 缺 LogonType
        for id in [
            4634, 4648, 4688, 5145, 4770, 4673, 4674, 4769, 4662, 5136, 4624,
        ] {
            assert!(!f.accept(Channel::Security, &ev(id, &[])), "{id} 不應收");
        }
    }

    #[test]
    fn 其他channel全收() {
        let f = EventFilter::new(FilterOptions::default());
        for id in [104, 7045, 41, 1074, 6006, 6008, 7036] {
            assert!(f.accept(Channel::System, &ev(id, &[])));
        }
        for id in [4000, 4004, 4015, 4013] {
            assert!(f.accept(Channel::DnsServer, &ev(id, &[])));
        }
        for id in [1864, 2042, 1645, 2887, 2889, 1388, 1988, 2092, 1644] {
            assert!(f.accept(Channel::DirectoryService, &ev(id, &[])));
        }
    }

    #[test]
    fn 事件4672排除電腦帳戶與服務帳號() {
        let f = EventFilter::new(FilterOptions::default());
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
    fn 事件4616排除local_service與s_1_5_19_其他帳號收() {
        let f = EventFilter::new(FilterOptions::default());
        let s = Channel::Security;
        assert!(!f.accept(
            s,
            &ev(
                4616,
                &[
                    ("SubjectUserName", "LOCAL SERVICE"),
                    ("SubjectUserSid", "S-1-5-19")
                ]
            )
        ));
        assert!(!f.accept(s, &ev(4616, &[("SubjectUserName", "local service")])));
        // 中文版 Windows 名稱被翻譯時以 SID 排除
        assert!(!f.accept(
            s,
            &ev(
                4616,
                &[
                    ("SubjectUserName", "本機服務"),
                    ("SubjectUserSid", "S-1-5-19")
                ]
            )
        ));
        // 一般管理員與 SYSTEM 變更時間都要收
        assert!(f.accept(
            s,
            &ev(
                4616,
                &[
                    ("SubjectUserName", "admin.chen"),
                    ("SubjectUserSid", "S-1-5-21-1-2-3-500")
                ]
            )
        ));
        assert!(f.accept(
            s,
            &ev(
                4616,
                &[
                    ("SubjectUserName", "SYSTEM"),
                    ("SubjectUserSid", "S-1-5-18")
                ]
            )
        ));
    }

    #[test]
    fn 事件4776只收失敗_4768收失敗或rc4_0x17_成功且aes不收() {
        let f = EventFilter::new(FilterOptions::default());
        let s = Channel::Security;
        // 4776(§9.4 4776 成功不收)
        assert!(!f.accept(s, &ev(4776, &[("Status", "0x0")])));
        assert!(f.accept(s, &ev(4776, &[("Status", "0xc000006a")])));
        // 4768 成功但無加密類型或 AES(0x11 / 0x12)不收
        assert!(!f.accept(s, &ev(4768, &[("Status", "0x0")])));
        assert!(!f.accept(
            s,
            &ev(4768, &[("Status", "0x0"), ("TicketEncryptionType", "0x12")])
        ));
        assert!(!f.accept(
            s,
            &ev(4768, &[("Status", "0x0"), ("TicketEncryptionType", "0x11")])
        ));
        // 4768 成功但 RC4(0x17)收(大小寫與十進位 23 皆可)
        assert!(f.accept(
            s,
            &ev(4768, &[("Status", "0x0"), ("TicketEncryptionType", "0x17")])
        ));
        assert!(f.accept(
            s,
            &ev(4768, &[("Status", "0x0"), ("TicketEncryptionType", "0X17")])
        ));
        assert!(f.accept(
            s,
            &ev(4768, &[("Status", "0x0"), ("TicketEncryptionType", "23")])
        ));
        // 前導零十六進位格式(審查 Low 4)
        assert!(f.accept(
            s,
            &ev(
                4768,
                &[("Status", "0x0"), ("TicketEncryptionType", "0x00000017")]
            )
        ));
        // 4768 失敗不論加密類型都收
        assert!(f.accept(
            s,
            &ev(
                4768,
                &[("Status", "0x18"), ("TicketEncryptionType", "0x12")]
            )
        ));
        assert!(f.accept(s, &ev(4768, &[])), "缺 Status 時保守收下");
    }

    #[test]
    fn 事件4624類型10預設收真人帳號_類型3由開關控制() {
        let off = EventFilter::new(FilterOptions::default());
        let on = EventFilter::new(FilterOptions {
            include_user_logon_4624: true,
            ..Default::default()
        });
        let s = Channel::Security;
        let rdp_user = ev(
            4624,
            &[
                ("TargetUserName", "alice"),
                ("TargetUserSid", "S-1-5-21-1-2-3-1201"),
                ("LogonType", "10"),
            ],
        );
        let net_user = ev(
            4624,
            &[
                ("TargetUserName", "alice"),
                ("TargetUserSid", "S-1-5-21-1-2-3-1201"),
                ("LogonType", "3"),
            ],
        );
        let no_type_user = ev(
            4624,
            &[
                ("TargetUserName", "alice"),
                ("TargetUserSid", "S-1-5-21-1-2-3-1201"),
            ],
        );
        // 類型 10(RDP)真人帳號:預設收
        assert!(off.accept(s, &rdp_user));
        assert!(on.accept(s, &rdp_user));
        // 類型 10 但電腦 / 服務帳號:不收
        assert!(!off.accept(
            s,
            &ev(4624, &[("TargetUserName", "WS-001$"), ("LogonType", "10")])
        ));
        assert!(!off.accept(
            s,
            &ev(
                4624,
                &[
                    ("TargetUserName", "SYSTEM"),
                    ("TargetUserSid", "S-1-5-18"),
                    ("LogonType", "10")
                ]
            )
        ));
        // 類型 3(網路)與其他類型:預設關、開啟才收真人
        assert!(!off.accept(s, &net_user));
        assert!(on.accept(s, &net_user));
        assert!(!off.accept(s, &no_type_user));
        assert!(on.accept(s, &no_type_user));
        // 開啟時仍排除機器帳號、匿名與 SYSTEM
        assert!(!on.accept(
            s,
            &ev(4624, &[("TargetUserName", "WS-001$"), ("LogonType", "3")])
        ));
        assert!(!on.accept(
            s,
            &ev(
                4624,
                &[
                    ("TargetUserName", "ANONYMOUS LOGON"),
                    ("TargetUserSid", "S-1-5-7"),
                    ("LogonType", "3")
                ]
            )
        ));
        assert!(!on.accept(
            s,
            &ev(
                4624,
                &[
                    ("TargetUserName", "SYSTEM"),
                    ("TargetUserSid", "S-1-5-18"),
                    ("LogonType", "3")
                ]
            )
        ));
    }

    #[test]
    fn 事件4769弱加密tgs開關與排除krbtgt及電腦服務() {
        let off = EventFilter::new(FilterOptions::default());
        let on = EventFilter::new(FilterOptions {
            include_kerberos_weak_tgs: true,
            ..Default::default()
        });
        let s = Channel::Security;
        let rc4 = ev(
            4769,
            &[
                ("ServiceName", "MSSQLSvc/sql01.gsmc.com.tw:1433"),
                ("TicketEncryptionType", "0x17"),
            ],
        );
        let rc4_exp = ev(
            4769,
            &[
                ("ServiceName", "HTTP/intranet"),
                ("TicketEncryptionType", "0x18"),
            ],
        );
        // 預設關:不收
        assert!(!off.accept(s, &rc4));
        // 開啟:0x17 與 0x18 收(含前導零 0x00000017;審查 Low 4)
        assert!(on.accept(s, &rc4));
        assert!(on.accept(s, &rc4_exp));
        assert!(on.accept(
            s,
            &ev(
                4769,
                &[
                    ("ServiceName", "MSSQLSvc/sql01"),
                    ("TicketEncryptionType", "0x00000017"),
                ]
            )
        ));
        // AES(0x11 / 0x12)與缺欄位:不收
        assert!(!on.accept(
            s,
            &ev(
                4769,
                &[
                    ("ServiceName", "MSSQLSvc/sql01"),
                    ("TicketEncryptionType", "0x12"),
                ]
            )
        ));
        assert!(!on.accept(s, &ev(4769, &[("ServiceName", "MSSQLSvc/sql01")])));
        // 排除 krbtgt(含大寫與 krbtgt/DOMAIN)
        assert!(!on.accept(
            s,
            &ev(
                4769,
                &[("ServiceName", "krbtgt"), ("TicketEncryptionType", "0x17")]
            )
        ));
        assert!(!on.accept(
            s,
            &ev(
                4769,
                &[("ServiceName", "KRBTGT"), ("TicketEncryptionType", "0x17")]
            )
        ));
        assert!(!on.accept(
            s,
            &ev(
                4769,
                &[
                    ("ServiceName", "krbtgt/GSMC.COM.TW"),
                    ("TicketEncryptionType", "0x17")
                ]
            )
        ));
        // 排除 $ 結尾的電腦服務
        assert!(!on.accept(
            s,
            &ev(
                4769,
                &[
                    ("ServiceName", "GSMC-DC1$"),
                    ("TicketEncryptionType", "0x17")
                ]
            )
        ));
    }

    #[test]
    fn 事件4662_dcsync開關與排除電腦帳號及非複寫guid() {
        let off = EventFilter::new(FilterOptions::default());
        let on = EventFilter::new(FilterOptions {
            include_dcsync_4662: true,
            ..Default::default()
        });
        let s = Channel::Security;
        for guid in DCSYNC_GUIDS {
            let props = format!("Control Access\n\t\t{{{}}}", guid.to_ascii_uppercase());
            let attack = ev(
                4662,
                &[("SubjectUserName", "alice"), ("Properties", &props)],
            );
            assert!(!off.accept(s, &attack), "預設關不應收 {guid}");
            assert!(on.accept(s, &attack), "開啟應收 {guid}");
        }
        // Windows 常見 %%{...} / %{...} 與大寫 GUID 格式(審查 Low 4)
        assert!(on.accept(
            s,
            &ev(
                4662,
                &[
                    ("SubjectUserName", "alice"),
                    (
                        "Properties",
                        "%%7688\n\t\t%{1131F6AD-9C07-11D1-F79F-00C04FC2DCD2}"
                    )
                ]
            )
        ));
        // DC$ 電腦帳號正常複寫:不收
        assert!(!on.accept(
            s,
            &ev(
                4662,
                &[
                    ("SubjectUserName", "GSMC-DC2$"),
                    ("Properties", "{1131f6aa-9c07-11d1-f79f-00c04fc2dcd2}")
                ]
            )
        ));
        // 非複寫 GUID 或缺 Properties:不收
        assert!(!on.accept(
            s,
            &ev(
                4662,
                &[
                    ("SubjectUserName", "alice"),
                    ("Properties", "{00000000-0000-0000-0000-000000000000}")
                ]
            )
        ));
        assert!(!on.accept(s, &ev(4662, &[("SubjectUserName", "alice")])));
    }

    #[test]
    fn 事件5136_gpo與adminsdholder開關與非gpo物件不收() {
        let off = EventFilter::new(FilterOptions::default());
        let on = EventFilter::new(FilterOptions {
            include_gpo_change_5136: true,
            ..Default::default()
        });
        let s = Channel::Security;
        let gpo = ev(
            5136,
            &[
                ("ObjectClass", "groupPolicyContainer"),
                (
                    "ObjectDN",
                    "CN={31B2F340-016D-11D2-945F-00C04FB984F9},CN=Policies,CN=System,DC=gsmc,DC=com,DC=tw",
                ),
            ],
        );
        let adminsd = ev(
            5136,
            &[
                ("ObjectClass", "container"),
                (
                    "ObjectDN",
                    "CN=AdminSDHolder,CN=System,DC=gsmc,DC=com,DC=tw",
                ),
            ],
        );
        let normal_user = ev(
            5136,
            &[
                ("ObjectClass", "user"),
                ("ObjectDN", "CN=alice,OU=Users,DC=gsmc,DC=com,DC=tw"),
            ],
        );
        // 預設關:不收
        assert!(!off.accept(s, &gpo));
        assert!(!off.accept(s, &adminsd));
        // 開啟:groupPolicyContainer 與 CN=AdminSDHolder(不分大小寫)都收
        assert!(on.accept(s, &gpo));
        assert!(on.accept(s, &adminsd));
        assert!(on.accept(
            s,
            &ev(
                5136,
                &[
                    ("ObjectClass", "GROUPPOLICYCONTAINER"),
                    ("ObjectDN", "CN=x")
                ]
            )
        ));
        assert!(on.accept(
            s,
            &ev(
                5136,
                &[
                    ("ObjectClass", "container"),
                    ("ObjectDN", "cn=adminsdholder,cn=system,dc=gsmc")
                ]
            )
        ));
        // 非 GPO / 非 AdminSDHolder 物件:不收
        assert!(!on.accept(s, &normal_user));
        assert!(!on.accept(s, &ev(5136, &[])));
    }
}
