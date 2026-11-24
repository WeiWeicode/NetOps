//! agent.toml 與 Token 檔(計畫 §3.1 config.rs、§7 第 1 點)。
//!
//! - Token 只從 `token_file` 讀(安裝腳本把檔案 ACL 限制為 SYSTEM / Administrators),不接受環境變數或命令列參數
//! - 缺少必要設定、Token 格式不對時啟動失敗(AGENT.md §6:不加預設值繞過檢查)
//! - `Debug` 不印 Token

use serde::Deserialize;
use std::path::{Path, PathBuf};

/// 預設的資料目錄(%ProgramData%\GigaNexus\NetOpsAdAgent)
pub const DEFAULT_DATA_DIR: &str = r"C:\ProgramData\GigaNexus\NetOpsAdAgent";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    server_url: String,
    computer: String,
    domain: String,
    token_file: PathBuf,
    state_dir: Option<PathBuf>,
    log_dir: Option<PathBuf>,
    #[serde(default = "d_lookback")]
    initial_lookback_minutes: u32,
    #[serde(default)]
    include_user_logon_4624: bool,
    #[serde(default = "d_batch_interval")]
    batch_interval_sec: u64,
    #[serde(default = "d_max_batch")]
    max_batch_events: usize,
    #[serde(default = "d_heartbeat")]
    heartbeat_interval_sec: u64,
    #[serde(default = "d_channels")]
    channels: Vec<String>,
}

fn d_lookback() -> u32 {
    60
}
fn d_batch_interval() -> u64 {
    4
}
fn d_max_batch() -> usize {
    500
}
fn d_heartbeat() -> u64 {
    15
}
fn d_channels() -> Vec<String> {
    crate::channel::Channel::ALL
        .iter()
        .map(|c| c.log_name().to_string())
        .collect()
}

/// 解析後的設定
#[derive(Clone)]
pub struct Config {
    /// 例:http://10.10.130.124:51295(結尾不含 /)
    pub server_url: String,
    pub computer: String,
    pub domain: String,
    pub token: String,
    pub state_dir: PathBuf,
    pub log_dir: PathBuf,
    /// 第一次啟動往回讀幾分鐘(M8,預設 60)
    pub initial_lookback_minutes: u32,
    /// 4624 真人帳號登入(AD5,預設關閉)
    pub include_user_logon_4624: bool,
    pub batch_interval_sec: u64,
    pub max_batch_events: usize,
    pub heartbeat_interval_sec: u64,
    pub channels: Vec<crate::channel::Channel>,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("server_url", &self.server_url)
            .field("computer", &self.computer)
            .field("domain", &self.domain)
            .field("token", &"***")
            .field("state_dir", &self.state_dir)
            .field("channels", &self.channels)
            .finish_non_exhaustive()
    }
}

/// Token 格式:與接收端相同([0-9A-Za-z_-],32–128 字;backend/src/ad-receiver/tokens.ts)
pub fn valid_token(t: &str) -> bool {
    (32..=128).contains(&t.len())
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_computer(c: &str) -> bool {
    !c.is_empty()
        && c.len() <= 63
        && c.as_bytes()[0].is_ascii_alphanumeric()
        && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn valid_domain(d: &str) -> bool {
    !d.is_empty()
        && d.len() <= 253
        && d.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

/// http://host:port(明文 HTTP,D49 / H3);不接受帳密、路徑、查詢字串,避免 Token 以外的機密出現在設定
fn normalize_url(u: &str) -> Result<String, String> {
    let u = u.trim().trim_end_matches('/');
    let rest = u
        .strip_prefix("http://")
        .ok_or("server_url 必須是 http://主機:埠(需求方決定明文 HTTP)")?;
    if rest.is_empty()
        || rest.contains(['@', '/', '?', '#', ' '])
        || !rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b':')
    {
        return Err("server_url 格式錯誤(只能是 http://主機:埠)".into());
    }
    Ok(u.to_string())
}

impl Config {
    pub fn parse(text: &str, base_dir: &Path) -> Result<Self, String> {
        let raw: RawConfig =
            toml::from_str(text).map_err(|e| format!("agent.toml 格式錯誤:{}", e.message()))?;
        let server_url = normalize_url(&raw.server_url)?;
        if !valid_computer(&raw.computer) {
            return Err("computer 格式錯誤(DC 主機名稱,不含網域)".into());
        }
        if !valid_domain(&raw.domain) {
            return Err("domain 格式錯誤".into());
        }
        if raw.initial_lookback_minutes > 7 * 24 * 60 {
            return Err("initial_lookback_minutes 最多 10080(7 天)".into());
        }
        if !(3..=5).contains(&raw.batch_interval_sec) {
            return Err("batch_interval_sec 必須是 3–5 秒(AD6)".into());
        }
        if !(1..=1000).contains(&raw.max_batch_events) {
            return Err("max_batch_events 必須是 1–1000(接收端一批上限 1,000 筆)".into());
        }
        if !(5..=60).contains(&raw.heartbeat_interval_sec) {
            return Err("heartbeat_interval_sec 必須是 5–60 秒".into());
        }
        let mut channels = Vec::new();
        for name in &raw.channels {
            let c = crate::channel::Channel::from_name(name)
                .ok_or_else(|| format!("channels 不支援:{name}"))?;
            if !channels.contains(&c) {
                channels.push(c);
            }
        }
        if channels.is_empty() {
            return Err("channels 不可為空".into());
        }
        let abs = |p: &Path| {
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                base_dir.join(p)
            }
        };
        let token_path = abs(&raw.token_file);
        let token = std::fs::read_to_string(&token_path)
            .map_err(|e| format!("讀不到 Token 檔 {}:{e}", token_path.display()))?
            .trim()
            .to_string();
        if !valid_token(&token) {
            return Err(format!(
                "Token 檔 {} 內容格式錯誤(32–128 個英數字、_ 或 -;內容不顯示)",
                token_path.display()
            ));
        }
        Ok(Self {
            server_url,
            computer: raw.computer,
            domain: raw.domain.to_ascii_lowercase(),
            token,
            state_dir: raw
                .state_dir
                .map(|p| abs(&p))
                .unwrap_or_else(|| base_dir.join("state")),
            log_dir: raw
                .log_dir
                .map(|p| abs(&p))
                .unwrap_or_else(|| base_dir.join("logs")),
            initial_lookback_minutes: raw.initial_lookback_minutes,
            include_user_logon_4624: raw.include_user_logon_4624,
            batch_interval_sec: raw.batch_interval_sec,
            max_batch_events: raw.max_batch_events,
            heartbeat_interval_sec: raw.heartbeat_interval_sec,
            channels,
        })
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("讀不到設定檔 {}:{e}", path.display()))?;
        let base = path.parent().unwrap_or(Path::new("."));
        Self::parse(&text, base)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn write_token(dir: &Path, t: &str) {
        std::fs::create_dir_all(dir.join("secrets")).unwrap();
        std::fs::write(dir.join("secrets/ad_agent.token"), t).unwrap();
    }

    fn base(extra: &str) -> String {
        format!(
            "server_url = \"http://10.10.130.124:51295/\"\ncomputer = \"GSMC-DC1\"\ndomain = \"GSMC.com.tw\"\ntoken_file = \"secrets/ad_agent.token\"\n{extra}"
        )
    }

    #[test]
    fn 預設值_4624關閉_回溯60分鐘_四個channel() {
        let d = tempfile::tempdir().unwrap();
        write_token(d.path(), &format!("{TOKEN}\r\n"));
        let c = Config::parse(&base(""), d.path()).unwrap();
        assert_eq!(c.server_url, "http://10.10.130.124:51295");
        assert_eq!(c.domain, "gsmc.com.tw");
        assert!(!c.include_user_logon_4624);
        assert_eq!(c.initial_lookback_minutes, 60);
        assert_eq!(c.channels.len(), 4);
        assert_eq!(c.token, TOKEN);
        assert!(!format!("{c:?}").contains(TOKEN), "Debug 不可印出 Token");
    }

    #[test]
    fn 拒絕空白或格式錯誤的token() {
        let d = tempfile::tempdir().unwrap();
        write_token(d.path(), "");
        let e = Config::parse(&base(""), d.path()).unwrap_err();
        assert!(e.contains("格式錯誤"));
        write_token(d.path(), "change-me");
        assert!(Config::parse(&base(""), d.path()).is_err());
        let d2 = tempfile::tempdir().unwrap();
        assert!(
            Config::parse(&base(""), d2.path())
                .unwrap_err()
                .contains("讀不到 Token")
        );
    }

    #[test]
    fn 只接受明文http_拒絕帳密與未知欄位() {
        let d = tempfile::tempdir().unwrap();
        write_token(d.path(), TOKEN);
        let t = base("").replace("http://10.10.130.124:51295/", "https://x:1");
        assert!(Config::parse(&t, d.path()).is_err());
        let t = base("").replace("http://10.10.130.124:51295/", "http://u:p@x:1");
        assert!(Config::parse(&t, d.path()).is_err());
        assert!(Config::parse(&base("token = \"x\"\n"), d.path()).is_err());
        assert!(Config::parse(&base("batch_interval_sec = 10\n"), d.path()).is_err());
        assert!(Config::parse(&base("channels = [\"Application\"]\n"), d.path()).is_err());
        let t = base("").replace("GSMC-DC1", "GSMC DC1");
        assert!(Config::parse(&t, d.path()).is_err());
    }
}
