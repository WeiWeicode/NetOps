//! 收集的 Event Log Channel(AD5)。Windows 名稱有空白,送到接收端一律用底線(ad_events.channel)。

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
pub enum Channel {
    Security,
    System,
    DirectoryService,
    DnsServer,
}

impl Channel {
    pub const ALL: [Channel; 4] = [
        Channel::Security,
        Channel::System,
        Channel::DirectoryService,
        Channel::DnsServer,
    ];

    /// Windows Event Log 的 Channel 名稱(EvtQuery 用)
    pub fn log_name(self) -> &'static str {
        match self {
            Self::Security => "Security",
            Self::System => "System",
            Self::DirectoryService => "Directory Service",
            Self::DnsServer => "DNS Server",
        }
    }

    /// 送到接收端的名稱(payload.ts AD_CHANNELS)與 bookmarks.json 的鍵
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Security => "Security",
            Self::System => "System",
            Self::DirectoryService => "Directory_Service",
            Self::DnsServer => "DNS_Server",
        }
    }

    pub fn from_name(s: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|c| c.log_name().eq_ignore_ascii_case(s) || c.wire_name().eq_ignore_ascii_case(s))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 兩種寫法都認得() {
        assert_eq!(Channel::from_name("DNS Server"), Some(Channel::DnsServer));
        assert_eq!(
            Channel::from_name("directory_service"),
            Some(Channel::DirectoryService)
        );
        assert_eq!(Channel::from_name("Application"), None);
        assert_eq!(Channel::DirectoryService.wire_name(), "Directory_Service");
    }
}
