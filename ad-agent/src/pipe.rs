//! 本機具名管道 `\\.\pipe\netops-ad-agent-v1`(計畫 §3.2 看守細節 1、§7 第 2 點)。
//!
//! - 伺服端是 Agent:SDDL `D:P(A;;GA;;;SY)(A;;GA;;;BA)`(只有 SYSTEM 與 Administrators,不繼承)、拒絕遠端用戶端、
//!   `FILE_FLAG_FIRST_PIPE_INSTANCE`(別的行程先建立同名管道就失敗)。整個生命週期只建立一個執行個體並重複使用,
//!   不會有「名稱暫時沒人持有」的空窗
//! - 每條連線一則請求、一則回應(各一行 JSON,單則上限 [`MAX_LINE`]);只支援 `get_status`,不提供任何指令
//! - 用戶端是 Watchdog:以 `GetNamedPipeServerProcessId` 確認伺服端是 SCM 記錄的 Agent PID(防冒充),整體逾時 5 秒;
//!   逾時以 `CancelSynchronousIo` 取消卡住的讀寫

use crate::status::{SharedStatus, handle_pipe_request};
use crate::watchdog::Probe;
use std::os::windows::io::AsRawHandle;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE, GetLastError,
    HANDLE, INVALID_HANDLE_VALUE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FlushFileBuffers, OPEN_EXISTING,
    PIPE_ACCESS_DUPLEX, ReadFile, WriteFile,
};
use windows_sys::Win32::System::IO::CancelSynchronousIo;
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeServerProcessId,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};

pub use crate::PIPE_NAME;
/// 只允許 SYSTEM、Administrators;P = 不繼承上層 ACL
pub const PIPE_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;BA)";
/// 單則訊息上限(狀態含各 Channel 水位,約 1 KB)
pub const MAX_LINE: usize = 16 * 1024;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY:只關閉一次
        unsafe { CloseHandle(self.0) };
    }
}

/// 以 SDDL 建立的安全性描述元;Drop 時釋放
struct SecurityDescriptor(PSECURITY_DESCRIPTOR);

impl SecurityDescriptor {
    fn new(sddl: &str) -> Result<Self, String> {
        let w = wide(sddl);
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY:SDDL 以 NUL 結尾;sd 由 LocalFree 釋放
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                w.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(format!(
                "管道 ACL 格式錯誤:{}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self(sd))
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        // SAFETY:由 ConvertStringSecurityDescriptorToSecurityDescriptorW 配置
        unsafe { LocalFree(self.0) };
    }
}

fn create_server() -> Result<OwnedHandle, String> {
    let sd = SecurityDescriptor::new(PIPE_SDDL)?;
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    let name = wide(PIPE_NAME);
    // SAFETY:名稱以 NUL 結尾;sa / sd 活到呼叫結束(系統建立時複製描述元)
    let h = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            MAX_LINE as u32,
            MAX_LINE as u32,
            0,
            &sa,
        )
    };
    if h == INVALID_HANDLE_VALUE {
        return Err(format!(
            "無法建立本機管道 {PIPE_NAME}(可能已被其他行程佔用):{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(OwnedHandle(h))
}

fn read_line(h: HANDLE) -> Result<String, String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let mut n = 0u32;
        // SAFETY:chunk 長度與 nnumberofbytestoread 一致;同步 I/O
        let ok = unsafe {
            ReadFile(
                h,
                chunk.as_mut_ptr(),
                chunk.len() as u32,
                &mut n,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 || n == 0 {
            if buf.is_empty() {
                return Err(format!("讀取管道失敗:{}", std::io::Error::last_os_error()));
            }
            break;
        }
        buf.extend_from_slice(&chunk[..n as usize]);
        if let Some(i) = buf.iter().position(|b| *b == b'\n') {
            buf.truncate(i);
            break;
        }
        if buf.len() > MAX_LINE {
            return Err("管道訊息超過上限".into());
        }
    }
    String::from_utf8(buf).map_err(|_| "管道訊息不是 UTF-8".into())
}

fn write_line(h: HANDLE, text: &str) -> Result<(), String> {
    let mut bytes = text.as_bytes().to_vec();
    bytes.push(b'\n');
    let mut written = 0u32;
    // SAFETY:bytes 長度與 nnumberofbytestowrite 一致;同步 I/O
    let ok = unsafe {
        WriteFile(
            h,
            bytes.as_ptr(),
            bytes.len() as u32,
            &mut written,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 || written as usize != bytes.len() {
        return Err(format!("寫入管道失敗:{}", std::io::Error::last_os_error()));
    }
    // SAFETY:同一個控制代碼
    unsafe { FlushFileBuffers(h) };
    Ok(())
}

/// Agent 端:背景執行緒回應 `get_status`。建立失敗(名稱被佔用)時每 5 秒重試;Watchdog 會因管道無回應而重啟 Agent
pub fn spawn_server(status: Arc<SharedStatus>, version: &'static str) {
    std::thread::Builder::new()
        .name("pipe".into())
        .spawn(move || {
            let pid = std::process::id();
            let server = loop {
                match create_server() {
                    Ok(h) => break h,
                    Err(e) => {
                        log::error!("{e}");
                        status.update(|d| d.last_error = e.chars().take(300).collect());
                        std::thread::sleep(Duration::from_secs(5));
                    }
                }
            };
            log::info!("本機管道 {PIPE_NAME} 已建立");
            loop {
                // SAFETY:同步等待用戶端;ERROR_PIPE_CONNECTED = 用戶端已先連上
                let ok = unsafe { ConnectNamedPipe(server.0, std::ptr::null_mut()) };
                if ok != 0 || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED {
                    let reply = match read_line(server.0) {
                        Ok(line) => handle_pipe_request(&line, &status, pid, version).to_string(),
                        Err(e) => serde_json::json!({ "type": "error", "message": e }).to_string(),
                    };
                    let _ = write_line(server.0, &reply);
                }
                // SAFETY:同一個執行個體,斷線後重複使用
                unsafe { DisconnectNamedPipe(server.0) };
            }
        })
        .expect("無法建立管道執行緒");
}

fn request_blocking(expected_pid: u32) -> Result<Probe, String> {
    let name = wide(PIPE_NAME);
    let mut tries = 0;
    let client = loop {
        // SAFETY:名稱以 NUL 結尾
        let h = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if h != INVALID_HANDLE_VALUE {
            break OwnedHandle(h);
        }
        let e = unsafe { GetLastError() };
        if e == ERROR_PIPE_BUSY && tries < 20 {
            tries += 1;
            std::thread::sleep(Duration::from_millis(100));
            continue;
        }
        return Err(format!(
            "無法連線本機管道:{}",
            std::io::Error::from_raw_os_error(e as i32)
        ));
    };
    let mut server_pid = 0u32;
    // SAFETY:client 有效
    if unsafe { GetNamedPipeServerProcessId(client.0, &mut server_pid) } == 0 {
        return Err(format!(
            "無法取得管道伺服端 PID:{}",
            std::io::Error::last_os_error()
        ));
    }
    if server_pid != expected_pid {
        return Err(format!(
            "本機管道伺服端 PID {server_pid} 不是 Agent 服務({expected_pid}),疑似冒充,已中斷"
        ));
    }
    write_line(client.0, r#"{"type":"get_status"}"#)?;
    let line = read_line(client.0)?;
    parse_status(&line)
}

/// 管道回應 → Probe(純函式)
pub fn parse_status(line: &str) -> Result<Probe, String> {
    let v: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("管道回應格式錯誤:{e}"))?;
    if v.get("type").and_then(|t| t.as_str()) != Some("status") {
        return Err("管道回應不是 status".into());
    }
    Ok(Probe {
        pid: v.get("pid").and_then(|p| p.as_u64()).unwrap_or(0) as u32,
        last_collect_tick_ms: v
            .get("lastCollectTickMs")
            .and_then(|t| t.as_i64())
            .ok_or("管道回應缺少 lastCollectTickMs")?,
        tick_age_ms: v.get("tickAgeMs").and_then(|t| t.as_i64()),
    })
}

/// Watchdog 端:詢問 Agent 狀態,整體逾時 `timeout`(卡住時取消同步 I/O)
pub fn request_status(expected_pid: u32, timeout: Duration) -> Result<Probe, String> {
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::Builder::new()
        .name("pipe-client".into())
        .spawn(move || {
            let _ = tx.send(request_blocking(expected_pid));
        })
        .map_err(|e| format!("無法建立管道執行緒:{e}"))?;
    match rx.recv_timeout(timeout) {
        Ok(r) => {
            let _ = worker.join();
            r
        }
        Err(_) => {
            // SAFETY:worker 執行緒控制代碼在 JoinHandle 存在期間有效
            unsafe { CancelSynchronousIo(worker.as_raw_handle() as HANDLE) };
            let _ = rx.recv_timeout(Duration::from_secs(1));
            Err("本機管道逾時".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析狀態回應() {
        let p = parse_status(r#"{"type":"status","pid":4120,"lastCollectTickMs":1763616000000}"#)
            .unwrap();
        assert_eq!(
            p,
            Probe {
                pid: 4120,
                last_collect_tick_ms: 1_763_616_000_000,
                tick_age_ms: None
            }
        );
        let p = parse_status(
            r#"{"type":"status","pid":1,"lastCollectTickMs":5,"tickAgeMs":1200}"#,
        )
        .unwrap();
        assert_eq!(p.tick_age_ms, Some(1200));
        assert!(parse_status(r#"{"type":"error","message":"x"}"#).is_err());
        assert!(parse_status(r#"{"type":"status","pid":1}"#).is_err());
        assert!(parse_status("garbage").is_err());
    }

    #[test]
    fn 管道acl只允許system與administrators() {
        assert_eq!(PIPE_SDDL, "D:P(A;;GA;;;SY)(A;;GA;;;BA)");
        assert!(SecurityDescriptor::new(PIPE_SDDL).is_ok());
    }

    /// 真的建立管道、以本行程 PID 詢問狀態、PID 不符時拒絕(開發機與 CI 可執行;一般使用者以系統管理員身分才連得上)
    #[test]
    fn 管道往返與pid比對() {
        let status = Arc::new(SharedStatus::new(42));
        spawn_server(status.clone(), "0.1.0");
        let me = std::process::id();
        let mut last = Err(String::new());
        for _ in 0..30 {
            last = request_status(me, Duration::from_secs(5));
            if last.is_ok()
                || last.as_ref().is_err_and(|e| {
                    e.contains("拒絕存取")
                        || e.contains("Access is denied")
                        || e.contains("(os error 5)")
                })
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        match last {
            Ok(p) => {
                assert_eq!(p.pid, me);
                assert_eq!(p.last_collect_tick_ms, 42);
                assert!(p.tick_age_ms.is_some_and(|a| a >= 0));
                let e = request_status(me + 1, Duration::from_secs(5)).unwrap_err();
                assert!(e.contains("冒充"), "{e}");
            }
            // 非系統管理員執行測試:ACL 正確擋下(這本身就是預期行為)
            Err(e) => assert!(e.contains("os error 5"), "{e}"),
        }
    }
}
