//! 明文 HTTP 送到 netops-ad-receiver(D49 / H3;標頭 X-NetOps-Ad-Token)。
//!
//! - 逾時 10 秒(主迴圈卡在網路上最多 10 秒,遠小於 Watchdog 的 90 秒)
//! - 不跟隨轉址、不使用系統 Proxy:Token 只送到設定的那一台
//! - 錯誤訊息不含 Token(ureq 的錯誤不帶標頭;另以 [`mask`] 防禦)

use crate::agent::{HttpResult, Transport};
use serde_json::Value;
use std::time::Duration;

pub const TOKEN_HEADER: &str = "X-NetOps-Ad-Token";
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: u64 = 256 * 1024;

pub struct HttpTransport {
    agent: ureq::Agent,
    base: String,
    token: String,
}

impl HttpTransport {
    pub fn new(base: &str, token: &str) -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(TIMEOUT))
            .http_status_as_error(false)
            .max_redirects(0)
            .proxy(None)
            .user_agent(concat!("netops-ad-agent/", env!("CARGO_PKG_VERSION")))
            .build();
        Self {
            agent: config.into(),
            base: base.trim_end_matches('/').to_string(),
            token: token.to_string(),
        }
    }
}

impl Transport for HttpTransport {
    fn post(&mut self, path: &str, body: &Value) -> HttpResult {
        let url = format!("{}{}", self.base, path);
        match self
            .agent
            .post(&url)
            .header(TOKEN_HEADER, &self.token)
            .header("Content-Type", "application/json")
            // 先序列化再送(帶 Content-Length,不用 chunked;接收端 bodyLimit 依長度先擋)
            .send(serde_json::to_vec(body).unwrap_or_default())
        {
            Ok(mut resp) => {
                let code = resp.status().as_u16();
                let retry_after_sec = resp
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.trim().parse().ok());
                let body = resp
                    .body_mut()
                    .with_config()
                    .limit(MAX_RESPONSE_BYTES)
                    .read_json::<Value>()
                    .ok();
                HttpResult::Status {
                    code,
                    body,
                    retry_after_sec,
                }
            }
            Err(e) => HttpResult::Failed(mask(&e.to_string(), &self.token)),
        }
    }
}

/// 錯誤字串萬一帶到 Token 時遮掉;最多 300 字
pub fn mask(s: &str, token: &str) -> String {
    let s = if token.is_empty() {
        s.to_string()
    } else {
        s.replace(token, "***")
    };
    s.chars().take(300).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    const TOK: &str = "tok_0123456789abcdef0123456789abcdef";

    /// 一次性的假接收端:回傳指定的狀態與 JSON,並把收到的請求(標頭 + 內容)交回
    fn fake_server(
        status: &'static str,
        extra: &'static str,
        body: &'static str,
    ) -> (String, std::thread::JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://{}", l.local_addr().unwrap());
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut head = String::new();
            let mut len = 0usize;
            loop {
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
                head.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            let mut b = vec![0; len];
            r.read_exact(&mut b).unwrap();
            write!(
                s,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            head + &String::from_utf8(b).unwrap()
        });
        (addr, h)
    }

    #[test]
    fn 送出token標頭與json_讀回狀態與內容() {
        let (addr, h) = fake_server("200 OK", "", r#"{"accepted":1}"#);
        let mut t = HttpTransport::new(&addr, TOK);
        let r = t.post("/ad/v1/logs", &serde_json::json!({ "events": [] }));
        let req = h.join().unwrap();
        assert!(req.starts_with("POST /ad/v1/logs "));
        assert!(
            req.to_ascii_lowercase()
                .contains(&format!("x-netops-ad-token: {TOK}"))
        );
        assert!(req.ends_with(r#"{"events":[]}"#));
        assert_eq!(
            r,
            HttpResult::Status {
                code: 200,
                body: Some(serde_json::json!({ "accepted": 1 })),
                retry_after_sec: None
            }
        );
    }

    #[test]
    fn 回429時帶回retry_after_503當成一般狀態() {
        let (addr, h) = fake_server(
            "429 Too Many Requests",
            "Retry-After: 60\r\n",
            r#"{"code":"NETOPS_AD_RATE_LIMITED"}"#,
        );
        match HttpTransport::new(&addr, TOK).post("/ad/v1/logs", &serde_json::json!({})) {
            HttpResult::Status {
                code: 429,
                retry_after_sec: Some(60),
                ..
            } => {}
            r => panic!("{r:?}"),
        }
        h.join().unwrap();
        let (addr, h) = fake_server(
            "503 Service Unavailable",
            "",
            r#"{"code":"NETOPS_AD_UNAVAILABLE"}"#,
        );
        assert!(matches!(
            HttpTransport::new(&addr, TOK).post("/ad/v1/heartbeat", &serde_json::json!({})),
            HttpResult::Status { code: 503, .. }
        ));
        h.join().unwrap();
    }

    #[test]
    fn 連不上時回failed且不含token() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://{}", l.local_addr().unwrap());
        drop(l);
        match HttpTransport::new(&addr, TOK).post("/ad/v1/logs", &serde_json::json!({})) {
            HttpResult::Failed(e) => assert!(!e.contains(TOK)),
            r => panic!("{r:?}"),
        }
        assert_eq!(mask("x tok y", "tok"), "x *** y");
    }
}
