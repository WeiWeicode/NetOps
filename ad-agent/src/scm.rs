//! Windows 服務控制(Watchdog 看守 Agent、Agent 反向看守 Watchdog;計畫 §3.2)。寫法參考 RustIt common/scm.rs。
//!
//! - 結束行程前先握住行程控制代碼、確認程式路徑是服務設定的執行檔、SCM 記錄的 PID 沒變,才 `TerminateProcess`
//! - `StartService` 回 `ERROR_SERVICE_ALREADY_RUNNING`(1056)回 [`StartOutcome::AlreadyRunning`](M4)

use crate::watchdog::{StartOutcome, StartType, SvcState};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use windows_service::service::{ServiceAccess, ServiceStartType, ServiceState};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::Services::{
    ChangeServiceConfigW, CloseServiceHandle, OpenSCManagerW, OpenServiceW, SC_MANAGER_CONNECT,
    SERVICE_AUTO_START, SERVICE_CHANGE_CONFIG, SERVICE_NO_CHANGE,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, QueryFullProcessImageNameW, TerminateProcess,
    WaitForSingleObject,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SHUTTINGDOWN};

const ERROR_SERVICE_DOES_NOT_EXIST: i32 = 1060;
const ERROR_SERVICE_ALREADY_RUNNING: i32 = 1056;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SvcInfo {
    pub state: SvcState,
    pub start_type: StartType,
    pub pid: Option<u32>,
    pub exe: Option<PathBuf>,
}

fn win32(e: &windows_service::Error) -> Option<i32> {
    match e {
        windows_service::Error::Winapi(io) => io.raw_os_error(),
        _ => None,
    }
}

fn open(
    name: &str,
    access: ServiceAccess,
) -> Result<Option<windows_service::service::Service>, String> {
    let m = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| format!("無法連到服務控制管理員:{e}"))?;
    match m.open_service(name, access) {
        Ok(s) => Ok(Some(s)),
        Err(e) if win32(&e) == Some(ERROR_SERVICE_DOES_NOT_EXIST) => Ok(None),
        Err(e) => Err(format!("無法開啟服務 {name}:{e}")),
    }
}

/// binary path(可能帶引號與參數)→ 程式路徑
pub fn exe_of(binary_path: &str) -> Option<PathBuf> {
    let s = binary_path.trim();
    let path = if let Some(rest) = s.strip_prefix('"') {
        rest.split('"').next()?
    } else {
        let lower = s.to_ascii_lowercase();
        match lower.find(".exe") {
            Some(i) => &s[..i + 4],
            None => s.split_whitespace().next()?,
        }
    };
    (!path.is_empty()).then(|| PathBuf::from(path))
}

pub fn query(name: &str) -> Result<SvcInfo, String> {
    let Some(svc) = open(
        name,
        ServiceAccess::QUERY_STATUS | ServiceAccess::QUERY_CONFIG,
    )?
    else {
        return Ok(SvcInfo {
            state: SvcState::Missing,
            start_type: StartType::Other,
            pid: None,
            exe: None,
        });
    };
    let st = svc
        .query_status()
        .map_err(|e| format!("無法查詢服務 {name} 狀態:{e}"))?;
    let state = match st.current_state {
        ServiceState::Running => SvcState::Running,
        ServiceState::Stopped => SvcState::Stopped,
        ServiceState::StartPending => SvcState::StartPending,
        ServiceState::StopPending => SvcState::StopPending,
        _ => SvcState::Paused,
    };
    let (start_type, exe) = match svc.query_config() {
        Ok(c) => (
            match c.start_type {
                ServiceStartType::AutoStart => StartType::Auto,
                ServiceStartType::OnDemand => StartType::Manual,
                ServiceStartType::Disabled => StartType::Disabled,
                _ => StartType::Other,
            },
            exe_of(&c.executable_path.to_string_lossy()),
        ),
        Err(_) => (StartType::Other, None),
    };
    Ok(SvcInfo {
        state,
        start_type,
        pid: st.process_id.filter(|p| *p != 0),
        exe,
    })
}

pub fn start(name: &str) -> StartOutcome {
    let svc = match open(name, ServiceAccess::START) {
        Ok(Some(s)) => s,
        Ok(None) => return StartOutcome::Failed(format!("服務 {name} 不存在")),
        Err(e) => return StartOutcome::Failed(e),
    };
    match svc.start::<&OsStr>(&[]) {
        Ok(()) => StartOutcome::Started,
        Err(e) if win32(&e) == Some(ERROR_SERVICE_ALREADY_RUNNING) => StartOutcome::AlreadyRunning,
        Err(e) => StartOutcome::Failed(format!("無法啟動服務 {name}:{e}")),
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 改回自動啟動(只改啟動類型)
pub fn set_auto_start(name: &str) -> Result<(), String> {
    let n = wide(name);
    // SAFETY:控制代碼都在本函式內關閉;字串以 NUL 結尾
    unsafe {
        let scm = OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT);
        if scm.is_null() {
            return Err(format!(
                "無法連到服務控制管理員:{}",
                std::io::Error::last_os_error()
            ));
        }
        let svc = OpenServiceW(scm, n.as_ptr(), SERVICE_CHANGE_CONFIG);
        if svc.is_null() {
            let e = std::io::Error::last_os_error();
            CloseServiceHandle(scm);
            return Err(format!("無法開啟服務 {name}:{e}"));
        }
        let ok = ChangeServiceConfigW(
            svc,
            SERVICE_NO_CHANGE,
            SERVICE_AUTO_START,
            SERVICE_NO_CHANGE,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
        );
        let e = std::io::Error::last_os_error();
        CloseServiceHandle(svc);
        CloseServiceHandle(scm);
        if ok == 0 {
            return Err(format!("無法改回自動啟動 {name}:{e}"));
        }
    }
    Ok(())
}

struct ProcessHandle(HANDLE);

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        // SAFETY:只關閉一次
        unsafe { CloseHandle(self.0) };
    }
}

fn image_of(h: HANDLE) -> Option<PathBuf> {
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    // SAFETY:緩衝區長度與 len 一致
    let ok =
        unsafe { QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) };
    (ok != 0).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy()
        .eq_ignore_ascii_case(&b.to_string_lossy())
}

/// 結束停止回應的 Agent:握住控制代碼 → 確認是服務的執行檔與 PID → TerminateProcess → 等行程結束(最多 15 秒)
pub fn terminate_service_process(name: &str, pid: u32) -> Result<(), String> {
    // SAFETY:控制代碼由 ProcessHandle 關閉;握住期間 PID 不會被重用
    let h = unsafe {
        OpenProcess(
            PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if h.is_null() {
        return Err(format!(
            "無法開啟行程 {pid}:{}",
            std::io::Error::last_os_error()
        ));
    }
    let h = ProcessHandle(h);
    let info = query(name)?;
    match (image_of(h.0), &info.exe) {
        (Some(img), Some(exe)) if same_path(&img, exe) => {}
        (img, exe) => {
            return Err(format!(
                "行程 {pid} 不是服務 {name} 的程式({img:?} ≠ {exe:?}),不處理"
            ));
        }
    }
    if info.pid != Some(pid) {
        return Err(format!("服務 {name} 的 PID 已變更,不結束行程 {pid}"));
    }
    // SAFETY:h 是握住的同一個行程
    if unsafe { TerminateProcess(h.0, 1) } == 0 {
        return Err(format!(
            "無法結束行程 {pid}:{}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY:同上
    if unsafe { WaitForSingleObject(h.0, 15_000) } != WAIT_OBJECT_0 {
        return Err(format!("行程 {pid} 結束逾時"));
    }
    Ok(())
}

/// 等服務出現新的執行中 PID(最多 timeout)
pub fn wait_running_pid(name: &str, not: Option<u32>, timeout: Duration) -> Option<u32> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(i) = query(name)
            && i.state == SvcState::Running
            && i.pid.is_some()
            && i.pid != not
        {
            return i.pid;
        }
        if Instant::now() > deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Windows 正在關機(關機時服務停止不算被人停止)
pub fn system_shutting_down() -> bool {
    // SAFETY:只讀系統計量
    unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) != 0 }
}

/// 本行程常駐記憶體(MB;心跳 rssMb)
pub fn rss_mb() -> f64 {
    let mut c = PROCESS_MEMORY_COUNTERS {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        ..Default::default()
    };
    // SAFETY:結構大小正確;GetCurrentProcess 是偽控制代碼,不用關閉
    if unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) } == 0 {
        return 0.0;
    }
    (c.WorkingSetSize as f64 / 1_048_576.0 * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 由binary_path取出執行檔() {
        assert_eq!(
            exe_of(
                r#""C:\Program Files\GigaNexus\NetOpsAdAgent\netops-ad-agent.exe" --mode agent --config "C:\x\agent.toml""#
            ),
            Some(PathBuf::from(
                r"C:\Program Files\GigaNexus\NetOpsAdAgent\netops-ad-agent.exe"
            ))
        );
        assert_eq!(
            exe_of(r"C:\a\b.exe --mode watchdog"),
            Some(PathBuf::from(r"C:\a\b.exe"))
        );
    }

    #[test]
    fn 查詢不存在的服務回missing_本機服務可查() {
        assert_eq!(
            query("NetOpsAdAgent-不存在").unwrap().state,
            SvcState::Missing
        );
        // EventLog 服務一定在執行
        let i = query("EventLog").unwrap();
        assert_eq!(i.state, SvcState::Running);
        assert!(i.pid.is_some());
        assert!(rss_mb() > 0.0);
    }
}
